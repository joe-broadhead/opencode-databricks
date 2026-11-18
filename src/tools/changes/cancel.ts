/**
 * `databricks_cancel` (design §4, §9): cancel a statement or a job run that this account started. Free control-plane
 * calls: `POST /api/2.0/sql/statements/{id}/cancel` (scope `sql`, [6]) and `POST /api/2.2/jobs/runs/cancel` with
 * `{ run_id }` (scope `jobs`, [29], https://docs.databricks.com/api/jobs/v2/cancel-run.md).
 *
 * **Whose statement it is.** The plugin records no statement ids across a restart, so it cannot prove that a statement
 * id belongs to this account: Databricks' own authorisation decides that, and a call for someone else's statement is
 * refused by the server (`PERMISSION_DENIED`). What this tool adds is the person's rules — its own dotted action —
 * before anything is sent.
 *
 * A call's *own* statement is cancelled by Stop without this tool (design §9), so this one is for statements and runs
 * that are still going somewhere else: a `CONTINUE` read, or a run started by a previous commit.
 */
import { DatabricksError } from "../../domain/errors.js"
import { assertTool } from "../../registry.js"
import type { Handler } from "../../tool-spec.js"
import { accountOf, requireFeature } from "./context.js"

const cancel: Handler<"cancel"> = async (input, call, deps) => {
  const account = accountOf(input, deps)
  // The operation the tool is about: a statement's read path, or the Jobs family's cancel (design §10.1).
  await assertTool("cancel", account, call, deps, input.statementId !== undefined || input.runId === undefined ? "sql.statements.get" : "jobs.runs.cancel")
  if ((input.statementId === undefined) === (input.runId === undefined)) {
    throw new DatabricksError("INPUT_INVALID", "databricks_cancel takes exactly one of statementId and runId.", "Pass the statementId of a statement, or the runId of a job run.")
  }
  if (input.statementId !== undefined) {
    await deps.databricks.cancelStatement(account, input.statementId, call.signal)
    return { state: "ok", cancelled: `statement ${input.statementId.slice(0, 120)}`, next: "Check it with databricks_statement; a cancelled statement's results may still be readable." }
  }
  requireFeature(deps, account, "jobs", "Cancelling a job run")
  const runId = input.runId!
  await deps.databricks.cancelRun(account, runId, call.signal)
  // Databricks documents that the run "is canceled asynchronously, so it may still be running when this request
  // completes" (https://docs.databricks.com/api/jobs/v2/cancel-run.md), so the answer says so rather than claiming it.
  return { state: "ok", cancelled: `run ${runId}`, next: `Databricks cancels a run asynchronously: databricks_jobs({ runId: ${runId} }) shows when it stops.` }
}

export default cancel
