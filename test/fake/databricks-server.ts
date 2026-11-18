/**
 * The fake Databricks workspace: a loopback HTTP server that answers the REST APIs package B's client speaks, and the
 * OAuth endpoints package A signs in against. Every other package meets it only through `test/fake/databricks.ts`.
 *
 * The shapes are Databricks' own, from the reference pages the design cites (§19): Statement Execution
 * (`POST /api/2.0/sql/statements`, `GET …/{id}`, `GET …/result/chunks/{n}`, `POST …/cancel`, and the `StatementResponse`
 * object: `statement_id`, `status.state`, `status.error`, `status.sql_state`, `manifest.schema.columns`
 * (`name`, `type_name`, `type_text`, `position`), `manifest.total_row_count`, `manifest.total_chunk_count`,
 * `manifest.truncated`, `result.data_array`, `result.external_links`, `result.chunk_index`, `result.next_chunk_index`);
 * Query History (`GET /api/2.0/sql/history/queries`: `res[]`, `query_id`, `status`, `statement_type`, `query_text`,
 * `query_start_time_ms`, `query_end_time_ms`, `duration`, `rows_produced`, `metrics.read_bytes`,
 * `metrics.result_from_cache`, `query_tags[]` as key/value objects, `next_page_token`); the warehouse object
 * (`state`, `warehouse_type`, `enable_serverless_compute`, `cluster_size`, `auto_stop_mins`, `min_num_clusters`,
 * `max_num_clusters`, `num_clusters`, `statement_timeout`); Unity Catalog `TableInfo` and `FunctionInfo`; Jobs
 * (`job_id`, `settings.name`, `run_id`, `state.life_cycle_state`, `state.result_state`, `idempotency_token`);
 * Workspace `objects[]` and Files `contents[]` (their fields are `src/ports.ts`'s; package D owns those endpoints'
 * tests); SCIM `Me`.
 *
 * Conventions this fake adds, because the interface's state is deliberately small:
 * - **Warehouses.** Two are seeded unless the test names its own: `wh-small` (serverless, Small, auto-stop 5, RUNNING)
 *   and `wh-stopped` (the same, STOPPED).
 * - **Statements.** `state.statements` is keyed by the exact statement text; an unknown text answers `SUCCEEDED` with no
 *   rows. A seeded `PENDING` or `RUNNING` answer is asynchronous: the submit answers that state with
 *   `on_wait_timeout: CONTINUE`, and each `GET` advances it (`PENDING → RUNNING → SUCCEEDED`, `RUNNING → SUCCEEDED`),
 *   so a poll has something to see. With `on_wait_timeout: CANCEL` the submit answers `CANCELED` at once — the server
 *   cancelling at the wait, as L8 checks. `row_limit` truncates and sets `truncated`.
 * - **Chunks.** An `INLINE` answer's rows are split into `manifest.totalChunkCount` (default 1) contiguous chunks; the
 *   submit answers chunk 0 and later chunks come from the chunk endpoint, in the documented top-level body (no `status`,
 *   no `statement_id`, no `manifest`). An `EXTERNAL_LINKS` answer's `links` are served one per chunk, chained by
 *   `chunkIndex`/`nextChunkIndex`. `state.chunks`, keyed `<statementId>:<chunkIndex>`, overrides any chunk with a body
 *   the test writes itself.
 * - **Links.** `state.links` is keyed by the last segment of the link's URL; `GET /results/<key>` serves its bytes, and a
 *   link whose `expiration` has passed answers 403. A test points links at `https://<bucket>.s3.amazonaws.com/<key>`
 *   (or the Azure/GCS form) and routes that host here in its own `fetch`; the client refuses any other host.
 * - **Query History.** Every executed statement appends a `FINISHED` (or `FAILED`/`CANCELED`) record carrying the
 *   request's `query_tags` and `query_text`, so the client's history recovery has something to find. A statement whose
 *   text, parameters, warehouse, catalog and schema were all seen before is recorded with `result_from_cache: true`.
 * - **Unity Catalog.** Catalogs and schemas are derived from the seeded tables and functions; `view_dependencies` is
 *   omitted from `tables/list` (as the API does) and present on `tables/get`. Effective permissions answer the
 *   identity with the read privileges.
 * - **Saved queries, volumes, workspace and Files.** Each comes from its `FakeState` map (`queries`, `volumes` by
 *   `<catalog>.<schema>`, `workspace` and `directories` by folder, `notebooks` by path). With a map empty the fake keeps
 *   its own defaults: no saved queries, no volumes, `/` → `/Shared` → one notebook, a one-line notebook for any path
 *   under `/Shared`, and empty Files listings.
 * - **Jobs.** `state.jobs` names them; without a seed a job is derived from its runs (`job_id`, name from the run);
 *   `runs/get` adds one task per run;
 *   `get-output` answers a fixed notebook result. `run-now` and `runs/submit` replay the same run for a repeated
 *   `idempotency_token`, and append a RUNNING run to `state.runs`.
 * - **OAuth.** `/oidc/v1/authorize` checks PKCE (S256), stores the code, and redirects to `redirect_uri` with the code
 *   and the caller's `state`; `/oidc/v1/token` exchanges it, and refreshes with rotation (a reused refresh token is
 *   `invalid_grant`).
 *
 * No real host, id, person or token appears here: the host is 127.0.0.1 and every name is an example.
 */
import { createHash, randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { ExternalLink, HistoryQuery, RunInfo, StatementAnswer, StatementState, TableInfo, Warehouse } from "../../src/ports.js"
import type { FakeBehaviour, FakeDatabricks, FakeRequest, FakeState, StartFake } from "./databricks.js"

/** The bearer token the fake accepts; any non-empty Bearer is treated as a sign-in. */
export const FAKE_ACCESS_TOKEN = "dose00000000000000000fake"

const MAX_BODY = 4 * 1024 * 1024
const DEFAULT_LINK_TTL_MS = 15 * 60 * 1000
/** Query History's page cap (the API's `max_results` is at most 1,000). */
const HISTORY_PAGE_MAX = 1000

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  const text = body === undefined ? "" : JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), ...headers })
  res.end(text)
}

const failure = (res: ServerResponse, status: number, errorCode: string, message: string, headers: Record<string, string> = {}) =>
  json(res, status, { error_code: errorCode, message }, headers)

const notFound = (res: ServerResponse, what: string) => failure(res, 404, "RESOURCE_DOES_NOT_EXIST", `${what} does not exist.`)

const text = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "")
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {})
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined)

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.byteLength
    if (size > MAX_BODY) break
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  if (text.trim() === "") return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * `behaviour.latencyMs` holds the *answer*, not the work: the route runs, records its history and stores the
 * statement, and only then does the response go out. That is what makes an aborted submit recoverable in a test.
 */
