/**
 * `databricks_statement` (design §4): one statement this account started — its state, its error (only ever in
 * `providerError`, design §5.8) and its next result chunk under the same caps as `databricks_query`.
 *
 * - Results are kept 12 hours after a terminal state [6]; a statement that is gone answers `RESULTS_EXPIRED`.
 * - `chunk` asks for one chunk by index. A chunk has no state of its own [6]: it is `ChunkAnswer`, with `rows` and
 *   `nextChunkIndex` at the top level, and the statement's columns come from the statement.
 * - `wait` waits through `DatabricksPort.waitForStatement`, which polls at most once a second because the GET may lag up
 *   to 5 s behind a submit [6]; the first terminal state ends it.
 * - A statement this process has seen running for longer than `maxRunSeconds` is cancelled here (design §6.2, advisory:
 *   a closed laptop leaves the warehouse's `STATEMENT_TIMEOUT` as the backstop).
 * - This tool sends no statement and asserts no table: it reads a statement the identity already owns.
 */
import { DatabricksError } from "../../domain/errors.js"
import type { ChunkAnswer } from "../../ports.js"
import { assertTool } from "../../registry.js"
import type { Handler } from "../../tool-spec.js"
import { accountOf, statementRef } from "./context.js"
import { shapeRows } from "./values.js"

/**
 * When this process first saw each running statement, for `maxRunSeconds`. A statement above the wait is `CONTINUE`, so
 * the plugin's own cancel is what stops it while this process runs. Module-wide and advisory: this process's memory only.
 */
const firstSeen = new Map<string, number>()

/** Test seam: forget the statements this process has seen. */
export function forgetStatementAges(): void {
  firstSeen.clear()
}

const expired = (statementId: string): DatabricksError =>
  new DatabricksError("RESULTS_EXPIRED", `The statement ${statementId.slice(0, 120)} is gone: Databricks keeps results 12 hours after it finishes.`, "Run it again; an identical query may be served from the result cache.")

const statement: Handler<"statement"> = async (input, call, deps) => {
  const account = accountOf(input, deps)
  await assertTool("statement", account, call, deps)
  const wait = input.wait ?? 0
  const key = `${account}|${input.statementId}`
  const seen = firstSeen.get(key) ?? deps.clock.now()
  firstSeen.set(key, seen)
  let answer
  try {
    answer = await deps.databricks.getStatement(account, input.statementId, call.signal)
    if (wait > 0 && (answer.state === "PENDING" || answer.state === "RUNNING")) {
      answer = await deps.databricks.waitForStatement(account, input.statementId, { untilMs: deps.clock.now() + Math.min(wait, 50) * 1000 }, call.signal)
    }
  } catch (error) {
    if (error instanceof DatabricksError && error.code === "NOT_FOUND") throw expired(input.statementId)
    throw error
  }
  const running = answer.state === "PENDING" || answer.state === "RUNNING"
  if (running && deps.clock.now() - seen > deps.options.maxRunSeconds * 1000) {
    await deps.databricks.cancelStatement(account, input.statementId, call.signal)
    firstSeen.delete(key)
    throw new DatabricksError("RUN_TIMEOUT", `The statement ran longer than maxRunSeconds (${deps.options.maxRunSeconds} seconds), so this process cancelled it.`, "Narrow the query, or raise maxRunSeconds; a closed laptop leaves the warehouse's STATEMENT_TIMEOUT as the backstop.")
  }
  if (!running) firstSeen.delete(key)
  // A chunk is fetched only when the caller asks for one: a first call answers the statement as it is.
  const rows = input.chunk === undefined || running ? answer.rows : undefined
  let chunk: ChunkAnswer | undefined
  if (input.chunk !== undefined && !running) {
    try {
      chunk = await deps.databricks.getChunk(account, input.statementId, input.chunk, call.signal)
    } catch (error) {
      if (error instanceof DatabricksError && error.code === "NOT_FOUND") throw expired(input.statementId)
      throw error
    }
  }
  const provider = answer.error ? { ...answer.error, trust: "untrusted" as const } : undefined
  if (answer.state === "FAILED") throw new DatabricksError("STATEMENT_FAILED", "The statement failed.", undefined, provider)
  const columns = (answer.manifest?.columns ?? []).map((column) => ({ name: column.name, type: column.typeText || column.typeName }))
  const shaped = shapeRows(chunk?.rows ?? rows, answer.manifest?.columns)
  const nextChunk = chunk ? chunk.nextChunkIndex : answer.nextChunkIndex
  return {
    state: running ? ("running" as const) : answer.state === "CANCELED" ? ("cancelled" as const) : ("ok" as const),
    trust: "untrusted",
    statementId: input.statementId,
    status: answer.state,
    ...(columns.length ? { columns } : {}),
    ...(shaped.rows.length ? { rows: shaped.rows } : {}),
    ...(input.chunk === undefined ? {} : { chunk: input.chunk }),
    ...(nextChunk === undefined ? {} : { nextChunk }),
    ...(running ? { next: statementRef(input.statementId) } : {}),
  }
}

export default statement
