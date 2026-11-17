/**
 * The statement client's shapes: the request body `POST /api/2.0/sql/statements` takes, the `StatementResponse` it and
 * the chunk endpoint answer, the Query History page an ambiguous submit is recovered from, and the poll of an
 * asynchronous statement.
 *
 * Everything here is a pure function over JSON. The transport, the retry rules and the submit policy are
 * `http.ts`'s; the chunk walk is `chunks.ts`'s. Wire names are Databricks'.
 *
 * References: Statement Execution `POST /api/2.0/sql/statements`, `GET /api/2.0/sql/statements/{statement_id}`,
 * `GET …/result/chunks/{chunk_index}`, and the `StatementResponse` object
 * (https://docs.databricks.com/api/statement-execution/v1/statement-execution, …/statement-execution/object);
 * Query History `GET /api/2.0/sql/history/queries` (https://docs.databricks.com/api/query-history/v1/list-queries).
 */
import { DatabricksError, type ProviderError } from "../domain/errors.js"
import type { ChunkAnswer, ExternalLink, HistoryQuery, ResultColumn, StatementAnswer, StatementState } from "../ports.js"

/** The plugin's own query tag, on every statement it runs (design §5.1 step 6). */
export const PLUGIN_TAG = { key: "oc_plugin", value: "databricks" } as const
/** The most query tags the API records; a longer list is coerced to 20 (Statement Execution `query_tags`). */
export const MAX_QUERY_TAGS = 20
/** The poll interval for an asynchronous statement: at most once a second (design §9). */
export const POLL_INTERVAL_MS = 1_000
/** The terminal states of a statement. */
export const TERMINAL_STATES: readonly StatementState[] = ["SUCCEEDED", "FAILED", "CANCELED", "CLOSED"]

const STATES: readonly StatementState[] = ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED", "CLOSED"]

/** A submit as the port carries it; restated so this module imports no transport. */
export interface StatementRequestShape {
  readonly statement: string
  readonly warehouseId: string
  readonly catalog?: string
  readonly schema?: string
  readonly parameters?: readonly { readonly name: string; readonly value: string | null; readonly type?: string }[]
  readonly rowLimit?: number
  readonly byteLimit?: number
  readonly disposition: "INLINE" | "EXTERNAL_LINKS"
  readonly format: "JSON_ARRAY" | "ARROW_STREAM"
  readonly waitTimeout: number
  readonly onWaitTimeout: "CANCEL" | "CONTINUE"
  readonly queryTags: Readonly<Record<string, string>>
}

/** A query tag key's documented limits: ≤ 128 characters, no `, : - / = .`, and `@@` is reserved. */
export const TAG_KEY = /^[^,:\-/=.]{1,128}$/u
/** A query tag value's documented limit. */
export const TAG_VALUE_MAX = 128

/** Whether a caller's tag may be sent: its key's characters and length, its value's length, no `@@` key, no control. */
export const validTag = (key: string, value: string): boolean =>
  TAG_KEY.test(key) && !key.startsWith("@@") && !/[\u0000-\u001f\u007f]/u.test(key) && value.length <= TAG_VALUE_MAX

/** `query_tags` as the API takes it: key/value objects, the plugin's tag first, at most 20, and only legal ones. */
export function queryTagList(tags: Readonly<Record<string, string>>): { key: string; value?: string }[] {
  const entries = new Map<string, string>()
  for (const [key, value] of Object.entries(tags)) {
    const name = key.trim()
    // A tag the API would reject is left out rather than sent for the server to drop: the plugin's own tags are legal.
    if (name === "" || name === PLUGIN_TAG.key || !validTag(name, value)) continue
    entries.set(name, value)
  }
  // The plugin's own tag is not a caller's to change: a plan or a query cannot make another plugin's statement look
  // like this one's, and every statement this plugin runs is attributable.
  // The plugin's tag always survives the cap: the caller's tags take the first 19 places, this one the last.
  const sent = [...entries.entries()].slice(0, MAX_QUERY_TAGS - 1)
  sent.push([PLUGIN_TAG.key, PLUGIN_TAG.value])
  return sent.map(([key, value]) => (value === "" ? { key } : { key, value }))
}

/**
 * `wait_timeout` as the API takes it: "can be set to 0 or to a value between 5 and 50" (Statement Execution). A caller's
 * 1–4 is rounded up to 5 (the shortest synchronous wait the server has), and anything longer is the caller's poll, not
 * the server's, so 50 is the ceiling.
 */
