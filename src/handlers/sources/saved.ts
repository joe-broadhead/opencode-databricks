/**
 * `databricks.saved`, the snapshot source (design §11.3), and its `scope.suggest` (`saved_list`):
 *
 * - `saved_read` takes the bound saved query's id and SQL hash, refuses a query whose text changed (`INPUT_INVALID`, "the
 *   saved query changed since you chose it"), runs the full read path on the query's warehouse, and **only if that
 *   warehouse is already RUNNING** (`UNAVAILABLE`, "the warehouse is stopped, and this source never starts one"): this
 *   source never starts a warehouse, so it never bills for a start;
 * - it shapes the answer into the registry's `table` — at most 8 columns and 100 rows, cells cut at 200 characters —
 *   and a larger result is `TOO_LARGE`, never silently truncated;
 * - `saved_list` is the bind-time suggestion: the account's saved queries as `id#sha256` options, so the id a person
 *   confirms carries the exact SQL text it was chosen as.
 *
 * The contract's register asks each method's declared operations before it runs; the read path and the warehouse policy
 * are the same ones every other read uses.
 */
import { createHash } from "node:crypto"
import { sourceError, sourceErrorOf } from "./errors.js"
import { typedCell } from "../save/inline.js"
import { chargeStatement } from "../../provider/guards/budget.js"
import { sizeOf } from "../../provider/guards/warehouse.js"
import { DatabricksError } from "../../domain/errors.js"
import type { StatementAnswer } from "../../ports.js"
import type { Deps } from "../deps.js"
import type { Call } from "../types.js"

/** The registry's `table` output: named columns and rows of typed cells. */
export interface TableData {
  readonly columns: readonly { readonly key: string; readonly label: string }[]
  readonly rows: readonly Record<string, string | number | boolean | null>[]
}

export interface SnapshotAnswer {
  readonly data: TableData
  readonly asOf: string
  /** This read's own cost: the warehouse it ran on and its estimated $/hour. The source never starts one. */
  readonly cost: { readonly units: readonly { readonly per: string; readonly count: number }[] }
  readonly trust: "untrusted"
}

const MAX_COLUMNS = 8
const MAX_ROWS = 100
const CELL = 200

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

/** One cell as the registry's table takes it: strings cut at 200 characters, nested values as JSON text. */
function cell(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value === "boolean" || typeof value === "number") return value
  if (typeof value === "string") return value.length > CELL ? `${value.slice(0, CELL - 1)}…` : value
  const text = JSON.stringify(value)
  return text.length > CELL ? `${text.slice(0, CELL - 1)}…` : text
}

export interface SavedInput {
  readonly account: string
  readonly query?: string
  readonly sha?: string
  /** The confirmed scope: `queries` holds the selected saved-query id, optionally `id#sha`. */
  readonly scope?: Readonly<Record<string, readonly string[]>>
}