const withLatency = (res: ServerResponse, delayMs: number): ServerResponse => {
  if (delayMs <= 0) return res
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse
  const end = res.end.bind(res) as (...args: unknown[]) => ServerResponse
  let head: unknown[] | undefined
  res.writeHead = ((...args: unknown[]) => {
    head = args
    return res
  }) as typeof res.writeHead
  res.end = ((...args: unknown[]) => {
    const body = args
    setTimeout(() => {
      if (head) writeHead(...head)
      end(...body)
    }, delayMs)
    return res
  }) as typeof res.end
  return res
}

const defaultWarehouse = (id: string, state: Warehouse["state"], name: string): Warehouse => ({
  id,
  name,
  state,
  warehouseType: "PRO",
  serverless: true,
  clusterSize: "Small",
  autoStopMins: 5,
  minNumClusters: 1,
  maxNumClusters: 1,
})

/** One chunk of a result, as the chunk endpoint answers it. */
interface Chunk {
  readonly index: number
  readonly rows?: readonly (readonly (string | null)[])[]
  readonly link?: ExternalLink
  readonly next?: number
}

/** A statement the fake is holding: its id, the request that made it, and what it will answer. */
interface Held {
  readonly id: string
  readonly request: Record<string, unknown>
  /** The answer's state, rows and links; its `state` says what the statement is working towards. */
  readonly answer: StatementAnswer
  readonly chunks: readonly Chunk[]
  phase: number
}

const STATEMENT_STATES: readonly StatementState[] = ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED", "CLOSED"]

/** The chunks a seeded answer names: split rows, or its links, chained. */
function chunksOf(answer: StatementAnswer): Chunk[] {
  const links = answer.links ?? []
  if (links.length > 0) {
    return links.map((link, position) => {
      const next = link.nextChunkIndex ?? (position + 1 < links.length ? (links[position + 1]?.chunkIndex ?? position + 1) : undefined)
      return { index: link.chunkIndex, link, ...(next !== undefined ? { next } : {}) }
    })
  }
  const rows = answer.rows ?? []
  const total = Math.max(1, answer.manifest?.totalChunkCount ?? 1)
  if (total === 1) return [{ index: 0, rows }]
  const size = Math.ceil(rows.length / total)
  return Array.from({ length: total }, (_, index) => {
    const slice = rows.slice(index * size, (index + 1) * size)
    return { index, rows: slice, ...(index + 1 < total ? { next: index + 1 } : {}) }
  })
}

/**
 * A link as an answer carries it: the presigned URL's `expiration` is minted when the answer is written, from the
 * behaviour's `linkTtlMs`, so an expiry test moves real time rather than editing a seed (design §8.2 step 3).
 */
function linkWire(link: ExternalLink, ttlMs: number, minted: Map<string, number>): Record<string, unknown> {
  const key = link.url.split("/").filter(Boolean).pop() ?? ""
  const expires = Date.now() + ttlMs
  minted.set(key, expires)
  return {
    external_link: link.url,
    expiration: new Date(expires).toISOString(),
    chunk_index: link.chunkIndex,
    row_count: link.rowCount,
    byte_count: link.byteCount,
    row_offset: 0,
  }
}

/**
 * The chunk endpoint's answer (`GET …/result/chunks/{n}`): "identical to the nested `result` element" of a
 * `StatementResponse`, so its fields are top level — no `status`, no `statement_id`, no `manifest`.
 */
function chunkWire(held: Held, index: number, ttlMs: number, mintedExpiry: Map<string, number>): unknown {
  const chunk = held.chunks.find((entry) => entry.index === index)
  const next = chunk?.next
  const nextFields = next !== undefined ? { next_chunk_index: next, next_chunk_internal_link: `/api/2.0/sql/statements/${held.id}/result/chunks/${next}` } : {}
  if (chunk?.link) {
    return {
      external_links: [{ ...linkWire(chunk.link, ttlMs, mintedExpiry), ...nextFields }],
      chunk_index: chunk.index,
      row_count: chunk.link.rowCount,
      byte_count: chunk.link.byteCount,
      row_offset: 0,
      ...nextFields,
    }
  }
  return {
    data_array: chunk?.rows ?? [],
    chunk_index: chunk?.index ?? index,
    row_count: chunk?.rows?.length ?? 0,
    row_offset: 0,
    ...nextFields,
  }
}

/** The `StatementResponse` for one chunk of a held statement. */
function statementWire(held: Held, state: StatementState, chunkIndex = 0, ttlMs = DEFAULT_LINK_TTL_MS, mintedExpiry: Map<string, number> = new Map()): unknown {
  const chunk = held.chunks.find((entry) => entry.index === chunkIndex) ?? held.chunks[0]
  const columns = (held.answer.manifest?.columns ?? []).map((column) => ({
    name: column.name,
    position: column.position,
    ...(column.typeName ? { type_name: column.typeName } : {}),
    ...(column.typeText ? { type_text: column.typeText } : {}),
  }))
  const totalRowCount = held.answer.manifest?.totalRowCount ?? held.chunks.reduce((total, entry) => total + (entry.rows?.length ?? 0), 0)
  const next = chunk?.next
  return {
    statement_id: held.id,
    status: {
      state,
      ...(state === "FAILED" && held.answer.error
        ? {
            error: {
              ...(held.answer.error.errorCode ? { error_code: held.answer.error.errorCode } : {}),
              ...(held.answer.error.message ? { message: held.answer.error.message } : {}),
            },
            ...(held.answer.error.sqlState ? { sql_state: held.answer.error.sqlState } : {}),
          }
        : {}),
    },
    ...(state === "SUCCEEDED"
      ? {
          manifest: {
            format: text(held.request.format) || "JSON_ARRAY",
            schema: { column_count: columns.length, columns },
            total_chunk_count: held.chunks.length,
            total_row_count: totalRowCount,
            ...(held.answer.manifest?.truncated ? { truncated: true } : {}),
          },
          result: chunk?.link
            ? {
                external_links: [
                  {
                    ...linkWire(chunk.link, ttlMs, mintedExpiry),
                    ...(next !== undefined ? { next_chunk_index: next, next_chunk_internal_link: `/api/2.0/sql/statements/${held.id}/result/chunks/${next}` } : {}),
                  },
                ],
                chunk_index: chunk.index,
                row_count: chunk.link.rowCount,
                row_offset: 0,
                byte_count: chunk.link.byteCount,
                ...(next !== undefined ? { next_chunk_index: next, next_chunk_internal_link: `/api/2.0/sql/statements/${held.id}/result/chunks/${next}` } : {}),
              }
            : {
                data_array: chunk?.rows ?? [],
                chunk_index: chunk?.index ?? 0,
                row_count: chunk?.rows?.length ?? 0,
                row_offset: 0,
                ...(next !== undefined ? { next_chunk_index: next, next_chunk_internal_link: `/api/2.0/sql/statements/${held.id}/result/chunks/${next}` } : {}),
              },
        }
      : {}),
  }
}