export function serverWaitSeconds(seconds: number): number {
  const whole = Math.trunc(seconds)
  if (!Number.isFinite(whole) || whole <= 0) return 0
  return whole < 5 ? 5 : Math.min(whole, 50)
}

/** The body of one submit, exactly the fields the design sets (design §5.1 step 6). */
export function statementBody(request: StatementRequestShape): Record<string, unknown> {
  return {
    statement: request.statement,
    warehouse_id: request.warehouseId,
    ...(request.catalog ? { catalog: request.catalog } : {}),
    ...(request.schema ? { schema: request.schema } : {}),
    ...(request.parameters?.length
      ? {
          parameters: request.parameters.map((parameter) => ({
            name: parameter.name,
            // `null` is SQL NULL: the API reads a parameter with no `value` as NULL.
            ...(parameter.value === null ? {} : { value: parameter.value }),
            ...(parameter.type ? { type: parameter.type } : {}),
          })),
        }
      : {}),
    ...(request.rowLimit !== undefined ? { row_limit: request.rowLimit } : {}),
    ...(request.byteLimit !== undefined ? { byte_limit: request.byteLimit } : {}),
    disposition: request.disposition,
    format: request.format,
    wait_timeout: `${serverWaitSeconds(request.waitTimeout)}s`,
    on_wait_timeout: request.onWaitTimeout,
    query_tags: queryTagList(request.queryTags),
  }
}

interface WireColumn {
  readonly name?: unknown
  readonly type_name?: unknown
  readonly type_text?: unknown
  readonly position?: unknown
}

interface WireLink {
  readonly external_link?: unknown
  readonly chunk_index?: unknown
  readonly expiration?: unknown
  readonly row_count?: unknown
  readonly byte_count?: unknown
  readonly next_chunk_index?: unknown
}

interface WireChunk {
  readonly external_links?: readonly WireLink[]
  readonly data_array?: unknown
  readonly chunk_index?: unknown
  readonly next_chunk_index?: unknown
  readonly row_count?: unknown
  readonly byte_count?: unknown
  readonly row_offset?: unknown
}

interface WireStatement {
  readonly statement_id?: unknown
  readonly status?: {
    readonly state?: unknown
    readonly error?: { readonly error_code?: unknown; readonly message?: unknown }
    readonly sql_state?: unknown
  }
  readonly manifest?: {
    readonly schema?: { readonly columns?: readonly WireColumn[] }
    readonly total_row_count?: unknown
    readonly total_chunk_count?: unknown
    readonly truncated?: unknown
  }
  readonly result?: {
    readonly data_array?: unknown
    readonly external_links?: readonly WireLink[]
    readonly chunk_index?: unknown
    readonly next_chunk_index?: unknown
  }
}

const text = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "")
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined)

/** One column of the manifest's schema. */
export function toColumn(column: WireColumn, index: number): ResultColumn {
  return {
    name: text(column.name),
    typeName: text(column.type_name),
    typeText: text(column.type_text),
    position: count(column.position) ?? index,
  }
}

/**
 * One `external_link`: its URL carries credentials and is never shown (design §5.8). The URL is a non-enumerable
 * property, and the link's JSON form leaves it out, so a result that is accidentally serialised or inspected cannot
 * leak it; the code that fetches reads `link.url` directly.
 */
export function toExternalLink(link: WireLink): ExternalLink | undefined {
  const url = text(link.external_link)
  if (url === "") return undefined
  const next = count(link.next_chunk_index)
  const visible = {
    chunkIndex: count(link.chunk_index) ?? 0,
    expiration: text(link.expiration),
    rowCount: count(link.row_count) ?? 0,
    byteCount: count(link.byte_count) ?? 0,
    ...(next !== undefined ? { nextChunkIndex: next } : {}),
  }
  const answer = { ...visible, url } as ExternalLink
  Object.defineProperty(answer, "url", { value: url, enumerable: false, writable: false, configurable: false })
  Object.defineProperty(answer, "toJSON", { value: () => visible, enumerable: false })
  return answer
}