/** `saved_read`: the snapshot, after the read path, on a warehouse that is already running. */
export async function savedRead(deps: Deps, input: SavedInput, call: Call): Promise<SnapshotAnswer> {
  const selected = input.query ?? input.scope?.["queries"]?.[0]
  if (typeof selected !== "string" || selected.length === 0 || selected.length > 200) {
    throw sourceError("INPUT_INVALID", "No saved query was chosen.", "Bind one of the queries saved_list offers, then read it.")
  }
  const [queryId, boundSha] = selected.split("#", 2)
  if (queryId === undefined || queryId.length === 0) throw sourceError("INPUT_INVALID", "No saved query was chosen.", "Bind one of the queries saved_list offers, then read it.")
  const wantedSha = input.sha ?? boundSha
  if (wantedSha !== undefined && !/^[0-9a-f]{64}$/u.test(wantedSha)) {
    throw sourceError("INPUT_INVALID", "The saved query's sha256 is not a sha256.", "Choose the query again from saved_list.")
  }
  let query
  try {
    query = await deps.databricks.getQuery(input.account, queryId!, call.signal)
  } catch (error) {
    throw sourceErrorOf(error)
  }
  if (wantedSha !== undefined && sha256(query.queryText) !== wantedSha) {
    throw sourceError("INPUT_INVALID", "The saved query changed since you chose it.", "Choose the query again in the source's binding, and read it with its new sha256.")
  }
  if (query.warehouseId === undefined || query.warehouseId.length === 0) {
    throw sourceError("UNAVAILABLE", "The saved query names no warehouse, so this source cannot read it without starting one.", "Give the saved query a warehouse in the SQL editor, then bind it again.")
  }
  let warehouse
  try {
    warehouse = await deps.databricks.getWarehouse(input.account, query.warehouseId, call.signal)
  } catch (error) {
    throw sourceErrorOf(error)
  }
  if (warehouse.state !== "RUNNING") {
    throw sourceError("UNAVAILABLE", `The saved query's warehouse is ${warehouse.state.toLowerCase()}, and this source never starts one.`, "Start the warehouse in Databricks and read again; a start here would bill without the person asking.")
  }
  let prepared: Awaited<ReturnType<Deps["reads"]["prepare"]>>
  try {
    prepared = await deps.reads.prepare(
      {
        account: input.account,
        sql: query.queryText,
        warehouse: query.warehouseId,
        runningOnly: true,
        tool: "saved_read",
        sessionID: call.sessionID,
        messageID: call.messageID,
        callID: call.id,
      },
      call.signal,
    )
  } catch (error) {
    // The read path's refusals (a missing sign-in, a fence, a policy) are the source contract's, not this plugin's.
    throw sourceErrorOf(error)
  }
  let answer: StatementAnswer
  const startedAt = deps.clock.now()
  try {
    answer = await deps.databricks.submit(
      {
        account: input.account,
        operation: "sql.statements.query",
        statement: prepared.sent,
        warehouseId: prepared.warehouseId,
        rowLimit: MAX_ROWS + 1,
        byteLimit: 1024 * 1024,
        disposition: "INLINE",
        format: "JSON_ARRAY",
        waitTimeout: 50,
        onWaitTimeout: "CANCEL",
        queryTags: { oc_plugin: "databricks", oc_tool: "saved_read", oc_call: call.id },
      },
      call.signal,
    )
    if (answer.ambiguous) throw new DatabricksError("UNAVAILABLE", "The submit got no answer, so the statement may have run.", "Check databricks_history({}) before calling again.")
    if (answer.state === "PENDING" || answer.state === "RUNNING") answer = await deps.databricks.waitForStatement(input.account, answer.statementId, { untilMs: deps.clock.now() + deps.options.maxRunSeconds * 1000 }, call.signal)
  } catch (error) {
    throw sourceErrorOf(error)
  }
  // A terminal statement is charged to the spend ledger as every read's is (design §6.2: saved-source reads count the
  // same way). The ledger never throws: the statement already ran.
  if (answer.state === "SUCCEEDED" || answer.state === "FAILED" || answer.state === "CANCELED") {
    const size = sizeOf(prepared.warehouse)
    if (size) {
      await chargeStatement(deps.ledger, deps.clock, deps.options, {
        account: input.account,
        sessionId: call.sessionID,
        warehouseId: prepared.warehouseId,
        statementId: answer.statementId,
        size,
        autoStopMinutes: prepared.warehouse.autoStopMins,
        clusters: Math.max(1, prepared.warehouse.numClusters ?? prepared.warehouse.minNumClusters ?? 1),
        durationMs: Math.max(0, deps.clock.now() - startedAt),
      })
    }
  }
  if (answer.state !== "SUCCEEDED") {
    if (answer.state === "FAILED") throw sourceError("UNAVAILABLE", "The saved query failed on its warehouse.", "Fix the query in Databricks; its error is in the SQL editor's history.")
    if (answer.state === "CANCELED") throw sourceError("UNAVAILABLE", "Databricks cancelled the saved query at its 50-second wait.", "Make the query cheaper, or run it in Databricks.")
    throw sourceError("UNAVAILABLE", "The saved query's result is no longer available.", "Run it again in Databricks, then read it.")
  }
  const columns = answer.manifest?.columns ?? []
  if (columns.length > MAX_COLUMNS) {
    throw sourceError("TOO_LARGE", `The saved query returns ${columns.length} columns, and this source reads at most ${MAX_COLUMNS}.`, "Change the query to return at most 8 columns.")
  }
  const rows: (readonly (string | null)[])[] = []
  const push = (values: readonly (readonly (string | null)[])[] | undefined) => {
    for (const row of values ?? []) rows.push(row)
  }
  push(answer.rows)
  let next = answer.nextChunkIndex
  let guard = 0
  while (next !== undefined && rows.length <= MAX_ROWS) {
    if (++guard > 100) break
    let chunk
    try {
      chunk = await deps.databricks.getChunk(input.account, answer.statementId, next, call.signal)
    } catch (error) {
      throw sourceErrorOf(error)
    }
    push(chunk.rows)
    next = chunk.nextChunkIndex
  }
  const total = answer.manifest?.totalRowCount
  if ((total !== undefined && total > MAX_ROWS) || rows.length > MAX_ROWS) {
    throw sourceError("TOO_LARGE", `The saved query returns more than ${MAX_ROWS} rows, and this source reads at most ${MAX_ROWS}.`, "Change the query to return at most 100 rows.")
  }
  // The registry's table keys are `[A-Za-z0-9_-]{1,40}`; a Databricks column name may hold anything, so the key is a
  // sanitised, unique form of the name and the label is the name itself.
  const keys: string[] = []
  const used = new Set<string>()
  for (const column of columns) {
    const base = column.name.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 40) || "column"
    let key = base
    let n = 2
    while (used.has(key)) key = `${base.slice(0, 36)}_${n++}`
    used.add(key)
    keys.push(key)
  }
  const data: TableData = {
    columns: columns.map((column, index) => ({ key: keys[index]!, label: column.name.slice(0, 40) })),
    rows: rows.map((row) => Object.fromEntries(columns.map((column, index) => [keys[index]!, cell(typedCell(row[index] ?? null, column))]))),
  }
  const cost = { units: [{ per: "statement", count: 1 }] }
  return { data, asOf: new Date(deps.clock.now()).toISOString(), cost, trust: "untrusted" }
}