/** The wire form of a warehouse object. */
const warehouseWire = (warehouse: Warehouse) => ({
  id: warehouse.id,
  name: warehouse.name,
  state: warehouse.state,
  warehouse_type: warehouse.warehouseType,
  enable_serverless_compute: warehouse.serverless,
  cluster_size: warehouse.clusterSize,
  auto_stop_mins: warehouse.autoStopMins,
  min_num_clusters: warehouse.minNumClusters,
  max_num_clusters: warehouse.maxNumClusters,
  ...(warehouse.numClusters !== undefined ? { num_clusters: warehouse.numClusters } : {}),
  ...(warehouse.statementTimeoutSeconds !== undefined ? { statement_timeout: warehouse.statementTimeoutSeconds } : {}),
})

const dependencyWire = (dependency: { kind: string; name: string }) =>
  dependency.kind === "table"
    ? { table: { table_full_name: dependency.name } }
    : dependency.kind === "function"
      ? { function: { function_full_name: dependency.name } }
      : dependency.kind === "connection"
        ? { connection: { connection_name: dependency.name } }
        : { credential: { credential_name: dependency.name } }

/** `TableInfo` as Unity Catalog sends it; the list omits `view_dependencies`, as the API documents. */
function tableWire(table: TableInfo, options: { readonly withDependencies: boolean }) {
  const parts = table.fullName.split(".")
  const [catalog = "", schema = "", name = table.fullName] = parts.length >= 3 ? [parts[0], parts[1], parts.slice(2).join(".")] : ["", "", table.fullName]
  return {
    name,
    catalog_name: catalog,
    schema_name: schema,
    full_name: table.fullName,
    table_type: table.tableType,
    ...(table.dataSourceFormat ? { data_source_format: table.dataSourceFormat } : {}),
    ...(table.comment ? { comment: table.comment } : {}),
    ...(table.owner ? { owner: table.owner } : {}),
    ...(table.updatedAt !== undefined ? { updated_at: table.updatedAt } : {}),
    columns: (table.columns ?? []).map((column, position) => ({
      name: column.name,
      type_text: column.typeText,
      type_name: column.typeText.split(/[\s(<]/u)[0]?.toUpperCase() ?? "",
      position,
      ...((table.partitionColumns ?? []).includes(column.name) ? { partition_index: (table.partitionColumns ?? []).indexOf(column.name) } : {}),
      nullable: column.nullable !== false,
      ...(column.comment ? { comment: column.comment } : {}),
      ...(column.mask ? { mask: { function_name: column.mask.functionName } } : {}),
    })),
    ...(table.rowFilter ? { row_filter: { function_name: table.rowFilter.functionName, input_column_names: [] } } : {}),
    ...(table.viewDefinition ? { view_definition: table.viewDefinition } : {}),
    ...(options.withDependencies && table.viewDependencies !== undefined
      ? { view_dependencies: { dependencies: table.viewDependencies.map(dependencyWire) } }
      : {}),
  }
}

/** `FunctionInfo` as Unity Catalog sends it. */
function functionWire(fn: { fullName: string; routineBody: string; externalLanguage?: string; routineDefinition?: string; routineDependencies?: readonly { kind: string; name: string }[]; sqlPath?: string; isTableFunction: boolean }) {
  const parts = fn.fullName.split(".")
  const [catalog = "", schema = "", name = fn.fullName] = parts.length >= 3 ? [parts[0], parts[1], parts.slice(2).join(".")] : ["", "", fn.fullName]
  return {
    name,
    catalog_name: catalog,
    schema_name: schema,
    full_name: fn.fullName,
    routine_body: fn.routineBody,
    data_type: fn.isTableFunction ? "TABLE_TYPE" : "STRING",
    ...(fn.isTableFunction ? { return_params: { parameters: [] } } : {}),
    ...(fn.externalLanguage ? { external_language: fn.externalLanguage } : {}),
    ...(fn.routineDefinition ? { routine_definition: fn.routineDefinition } : {}),
    ...(fn.sqlPath ? { sql_path: fn.sqlPath } : {}),
    ...(fn.routineDependencies !== undefined ? { routine_dependencies: { dependencies: fn.routineDependencies.map(dependencyWire) } } : {}),
  }
}

/** A query history record, in the API's `res[]` shape; `metrics` only when the request set `include_metrics`. */
function historyWire(query: HistoryQuery, withMetrics: boolean) {
  return {
    query_id: query.queryId,
    status: query.status,
    ...(query.statementType ? { statement_type: query.statementType } : {}),
    ...(query.warehouseId ? { warehouse_id: query.warehouseId } : {}),
    ...(query.userId !== undefined ? { user_id: query.userId } : {}),
    ...(query.executedAsUserId !== undefined ? { executed_as_user_id: query.executedAsUserId } : {}),
    query_start_time_ms: query.queryStartTimeMs,
    ...(query.queryEndTimeMs !== undefined ? { query_end_time_ms: query.queryEndTimeMs } : {}),
    ...(query.durationMs !== undefined ? { duration: query.durationMs } : {}),
    ...(query.rowsProduced !== undefined ? { rows_produced: query.rowsProduced } : {}),
    ...(withMetrics && (query.readBytes !== undefined || query.resultFromCache !== undefined)
      ? {
          metrics: {
            ...(query.readBytes !== undefined ? { read_bytes: query.readBytes } : {}),
            ...(query.resultFromCache !== undefined ? { result_from_cache: query.resultFromCache } : {}),
          },
        }
      : {}),
    ...(query.cacheQueryId ? { cache_query_id: query.cacheQueryId } : {}),
    ...(query.queryTags ? { query_tags: Object.entries(query.queryTags).map(([key, value]) => ({ key, value })) } : {}),
    ...(query.queryText ? { query_text: query.queryText } : {}),
    ...(query.isFinal !== undefined ? { is_final: query.isFinal } : {}),
  }
}

/** A run, in the Jobs API's shape. */
function runWire(run: RunInfo) {
  return {
    run_id: run.runId,
    ...(run.jobId !== undefined ? { job_id: run.jobId } : {}),
    ...(run.runName ? { run_name: run.runName } : {}),
    state: { life_cycle_state: run.state.lifeCycleState, ...(run.state.resultState ? { result_state: run.state.resultState } : {}) },
    start_time: run.startTime,
    ...(run.endTime !== undefined ? { end_time: run.endTime } : {}),
    ...(run.creatorUserName ? { creator_user_name: run.creatorUserName } : {}),
    ...(run.triggerType ? { trigger: run.triggerType } : {}),
    ...(run.runType ? { run_type: run.runType } : {}),
  }
}

const statementTypeOf = (statement: string): string => {
  const sql = statement.replace(/^\s*(?:\/\*[\s\S]*?\*\/|--[^\n]*\n|\s)+/u, "")
  const word = /^([A-Za-z]+)/u.exec(sql)?.[1]?.toUpperCase() ?? "OTHER"
  return word === "SELECT" || word === "WITH" || word === "EXPLAIN" || word === "SHOW" || word === "DESCRIBE" || word === "DESC" ? "SELECT" : word
}

/** The six-character PKCE check: `BASE64URL(SHA256(verifier))`, as RFC 7636 has it. */
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url")

/**
 * Starts the fake. It listens on a loopback port, so `origin` is `http://127.0.0.1:<port>`; nothing leaves the machine.
 */
export const startFakeDatabricks: StartFake = async (seed = {}) => {
  const state: FakeState = {
    identity: seed.identity ?? { id: "1000000000000001", userName: "user@example.com", displayName: "Example User" },
    warehouses: new Map(seed.warehouses ?? [
      ["wh-small", defaultWarehouse("wh-small", "RUNNING", "Shared small")],
      ["wh-stopped", defaultWarehouse("wh-stopped", "STOPPED", "Idle small")],
    ]),
    tables: new Map(seed.tables ?? []),
    functions: new Map(seed.functions ?? []),
    history: [...(seed.history ?? [])],
    runs: [...(seed.runs ?? [])],
    statements: new Map(seed.statements ?? []),
    links: new Map(seed.links ?? []),
    chunks: new Map(seed.chunks ?? []),
    queries: new Map(seed.queries ?? []),
    volumes: new Map(seed.volumes ?? []),
    workspace: new Map(seed.workspace ?? []),
    notebooks: new Map(seed.notebooks ?? []),
    directories: new Map(seed.directories ?? []),
    jobs: new Map(seed.jobs ?? []),
  }

  const behaviour: FakeBehaviour & { latencyMs?: number } = { linkTtlMs: DEFAULT_LINK_TTL_MS }
  /** The expiration of the link each key's last answer minted (design §8.2 step 3's expiry and re-read). */
  const mintedExpiry = new Map<string, number>()
  let rateLimitRemaining = 0
  let rateLimitRetryAfterSec = 1
  let failChunkOnce: number | undefined
  let dropSubmitAnswer = false
  let autoStartOnSubmit = false
  const requests: FakeRequest[] = []
  const cancelled: string[] = []
  const held = new Map<string, Held>()
  /** The result-cache identity of every statement the fake has run (design L5). */
  const cacheKeys = new Set<string>()
  let server: Server

  const requestOf = (method: string, url: URL, body: unknown, req: IncomingMessage): FakeRequest => {
    const query = Object.fromEntries([...url.searchParams.entries()])
    return {
      method,
      path: url.pathname,
      query,
      ...(body !== undefined ? { body } : {}),
      authorized: typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer "),
      ...(method === "POST" && url.pathname === "/api/2.0/sql/statements" ? { statement: text(record(body).statement) } : {}),
    }
  }

  /** Records a finished statement in Query History, so a recovery can find it (design §9). */
  const recordHistory = (input: { statementId: string; request: Record<string, unknown>; status: HistoryQuery["status"]; state: StatementState; rows: number; startedAt: number }) => {
    const params = JSON.stringify(input.request.parameters ?? [])
    const key = [text(input.request.statement), params, text(input.request.warehouse_id), text(input.request.catalog), text(input.request.schema)].join("\u0000")
    const cached = cacheKeys.has(key)
    cacheKeys.add(key)
    const tags = Object.fromEntries(
      list(input.request.query_tags)
        .map((tag) => record(tag))
        .filter((tag) => text(tag.key) !== "")
        .map((tag) => [text(tag.key), text(tag.value)]),
    )
    const finished = Date.now()
    state.history.push({
      queryId: input.statementId,
      status: input.status,
      statementType: statementTypeOf(text(input.request.statement)),
      warehouseId: text(input.request.warehouse_id),
      userId: 1,
      executedAsUserId: 1,
      queryStartTimeMs: input.startedAt,
      queryEndTimeMs: finished,
      durationMs: Math.max(1, finished - input.startedAt),
      rowsProduced: input.rows,
      queryTags: tags,
      queryText: text(input.request.statement),
      isFinal: true,
      resultFromCache: cached,
    })
  }

  /** Answers a chunk request from a held statement, or 404 past its last chunk. */
  const chunkAnswer = (res: ServerResponse, heldStatement: Held, index: number) => {
    // "After the statement execution has SUCCEEDED, this request can be used to fetch any chunk by index."
    if (heldStatement.answer.state !== "SUCCEEDED") return failure(res, 400, "BAD_REQUEST", "The statement has not succeeded, so it has no result chunk.")
    // A seeded chunk wins: a test writes exactly the documented top-level body it wants served.
    const seeded = state.chunks.get(`${heldStatement.id}:${index}`)
    if (seeded) {
      const ttl = behaviour.linkTtlMs ?? DEFAULT_LINK_TTL_MS
      const links = (seeded.links ?? []).map((link) => ({ ...linkWire(link, ttl, mintedExpiry), ...(link.nextChunkIndex !== undefined ? { next_chunk_index: link.nextChunkIndex } : {}) }))
      return json(res, 200, {
        chunk_index: seeded.chunkIndex,
        ...(seeded.rowCount !== undefined ? { row_count: seeded.rowCount } : {}),
        ...(seeded.rows !== undefined ? { data_array: seeded.rows, row_offset: 0 } : {}),
        ...(links.length > 0 ? { external_links: links } : {}),
        ...(seeded.nextChunkIndex !== undefined ? { next_chunk_index: seeded.nextChunkIndex, next_chunk_internal_link: `/api/2.0/sql/statements/${heldStatement.id}/result/chunks/${seeded.nextChunkIndex}` } : {}),
      })
    }
    if (!heldStatement.chunks.some((chunk) => chunk.index === index)) return notFound(res, `Chunk ${index}`)
    json(res, 200, chunkWire(heldStatement, index, behaviour.linkTtlMs ?? DEFAULT_LINK_TTL_MS, mintedExpiry))
  }

  /** Runs a submit: resolve the seed, apply the wait policy, store it, answer it. */
  const submit = async (res: ServerResponse, body: unknown) => {
    const request = record(body)
    const statement = text(request.statement)
    if (statement === "") return failure(res, 400, "BAD_REQUEST", "statement is required.")
    if (text(request.warehouse_id) === "") return failure(res, 400, "BAD_REQUEST", "warehouse_id is required.")
    if (text(request.warehouse_id) !== "" && !state.warehouses.has(text(request.warehouse_id))) return notFound(res, `Warehouse ${text(request.warehouse_id)}`)
    // A stopped warehouse "auto-starts" on submit (L8): the submit's own bill starts here.
    if (autoStartOnSubmit) {
      const warehouse = state.warehouses.get(text(request.warehouse_id))
      if (warehouse && warehouse.state === "STOPPED") state.warehouses.set(warehouse.id, { ...warehouse, state: "RUNNING" })
    }
    const seed = state.statements.get(statement)
    const seeded: StatementAnswer = typeof seed === "function" ? seed(statement) : seed ?? { statementId: "", state: "SUCCEEDED", manifest: { columns: [] } }
    const statementId = seeded.statementId || randomUUID()
    const rowLimit = count(request.row_limit)
    const rows = seeded.rows ?? []
    const limited = rowLimit !== undefined && rows.length > rowLimit ? rows.slice(0, rowLimit) : rows
    const truncated = rowLimit !== undefined && rows.length > rowLimit
    const answer: StatementAnswer = {
      ...seeded,
      statementId,
      manifest: seeded.manifest
        ? { ...seeded.manifest, ...(truncated ? { truncated: true } : {}) }
        : { columns: [], ...(truncated ? { truncated: true } : {}) },
      ...(rows.length > 0 ? { rows: limited } : {}),
    }
    const startedAt = Date.now()
    const desired = STATEMENT_STATES.includes(answer.state) ? answer.state : "SUCCEEDED"
    const waiting = desired === "PENDING" || desired === "RUNNING"
    const cancelAtWait = request.on_wait_timeout === "CANCEL"
    const answered: StatementState = waiting && cancelAtWait ? "CANCELED" : desired
    const stored: Held = { id: statementId, request, answer: { ...answer, state: answered }, chunks: chunksOf(answer), phase: 0 }
    held.set(statementId, stored)
    recordHistory({ statementId, request, status: answered === "CANCELED" ? "CANCELED" : answered === "FAILED" ? "FAILED" : "FINISHED", state: answered, rows: answer.rows?.length ?? 0, startedAt })
    if (dropSubmitAnswer) {
      dropSubmitAnswer = false
      res.socket?.destroy()
      return
    }
    json(res, 200, statementWire(stored, answered, 0, behaviour.linkTtlMs ?? DEFAULT_LINK_TTL_MS, mintedExpiry))
  }

  /** A `GET /statements/{id}`: advance a waiting statement one step, answer its chunk 0. */
  const getStatement = (res: ServerResponse, statementId: string) => {
    const stored = held.get(statementId)
    if (!stored) return notFound(res, `Statement ${statementId}`)
    const desired = stored.answer.state
    if (desired === "PENDING" || desired === "RUNNING") {
      stored.phase += 1
      if (desired === "PENDING" && stored.phase < 2) {
        json(res, 200, statementWire(stored, "RUNNING", 0, behaviour.linkTtlMs ?? DEFAULT_LINK_TTL_MS, mintedExpiry))
        return
      }
      const done: Held = { ...stored, answer: { ...stored.answer, state: "SUCCEEDED" }, chunks: chunksOf({ ...stored.answer, state: "SUCCEEDED" }) }
      held.set(statementId, done)
      json(res, 200, statementWire(done, "SUCCEEDED", 0, behaviour.linkTtlMs ?? DEFAULT_LINK_TTL_MS, mintedExpiry))
      return
    }
    json(res, 200, statementWire(stored, desired, 0, behaviour.linkTtlMs ?? DEFAULT_LINK_TTL_MS, mintedExpiry))
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const method = req.method ?? "GET"
    const body = method === "GET" || method === "HEAD" ? undefined : await bodyOf(req)
    requests.push(requestOf(method, url, body, req))
    if (rateLimitRemaining > 0) {
      rateLimitRemaining -= 1
      return failure(res, 429, "REQUEST_LIMIT_EXCEEDED", "Too many requests.", { "retry-after": String(rateLimitRetryAfterSec) })
    }
    const path = url.pathname
    const authorized = typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ")

    // The OAuth endpoints (package A): no workspace token; the code flow and refresh rotation.
    if (path === "/oidc/v1/authorize" && method === "GET") {
      const clientId = url.searchParams.get("client_id") ?? ""
      const redirectUri = url.searchParams.get("redirect_uri") ?? ""
      const challenge = url.searchParams.get("code_challenge") ?? ""
      const scope = url.searchParams.get("scope") ?? ""
      if (clientId === "") return json(res, 400, { error: "invalid_client", error_description: "client_id is required." })
      if (challenge === "" || url.searchParams.get("code_challenge_method") !== "S256") return failure(res, 400, "invalid_request", "PKCE with S256 is required.")
      if (scope.includes("unsupported-scope")) return json(res, 400, { error: "invalid_scope" })
      const code = randomUUID()
      codes.set(code, { challenge, redirectUri, clientId })
      const location = new URL(redirectUri === "" ? "http://127.0.0.1:8765/callback" : redirectUri)
      location.searchParams.set("code", code)
      const state = url.searchParams.get("state")
      if (state !== null) location.searchParams.set("state", state)
      res.writeHead(302, { location: location.href })
      return res.end()
    }
    if (path === "/oidc/v1/token" && method === "POST") {
      // A form body, not JSON: read it as text.
      const form = new URLSearchParams(typeof body === "string" ? body : "")
      const grant = form.get("grant_type") ?? ""
      if (grant === "authorization_code") {
        const code = form.get("code") ?? ""
        const stored = codes.get(code)
        codes.delete(code)
        if (!stored || stored.clientId !== (form.get("client_id") ?? "") || stored.redirectUri !== (form.get("redirect_uri") ?? "")) return json(res, 400, { error: "invalid_grant" })
        if (stored.challenge !== s256(form.get("code_verifier") ?? "")) return json(res, 400, { error: "invalid_grant" })
        refresh = `dose${randomUUID().replaceAll("-", "")}`
        return json(res, 200, { access_token: FAKE_ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: "sql unity-catalog query-history" })
      }
      if (grant === "refresh_token") {
        const token = form.get("refresh_token") ?? ""
        if (token === "" || token !== refresh) return json(res, 400, { error: "invalid_grant" })
        refresh = `dose${randomUUID().replaceAll("-", "")}`
        return json(res, 200, { access_token: FAKE_ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: "sql unity-catalog query-history" })
      }
      return json(res, 400, { error: "unsupported_grant_type" })
    }

    // An external result link: no workspace token, and bytes only (design §8.2 step 2).
    if (path.startsWith("/results/") && method === "GET") {
      const key = path.slice("/results/".length)
      const entry = state.links.get(key)
      if (!entry) return notFound(res, "The result link")
      // An answer's minted expiration governs; a link a test seeded without one is live until it says otherwise.
      const expires = mintedExpiry.get(key) ?? (entry.link.expiration ? Date.parse(entry.link.expiration) : undefined)
      if (expires !== undefined && Number.isFinite(expires) && expires <= Date.now()) return failure(res, 403, "LINK_EXPIRED", "The link has expired.")
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": entry.bytes.byteLength })
      return res.end(Buffer.from(entry.bytes))
    }

    // Links carry their own credential: an Authorization header here is the bug the test looks for.
    if (!authorized) return failure(res, 401, "UNAUTHENTICATED", "Request is missing a bearer token.")

    // SCIM Me.
    if (path === "/api/2.0/preview/scim/v2/Me" && method === "GET") {
      return json(res, 200, {
        id: state.identity.id,
        userName: state.identity.userName,
        ...(state.identity.displayName ? { displayName: state.identity.displayName } : {}),
        // SCIM's group shape: `value` is the id and `display` the name.
        groups: [{ value: "2000000000000001", display: "readers" }],
        active: true,
      })
    }

    // SQL warehouses.
    if (path === "/api/2.0/sql/warehouses" && method === "GET") {
      return json(res, 200, { warehouses: [...state.warehouses.values()].map(warehouseWire) })
    }
    const warehouseMatch = /^\/api\/2\.0\/sql\/warehouses\/([^/]+)$/u.exec(path)
    if (warehouseMatch && method === "GET") {
      const warehouse = state.warehouses.get(decodeURIComponent(warehouseMatch[1] ?? ""))
      return warehouse ? json(res, 200, warehouseWire(warehouse)) : notFound(res, "The warehouse")
    }
    const warehouseAction = /^\/api\/2\.0\/sql\/warehouses\/([^/]+)\/(start|stop)$/u.exec(path)
    if (warehouseAction && method === "POST") {
      const id = decodeURIComponent(warehouseAction[1] ?? "")
      const warehouse = state.warehouses.get(id)
      if (!warehouse) return notFound(res, "The warehouse")
      state.warehouses.set(id, { ...warehouse, state: warehouseAction[2] === "start" ? "RUNNING" : "STOPPED" })
      return json(res, 200, {})
    }

    // Statement Execution.
    if (path === "/api/2.0/sql/statements" && method === "POST") return submit(res, body)
    const statementMatch = /^\/api\/2\.0\/sql\/statements\/([^/]+)$/u.exec(path)
    if (statementMatch && method === "GET") return getStatement(res, decodeURIComponent(statementMatch[1] ?? ""))
    const cancelMatch = /^\/api\/2\.0\/sql\/statements\/([^/]+)\/cancel$/u.exec(path)
    if (cancelMatch && method === "POST") {
      const id = decodeURIComponent(cancelMatch[1] ?? "")
      cancelled.push(id)
      const stored = held.get(id)
      if (!stored) return notFound(res, `Statement ${id}`)
      held.set(id, { ...stored, answer: { ...stored.answer, state: "CANCELED" } })
      const last = state.history.find((entry) => entry.queryId === id)
      if (last) Object.assign(last, { status: "CANCELED" })
      return json(res, 200, {})
    }
    const chunkMatch = /^\/api\/2\.0\/sql\/statements\/([^/]+)\/result\/chunks\/(\d+)$/u.exec(path)
    if (chunkMatch && method === "GET") {
      const id = decodeURIComponent(chunkMatch[1] ?? "")
      const index = Number(chunkMatch[2])
      if (failChunkOnce !== undefined && failChunkOnce === index) {
        failChunkOnce = undefined
        return failure(res, 500, "INTERNAL_ERROR", "The chunk failed mid-stream.")
      }
      const stored = held.get(id)
      return stored ? chunkAnswer(res, stored, index) : notFound(res, `Statement ${id}`)
    }

    // Query History: filters in dot notation, newest first, `res[]` pages.
    if (path === "/api/2.0/sql/history/queries" && method === "GET") {
      const all = (key: string) => url.searchParams.getAll(key).flatMap((value) => value.split(",")).filter((value) => value !== "")
      const warehouses = all("filter_by.warehouse_ids")
      const statementIds = all("filter_by.statement_ids")
      const users = all("filter_by.user_ids").map(Number)
      const start = Number(url.searchParams.get("filter_by.query_start_time_range.start_time_ms") ?? Number.NaN)
      const end = Number(url.searchParams.get("filter_by.query_start_time_range.end_time_ms") ?? Number.NaN)
      const max = Math.min(Number(url.searchParams.get("max_results") ?? 100) || 100, HISTORY_PAGE_MAX)
      const filtered = state.history
        .filter((entry) => warehouses.length === 0 || (entry.warehouseId !== undefined && warehouses.includes(entry.warehouseId)))
        .filter((entry) => statementIds.length === 0 || statementIds.includes(entry.queryId))
        .filter((entry) => users.length === 0 || (entry.userId !== undefined && users.includes(entry.userId)))
        .filter((entry) => Number.isNaN(start) || entry.queryStartTimeMs >= start)
        .filter((entry) => Number.isNaN(end) || entry.queryStartTimeMs <= end)
        .sort((a, b) => b.queryStartTimeMs - a.queryStartTimeMs)
      const offset = Number(/^p:(\d+)$/u.exec(url.searchParams.get("page_token") ?? "")?.[1] ?? 0)
      const page = filtered.slice(offset, offset + max)
      const next = offset + max < filtered.length ? `p:${offset + max}` : undefined
      // `metrics` (read bytes, result_from_cache) comes only when the request asks for it, as the API has it.
      const withMetrics = url.searchParams.get("include_metrics") === "true"
      return json(res, 200, { res: page.map((entry) => historyWire(entry, withMetrics)), has_next_page: next !== undefined, ...(next ? { next_page_token: next } : {}) })
    }

    // Queries (saved). `state` seeds none: see the header's contract note.
    if (path === "/api/2.0/sql/queries" && method === "GET") {
      // Seeded saved queries, newest first, paged with the API's own token form.
      const all = [...state.queries.values()].sort((a, b) => a.name.localeCompare(b.name))
      const offset = Number(/^p:(\d+)$/u.exec(url.searchParams.get("page_token") ?? "")?.[1] ?? 0)
      const size = Math.min(Number(url.searchParams.get("page_size") ?? 20) || 20, 100)
      const page = all.slice(offset, offset + size)
      const next = offset + size < all.length ? `p:${offset + size}` : undefined
      return json(res, 200, {
        results: page.map((query) => ({
          id: query.id,
          display_name: query.name,
          ...(query.owner ? { owner_user_name: query.owner } : {}),
          ...(query.warehouseId ? { warehouse_id: query.warehouseId } : {}),
          query_text: query.queryText,
        })),
        ...(next ? { next_page_token: next } : {}),
      })
    }
    const savedQuery = /^\/api\/2\.0\/sql\/queries\/([^/]+)$/u.exec(path)
    if (savedQuery && method === "GET") {
      const query = state.queries.get(decodeURIComponent(savedQuery[1] ?? ""))
      return query ? json(res, 200, { id: query.id, display_name: query.name, ...(query.warehouseId ? { warehouse_id: query.warehouseId } : {}), query_text: query.queryText }) : notFound(res, "The query")
    }

    // Unity Catalog. Catalogs and schemas are derived from what the test seeded.
    const catalogs = new Map<string, string>()
    const schemas = new Map<string, Set<string>>()
    for (const table of state.tables.values()) {
      const parts = table.fullName.split(".")
      if (parts.length >= 3) {
        catalogs.set(parts[0] ?? "", parts[0] ?? "")
        const set = schemas.get(parts[0] ?? "") ?? new Set<string>()
        set.add(parts[1] ?? "")
        schemas.set(parts[0] ?? "", set)
      }
    }
    for (const fn of state.functions.values()) {
      const parts = fn.fullName.split(".")
      if (parts.length >= 3) {
        catalogs.set(parts[0] ?? "", parts[0] ?? "")
        const set = schemas.get(parts[0] ?? "") ?? new Set<string>()
        set.add(parts[1] ?? "")
        schemas.set(parts[0] ?? "", set)
      }
    }
    if (path === "/api/2.1/unity-catalog/catalogs" && method === "GET") {
      return json(res, 200, { catalogs: [...catalogs.keys()].map((name) => ({ name, owner: state.identity.userName })) })
    }
    if (path === "/api/2.1/unity-catalog/schemas" && method === "GET") {
      const catalog = url.searchParams.get("catalog_name") ?? ""
      if (!catalogs.has(catalog)) return notFound(res, `Catalog ${catalog}`)
      return json(res, 200, { schemas: [...(schemas.get(catalog) ?? [])].map((name) => ({ name, catalog_name: catalog, owner: state.identity.userName })) })
    }
    if (path === "/api/2.1/unity-catalog/tables" && method === "GET") {
      const catalog = url.searchParams.get("catalog_name") ?? ""
      const schema = url.searchParams.get("schema_name") ?? ""
      const tables = [...state.tables.values()].filter((table) => {
        const parts = table.fullName.split(".")
        return parts[0] === catalog && parts[1] === schema
      })
      return json(res, 200, { tables: tables.map((table) => tableWire(table, { withDependencies: false })) })
    }
    const tableMatch = /^\/api\/2\.1\/unity-catalog\/tables\/(.+)$/u.exec(path)
    if (tableMatch && method === "GET") {
      const table = state.tables.get(decodeURIComponent(tableMatch[1] ?? ""))
      return table ? json(res, 200, tableWire(table, { withDependencies: true })) : notFound(res, "The table")
    }
    if (path === "/api/2.1/unity-catalog/functions" && method === "GET") {
      const catalog = url.searchParams.get("catalog_name") ?? ""
      const schema = url.searchParams.get("schema_name") ?? ""
      const functions = [...state.functions.values()].filter((fn) => {
        const parts = fn.fullName.split(".")
        return parts[0] === catalog && parts[1] === schema
      })
      return json(res, 200, { functions: functions.map((fn) => ({ ...functionWire(fn), routine_definition: undefined })) })
    }
    const functionMatch = /^\/api\/2\.1\/unity-catalog\/functions\/(.+)$/u.exec(path)
    if (functionMatch && method === "GET") {
      const fn = state.functions.get(decodeURIComponent(functionMatch[1] ?? ""))
      return fn ? json(res, 200, functionWire(fn)) : notFound(res, "The function")
    }
    if (path === "/api/2.1/unity-catalog/volumes" && method === "GET") {
      const key = `${url.searchParams.get("catalog_name") ?? ""}.${url.searchParams.get("schema_name") ?? ""}`
      const volumes = state.volumes.get(key) ?? []
      return json(res, 200, { volumes: volumes.map((volume) => ({ name: volume.name, volume_type: volume.volumeType })) })
    }
    if (path === "/api/2.1/unity-catalog/connections" && method === "GET") {
      // Connections are not in FakeState (no package reads them yet): the empty page is the honest answer.
      return json(res, 200, { connections: [] })
    }
    if (path === "/api/2.1/unity-catalog/current-metastore-assignment" && method === "GET") {
      const first = [...state.tables.keys()].map((name) => name.split(".")[0]).find((catalog) => catalog !== undefined && catalog !== "")
      return json(res, 200, { ...(first ? { default_catalog_name: first } : {}), metastore_id: "00000000-0000-4000-8000-0000000000ff" })
    }
    if (path === "/api/2.1/unity-catalog/tag-assignments" && method === "GET") return json(res, 200, { tag_assignments: [] })
    if (/^\/api\/2\.1\/unity-catalog\/effective-permissions\/[^/]+\/.+$/u.test(path) && method === "GET") {
      return json(res, 200, {
        privilege_assignments: [{ principal: state.identity.userName, privileges: [{ privilege: "USE_CATALOG" }, { privilege: "USE_SCHEMA" }, { privilege: "SELECT" }, { privilege: "EXECUTE" }] }],
      })
    }

    // Jobs. Jobs come from the seeded runs; a run's task is derived from its state.
    if (path === "/api/2.2/jobs/list" && method === "GET") {
      // Seeded job names win; with none, a job is derived from its runs.
      const jobs = new Map<number, { name: string; creatorUserName?: string }>(state.jobs)
      for (const run of state.runs) if (run.jobId !== undefined && !jobs.has(run.jobId)) jobs.set(run.jobId, { name: run.runName ?? `Job ${run.jobId}` })
      return json(res, 200, { jobs: [...jobs.entries()].map(([jobId, job]) => ({ job_id: jobId, settings: { name: job.name }, creator_user_name: job.creatorUserName ?? state.identity.userName })), has_more: false })
    }
    if (path === "/api/2.2/jobs/runs/list" && method === "GET") {
      const jobParam = url.searchParams.get("job_id")
      const jobId = jobParam === null ? undefined : Number(jobParam)
      const completedOnly = url.searchParams.get("completed_only") === "true"
      const from = Number(url.searchParams.get("start_time_from") ?? Number.NaN)
      const to = Number(url.searchParams.get("start_time_to") ?? Number.NaN)
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 20) || 20, 25)
      const runs = state.runs
        .filter((run) => jobId === undefined || run.jobId === jobId)
        .filter((run) => !completedOnly || run.state.lifeCycleState === "TERMINATED")
        .filter((run) => Number.isNaN(from) || run.startTime >= from)
        .filter((run) => Number.isNaN(to) || run.startTime <= to)
        .sort((a, b) => b.startTime - a.startTime)
      const offset = Number(/^p:(\d+)$/u.exec(url.searchParams.get("page_token") ?? "")?.[1] ?? 0)
      const page = runs.slice(offset, offset + limit)
      const next = offset + limit < runs.length ? `p:${offset + limit}` : undefined
      return json(res, 200, { runs: page.map(runWire), has_more: next !== undefined, ...(next ? { next_page_token: next } : {}) })
    }
    if (path === "/api/2.2/jobs/runs/get" && method === "GET") {
      const run = state.runs.find((entry) => entry.runId === Number(url.searchParams.get("run_id")))
      if (!run) return notFound(res, "The run")
      return json(res, 200, {
        ...runWire(run),
        tasks: [{ task_key: "main", state: { life_cycle_state: run.state.lifeCycleState, ...(run.state.resultState ? { result_state: run.state.resultState } : {}) }, execution_duration: (run.endTime ?? run.startTime) - run.startTime }],
      })
    }
    if (path === "/api/2.2/jobs/runs/get-output" && method === "GET") {
      const run = state.runs.find((entry) => entry.runId === Number(url.searchParams.get("run_id")))
      if (!run) return notFound(res, "The run")
      return json(res, 200, { metadata: { run_id: run.runId }, notebook_output: { result: `Example output for run ${run.runId}.` } })
    }
    if ((path === "/api/2.2/jobs/run-now" || path === "/api/2.2/jobs/runs/submit") && method === "POST") {
      const request = record(body)
      const token = text(request.idempotency_token)
      if (path === "/api/2.2/jobs/run-now" && count(request.job_id) === undefined) return failure(res, 400, "BAD_REQUEST", "job_id is required.")
      const replay = token === "" ? undefined : replayed.get(token)
      if (replay !== undefined) return json(res, 200, { run_id: replay, number_in_job: replay })
      const runId = nextRunId++
      if (token !== "") replayed.set(token, runId)
      state.runs.push({
        runId,
        ...(count(request.job_id) !== undefined ? { jobId: count(request.job_id) } : {}),
        runName: text(request.run_name) || `run-${runId}`,
        state: { lifeCycleState: "RUNNING" },
        startTime: Date.now(),
        creatorUserName: state.identity.userName,
      })
      return json(res, 200, { run_id: runId, number_in_job: runId })
    }
    if (path === "/api/2.2/jobs/runs/cancel" && method === "POST") {
      const runId = count(record(body).run_id)
      const run = state.runs.find((entry) => entry.runId === runId)
      if (!run) return notFound(res, "The run")
      Object.assign(run, { state: { lifeCycleState: "TERMINATED", resultState: "CANCELED" }, endTime: Date.now() })
      return json(res, 200, {})
    }

    // Workspace and Files.
    if (path === "/api/2.0/workspace/list" && method === "GET") {
      const folder = url.searchParams.get("path") ?? ""
      const seeded = state.workspace.get(folder)
      if (seeded) return json(res, 200, { objects: seeded.map((object) => ({ path: object.path, object_type: object.objectType, ...(object.size !== undefined ? { object_size: object.size } : {}), ...(object.modifiedAt !== undefined ? { modified_at: object.modifiedAt } : {}) })) })
      // No seed: the fake keeps its own small tree, so package D has something to walk.
      if (folder === "/") return json(res, 200, { objects: [{ path: "/Shared", object_type: "DIRECTORY", object_id: 1 }] })
      if (folder === "/Shared") return json(res, 200, { objects: [{ path: "/Shared/example", object_type: "NOTEBOOK", object_id: 2, language: "PYTHON" }] })
      return notFound(res, `Workspace path ${folder}`)
    }
    if (path === "/api/2.0/workspace/export" && method === "GET") {
      const target = url.searchParams.get("path") ?? ""
      const source = state.notebooks.get(target) ?? (target.startsWith("/Shared/") ? `# Databricks notebook source\nprint("example")\n` : undefined)
      if (source === undefined) return notFound(res, `Workspace path ${target}`)
      return json(res, 200, { content: Buffer.from(source, "utf8").toString("base64"), file_type: "PY" })
    }
    if (path.startsWith("/api/2.0/fs/directories/") && method === "GET") {
      const folder = decodeURIComponent(path.slice("/api/2.0/fs/directories/".length))
      const entries = state.directories.get(folder) ?? state.directories.get(`/${folder}`) ?? []
      return json(res, 200, { contents: entries.map((entry) => ({ path: entry.path, is_directory: entry.isDirectory, ...(entry.size !== undefined ? { file_size: entry.size } : {}), ...(entry.modifiedAt !== undefined ? { last_modified: entry.modifiedAt } : {}) })) })
    }

    return notFound(res, `${method} ${path}`)
  }

  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>()
  let refresh = ""
  let nextRunId = 1_000_000
  const replayed = new Map<string, number>()

  server = createServer((req, res) => {
    const deferred = withLatency(res, behaviour.latencyMs ?? 0)
    handle(req, deferred).catch((error: unknown) => {
      if (deferred.headersSent) return deferred.end()
      failure(deferred, 500, "INTERNAL_ERROR", error instanceof Error ? error.message : "The fake failed.")
    })
  })
  server.keepAliveTimeout = 1_000
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    get origin() {
      return origin
    },
    get tokenEndpoint() {
      return `${origin}/oidc/v1/token`
    },
    get requests() {
      return requests
    },
    get cancelled() {
      return cancelled
    },
    state,
    behave(change: FakeBehaviour) {
      Object.assign(behaviour, change)
      if (change.rateLimit) {
        rateLimitRemaining = change.rateLimit.count
        rateLimitRetryAfterSec = change.rateLimit.retryAfterSec
      }
      if (change.failChunk !== undefined) failChunkOnce = change.failChunk
      if (change.dropSubmitAnswer !== undefined) dropSubmitAnswer = change.dropSubmitAnswer
      if (change.autoStartOnSubmit !== undefined) autoStartOnSubmit = change.autoStartOnSubmit
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
