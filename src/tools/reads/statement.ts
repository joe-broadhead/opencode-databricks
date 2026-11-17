/**
 * `databricks_statement` (design §4): one statement this account started — its state, its error (only ever in
 * `providerError`, design §5.8) and its next result chunk under the same caps as `databricks_query`.
 *
 * - Results are kept 12 hours after a terminal state [6]; a statement that is gone answers `RESULTS_EXPIRED`.
 * - `chunk` asks for one chunk by index; without it the statement's own `nextChunkIndex` is used, so a caller can page
 *   with the same call.
 * - `wait` polls `GET /statements/{id}` at most once a second, because the GET may lag up to 5 s behind a submit [6].
 *   The first terminal state ends the poll.
 * - This tool sends no statement and asserts no table: it reads a statement the identity already owns.
 */
import { DatabricksError } from "../../domain/errors.js"
import { assertTool } from "../../registry.js"
import type { Handler } from "../../tool-spec.js"
import { accountOf, statementRef } from "./context.js"
import { shapeRows } from "./values.js"

const POLL_MS = 1000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * When this process first saw each running statement, for `maxRunSeconds` (design §5.1, §6.2). A statement above the
 * wait is `CONTINUE`, so the plugin's own cancel is what stops it while this process runs; without that, the backstop is
 * the warehouse's `STATEMENT_TIMEOUT` (2 days by default [20]). It is advisory, and it is this process's memory only.
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
    for (let elapsed = 0; elapsed < Math.min(wait, 50) && (answer.state === "PENDING" || answer.state === "RUNNING"); elapsed++) {
      if (call.signal.aborted) throw new DatabricksError("CANCELLED")
      await sleep(POLL_MS)
      answer = await deps.databricks.getStatement(account, input.statementId, call.signal)
    }
  } catch (error) {
    if (error instanceof DatabricksError && error.code === "NOT_FOUND") throw expired(input.statementId)
    throw error
  }
  // A chunk is fetched only when the caller asks for one: a first call answers the statement as it is.
  const running = answer.state === "PENDING" || answer.state === "RUNNING"
  if (running && deps.clock.now() - seen > deps.options.maxRunSeconds * 1000) {
    await deps.databricks.cancelStatement(account, input.statementId, call.signal)
    firstSeen.delete(key)
    throw new DatabricksError("RUN_TIMEOUT", `The statement ran longer than maxRunSeconds (${deps.options.maxRunSeconds} seconds), so this process cancelled it.`, "Narrow the query, or raise maxRunSeconds; a closed laptop leaves the warehouse's STATEMENT_TIMEOUT as the backstop.")
  }
  if (!running) firstSeen.delete(key)
  const chunk = input.chunk
  if (chunk !== undefined && !running) {
    try {
      answer = await deps.databricks.getChunk(account, input.statementId, chunk, call.signal)
    } catch (error) {
      if (error instanceof DatabricksError && error.code === "NOT_FOUND") throw expired(input.statementId)
      throw error
    }
  }
  const provider = answer.error ? { ...answer.error, trust: "untrusted" as const } : undefined
  if (answer.state === "FAILED") throw new DatabricksError("STATEMENT_FAILED", "The statement failed.", undefined, provider)
  const columns = (answer.manifest?.columns ?? []).map((column) => ({ name: column.name, type: column.typeText || column.typeName }))
  const shaped = shapeRows(answer.rows, answer.manifest?.columns)
  return {
    state: running ? ("running" as const) : answer.state === "CANCELED" ? ("cancelled" as const) : ("ok" as const),
    trust: "untrusted",
    statementId: input.statementId,
    status: answer.state,
    ...(columns.length ? { columns } : {}),
    ...(shaped.rows.length ? { rows: shaped.rows } : {}),
    ...(chunk === undefined ? {} : { chunk }),
    ...(answer.nextChunkIndex === undefined ? {} : { nextChunk: answer.nextChunkIndex }),
    ...(running ? { next: statementRef(input.statementId) } : {}),
  }
}

export default statement