/** The model's view of the same read: the plugin's `table` shape (column names and row arrays). */
export function tableOf(snapshot: SnapshotAnswer): { columns: string[]; rows: unknown[][] } {
  const names = snapshot.data.columns.map((column) => column.key)
  return { columns: names, rows: snapshot.data.rows.map((row) => names.map((name) => row[name] ?? null)) }
}

export interface SavedOption {
  /** `queryId#sha256`: the id a consumer confirms, with the exact SQL it was chosen as. */
  readonly id: string
  readonly label: string
}

/** `saved_list` (the snapshot's `scope.suggest`): the account's saved queries as `id#sha256` options. */
export async function savedList(deps: Deps, input: { readonly account?: string; readonly source?: string }, call: Call): Promise<{ options: SavedOption[] }> {
  const account = input.account ?? Object.keys(deps.options.accounts ?? {})[0] ?? "default"
  try {
    deps.auth.account(account)
  } catch {
    throw sourceError("ACCOUNT_MISMATCH", `This plugin is not signed in to "${account}".`, "Pass an account this plugin has, or sign in with /connect.")
  }
  const options: SavedOption[] = []
  let pageToken: string | undefined
  let guard = 0
  do {
    let page
    try {
      page = await deps.databricks.listQueries(account, { ...(pageToken === undefined ? {} : { pageToken }) }, call.signal)
    } catch (error) {
      throw sourceErrorOf(error)
    }
    for (const query of page.items) {
      options.push({ id: `${query.id}#${sha256(query.queryText)}`, label: query.name.slice(0, 200) })
      if (options.length >= 64) break
    }
    pageToken = page.nextPageToken
    guard += 1
  } while (pageToken !== undefined && options.length < 64 && guard < 4)
  return { options }
}