/** The `StatementResponse`, in the port's terms. */
export function toStatementAnswer(body: unknown): StatementAnswer {
  const wire = (body ?? {}) as WireStatement
  const rawState = text(wire.status?.state).toUpperCase() as StatementState
  const state = STATES.includes(rawState) ? rawState : "PENDING"
  const error = wire.status?.error
  const providerError: ProviderError | undefined =
    error && (error.error_code !== undefined || error.message !== undefined)
      ? {
          ...(typeof error.error_code === "string" ? { errorCode: error.error_code } : {}),
          ...(typeof wire.status?.sql_state === "string" ? { sqlState: wire.status.sql_state } : {}),
          ...(typeof error.message === "string" ? { message: error.message } : {}),
          trust: "untrusted",
        }
      : undefined
  const columns = (wire.manifest?.schema?.columns ?? []).map((column, index) => toColumn(column, index))
  const rows = Array.isArray(wire.result?.data_array)
    ? (wire.result.data_array as unknown[]).map((row) => (Array.isArray(row) ? row.map((cell) => (cell === null ? null : text(cell))) : []))
    : undefined
  const links = (wire.result?.external_links ?? []).map(toExternalLink).filter((link): link is ExternalLink => link !== undefined)
  const next = count(wire.result?.next_chunk_index)
  const totalRows = count(wire.manifest?.total_row_count)
  const totalChunks = count(wire.manifest?.total_chunk_count)
  return {
    statementId: text(wire.statement_id),
    state,
    ...(providerError ? { error: providerError } : {}),
    ...(wire.manifest
      ? {
          manifest: {
            columns,
            ...(totalRows !== undefined ? { totalRowCount: totalRows } : {}),
            ...(totalChunks !== undefined ? { totalChunkCount: totalChunks } : {}),
            ...(wire.manifest.truncated === true ? { truncated: true } : {}),
          },
        }
      : {}),
    ...(rows !== undefined ? { rows } : {}),
    ...(links.length > 0 ? { links } : {}),
    ...(next !== undefined ? { nextChunkIndex: next } : {}),
  }
}

/**
 * A chunk endpoint's answer (`GET …/result/chunks/{chunk_index}`): "The response structure is identical to the nested
 * `result` element described in the `getStatement` request", so `data_array`, `external_links`, `container` fields,
 * `chunk_index` and `next_chunk_index` sit at the **top level** — not under `result`, and with no `status`, statement id
 * or manifest. The statement id is the one the caller asked for, and a chunk exists only after the statement
 * succeeded ("After the statement execution has SUCCEEDED, this request can be used to fetch any chunk by index").
 *
 * Reading this body as a `StatementResponse` silently loses every chunk after the first: its `result` is absent.
 */
export function toChunkAnswer(body: unknown): ChunkAnswer {
  const wire = (body ?? {}) as WireChunk
  const rows = Array.isArray(wire.data_array)
    ? (wire.data_array as unknown[]).map((row) => (Array.isArray(row) ? row.map((cell) => (cell === null ? null : text(cell))) : []))
    : undefined
  const links = (wire.external_links ?? []).map(toExternalLink).filter((link): link is ExternalLink => link !== undefined)
  // The link's own `next_chunk_index` is the documented place for an EXTERNAL_LINKS chunk; the object also names it at
  // the top level, so either is read.
  const next = count(wire.next_chunk_index) ?? links.find((link) => link.nextChunkIndex !== undefined)?.nextChunkIndex
  const rowCount = count(wire.row_count)
  return {
    chunkIndex: count(wire.chunk_index) ?? 0,
    ...(rowCount !== undefined ? { rowCount } : {}),
    ...(rows !== undefined ? { rows } : {}),
    ...(links.length > 0 ? { links } : {}),
    ...(next !== undefined ? { nextChunkIndex: next } : {}),
  }
}

/** Whether a statement has finished, whichever way. */
export const isTerminal = (state: StatementState): boolean => TERMINAL_STATES.includes(state)

/** A Query History page's `res[]` entry, in the port's terms (the API's `duration` is milliseconds, its tags objects). */
export function toHistoryQuery(item: unknown): HistoryQuery {
  const record = (item ?? {}) as Record<string, unknown>
  const metrics = (record.metrics ?? {}) as Record<string, unknown>
  const tags = Array.isArray(record.query_tags)
    ? Object.fromEntries(
        (record.query_tags as { key?: unknown; value?: unknown }[])
          .filter((tag) => typeof tag.key === "string" && tag.key !== "")
          .map((tag) => [tag.key as string, typeof tag.value === "string" ? tag.value : ""]),
      )
    : undefined
  return {
    queryId: text(record.query_id),
    status: historyStatus(record.status, record.is_final),
    ...(text(record.statement_type) ? { statementType: text(record.statement_type) } : {}),
    ...(text(record.warehouse_id) ? { warehouseId: text(record.warehouse_id) } : {}),
    ...(count(record.user_id) !== undefined ? { userId: count(record.user_id) } : {}),
    ...(count(record.executed_as_user_id) !== undefined ? { executedAsUserId: count(record.executed_as_user_id) } : {}),
    queryStartTimeMs: count(record.query_start_time_ms) ?? 0,
    ...(count(record.query_end_time_ms) !== undefined ? { queryEndTimeMs: count(record.query_end_time_ms) } : {}),
    ...(count(record.duration) !== undefined ? { durationMs: count(record.duration) } : {}),
    ...(count(record.rows_produced) !== undefined ? { rowsProduced: count(record.rows_produced) } : {}),
    ...(count(metrics.read_bytes) !== undefined ? { readBytes: count(metrics.read_bytes) } : {}),
    ...(tags && Object.keys(tags).length > 0 ? { queryTags: tags } : {}),
    ...(text(record.query_text) ? { queryText: text(record.query_text) } : {}),
    ...(record.is_final === true || record.is_final === false ? { isFinal: record.is_final } : {}),
    ...(metrics.result_from_cache === true || metrics.result_from_cache === false ? { resultFromCache: metrics.result_from_cache } : {}),
    ...(text(record.cache_query_id) ? { cacheQueryId: text(record.cache_query_id) } : {}),
  }
}

