/**
 * `databricks_cancel` (design §4, §9): cancel a statement or a job run **that this identity started**. Free control-plane
 * calls: `POST /api/2.0/sql/statements/{id}/cancel` (scope `sql`, [6]) and `POST /api/2.2/jobs/runs/cancel` with
 * `{ run_id }` (scope `jobs`, [29], https://docs.databricks.com/api/jobs/v2/cancel-run.md).
 *
 * **Whose statement it is decides it.** The design gives this tool one object — "a statement or job run that this account
 * started" — and §7 reserves ending other people's work for `/databricks-cleanup`, typed by a person. Databricks would
 * allow a manager to cancel a colleague's statement with Can manage, so the check cannot be left to the server: a
 * statement is cancelled only when Query History's record for it names this identity
 * (`executed_as_user_id ?? user_id`, one call with `filter_by.statement_ids`, [24]), and a run only when `runs/get`
 * names this identity as its creator. A record that names someone else, or nobody this call can name, is refused
 * `STOP_NOT_PERMITTED` — the same code `stop` uses for "never end other people's work".
 *
 * A call's *own* statement is cancelled by Stop without this tool (design §9), so this one is for statements and runs
 * that are still going somewhere else: a `CONTINUE` read, a run from an earlier commit, or a statement this identity
 * started in the SQL editor.
 */
import { DatabricksError } from "../../domain/errors.js"
import { assertTool } from "../../registry.js"
import type { Handler } from "../../tool-spec.js"
import { accountOf, requireFeature } from "./context.js"

/** The refusal for an object this identity did not start (or cannot be shown to have started). */
const notYours = (what: string): DatabricksError =>
  new DatabricksError("STOP_NOT_PERMITTED", `${what} is not this identity's, or its owner cannot be named from what Databricks returned.`, "Only a statement or run this identity started can be cancelled here; /databricks-cleanup, typed by a person, is the only path that ends someone else's.")

const cancel: Handler<"cancel"> = async (input, call, deps) => {
  const account = accountOf(input, deps)
  // The operation the tool is about: a statement's read path, or the Jobs family's cancel (design §10.1).
  await assertTool("cancel", account, call, deps, input.statementId !== undefined || input.runId === undefined ? "sql.statements.get" : "jobs.runs.cancel")
  if ((input.statementId === undefined) === (input.runId === undefined)) {
    throw new DatabricksError("INPUT_INVALID", "databricks_cancel takes exactly one of statementId and runId.", "Pass the statementId of a statement, or the runId of a job run.")
  }
  const me = await deps.databricks.me(account, call.signal)
  const mine = Number(me.id)

  if (input.statementId !== undefined) {
    const statementId = input.statementId
    let owner: number | undefined
    try {
      const page = await deps.databricks.history(account, { statementIds: [statementId], maxResults: 1 }, call.signal)
      const record = page.items.find((item) => item.queryId === statementId) ?? page.items[0]
      owner = record?.executedAsUserId ?? record?.userId
    } catch (error) {
      if (error instanceof DatabricksError && (error.code === "PERMISSION_DENIED" || error.code === "AUTH_SCOPE_MISSING" || error.code === "UNAVAILABLE" || error.code === "RATE_LIMITED")) throw notYours(`The statement ${statementId.slice(0, 120)}`)
      throw error
    }
    if (!Number.isSafeInteger(mine) || owner === undefined || owner !== mine) throw notYours(`The statement ${statementId.slice(0, 120)}`)
    await deps.databricks.cancelStatement(account, statementId, call.signal)
    return { state: "ok", cancelled: `statement ${statementId.slice(0, 120)}`, next: "Check it with databricks_statement; a cancelled statement's results may still be readable." }
  }

  requireFeature(deps, account, "jobs", "Cancelling a job run")
  const runId = input.runId!
  const run = await deps.databricks.getRun(account, runId, call.signal)
  if (run.creatorUserName === undefined || run.creatorUserName !== me.userName) throw notYours(`The run ${runId}`)
  await deps.databricks.cancelRun(account, runId, call.signal)
  // Databricks documents that the run "is canceled asynchronously, so it may still be running when this request
  // completes" (https://docs.databricks.com/api/jobs/v2/cancel-run.md), so the answer says so rather than claiming it.
  return { state: "ok", cancelled: `run ${runId}`, next: `Databricks cancels a run asynchronously: databricks_jobs({ runId: ${runId} }) shows when it stops.` }
}

export default cancel