/**
 * A Query History `status`, as the port's five. The API's values are QUEUED, STARTED, COMPILING, COMPILED, RUNNING,
 * CANCELED, FAILED and FINISHED: the compiling and started states are still running, and an unknown value is treated as
 * running too (the safe reading for a cleanup that asks "is anything running?"), never as finished. A FINISHED record
 * that says `is_final: false` is still running.
 */
export function historyStatus(raw: unknown, isFinal: unknown): HistoryQuery["status"] {
  switch (text(raw).toUpperCase()) {
    case "QUEUED":
      return "QUEUED"
    case "FAILED":
      return "FAILED"
    case "CANCELED":
      return "CANCELED"
    case "FINISHED":
      return isFinal === false ? "RUNNING" : "FINISHED"
    default:
      return "RUNNING"
  }
}

/** What polling needs, so this module depends on no transport. */
export interface StatementSource {
  getStatement(account: string, statementId: string, signal: AbortSignal): Promise<StatementAnswer>
  cancelStatement(account: string, statementId: string, signal: AbortSignal): Promise<void>
}

export interface PollOptions {
  readonly account: string
  readonly statementId: string
  /** The caller's signal: when it aborts, the statement this call started is cancelled (design §9). */
  readonly signal: AbortSignal
  /** Wall-clock deadline: the call answers `RUNNING` with a `next` when it passes. */
  readonly untilMs: number
  readonly now?: () => number
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  readonly intervalMs?: number
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DatabricksError("CANCELLED"))
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop)
      resolve()
    }, ms)
    const stop = () => {
      clearTimeout(timer)
      reject(new DatabricksError("CANCELLED"))
    }
    signal.addEventListener("abort", stop, { once: true })
  })

/**
 * Polls `GET /api/2.0/sql/statements/{id}` at most once a second until the statement is terminal or the deadline
 * passes. A stop cancels the statement with `POST …/cancel` before it reports `CANCELLED`, so a stopped call leaves
 * nothing running (design §9, §7 layer 2a).
 */
export async function pollUntilDone(source: StatementSource, options: PollOptions): Promise<StatementAnswer> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const interval = options.intervalMs ?? POLL_INTERVAL_MS
  let last: StatementAnswer | undefined
  for (;;) {
    if (now() > options.untilMs && last) return last
    try {
      last = await source.getStatement(options.account, options.statementId, options.signal)
    } catch (error) {
      if (error instanceof DatabricksError && error.code === "CANCELLED") throw await stopping(source, options, error)
      throw error
    }
    if (isTerminal(last.state)) return last
    if (now() >= options.untilMs) return last
    try {
      await sleep(interval, options.signal)
    } catch (error) {
      if (error instanceof DatabricksError && error.code === "CANCELLED") throw await stopping(source, options, error)
      throw error
    }
  }
}

/**
 * The poll stopped: cancel the statement, and say so when Databricks did not confirm it. A read is bounded by
 * `on_wait_timeout: CANCEL` on the server anyway; a silently un-cancelled statement would be reported as ended.
 */
async function stopping(source: StatementSource, options: PollOptions, stopped: DatabricksError): Promise<DatabricksError> {
  const confirmed = await source.cancelStatement(options.account, options.statementId, AbortSignal.timeout(10_000)).then(
    () => true,
    () => false,
  )
  if (confirmed) return stopped
  return new DatabricksError("CANCELLED", "The call was stopped, but Databricks did not confirm the cancel, so the statement may still be running.", "Check databricks_history; databricks_cancel can end it.")
}
