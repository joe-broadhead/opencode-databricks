/**
 * The six commit tools (design §4, §5.5): `databricks_write`, `_delete`, `_share`, `_export`, `_run` and `_admin`.
 * Each takes `{ planId }` and nothing else: the text, the targets and the warehouse are the plan's, so what runs is
 * exactly what the preview showed.
 *
 * Every commit, in this order:
 *
 * 1. asserts its own dotted action (`assertTool`, in the factory) — before any Databricks call;
 * 2. takes the plan once, which checks the caller (session, agent, account), the TTL and the category
 *    (`CATEGORY_MISMATCH` names the right tool);
 * 3. **re-checks what the plan previewed**, before it sends anything: it classifies the planned text again, resolves its
 *    targets again with `tables.get`, and compares the category and the target set with the plan's fingerprint. A
 *    different category or target set is `PLAN_CHANGED`; a target that appeared or vanished can change a `CREATE` into a
 *    replace, which is exactly the case the fingerprint catches;
 * 4. asserts each target table as `<account>:table:<c>.<s>.<t>` under its own dotted action, from the plan's own names,
 *    before the re-check's calls — so a person's `deny databricks.delete on work:table:*.hr.*` stops the commit before
 *    anything is read or run;
 * 5. re-checks the warehouse policy (`ensureChangeWarehouse`): it starts one only when the plan previewed a start, and
 *    that start asserts `databricks.start` and is charged before Databricks is asked;
 * 6. sends the plan's exact text with `oc_plan=<planId>` (or the documented Jobs call), never retried;
 * 7. compares Query History's `statement_type` with the category (`src/drift.ts`) and reports a mismatch as a warning —
 *    the change has already run, so a bookkeeping difference never hides its statement id.
 */
import { actionOf, tableResource, type ToolName } from "../../domain/actions.js"
import { DatabricksError } from "../../domain/errors.js"
import type { Plan } from "../../domain/plans.js"
import { classifyPlan } from "../../domain/statements.js"
import { checkDrift } from "../../drift.js"
import { assertTool } from "../../registry.js"
import type { Call, Handler } from "../../tool-spec.js"
import type { Warning } from "../../guards/dependencies.js"
import { accountOf, changeFailure, commitParameters, ensureChangeWarehouse, requireFeature, statementNext, submitChange, type WarehouseIntent } from "./context.js"
import { categoryFor, checkTargets, statementTables } from "./targets.js"

/** The commit tools, and the category each one runs. */
export type CommitTool = "write" | "delete" | "share" | "export" | "run" | "admin"

const planChanged = (detail: string): DatabricksError =>
  new DatabricksError("PLAN_CHANGED", detail, "Plan the change again with databricks_plan, and show the new preview before committing it.")

/** The plan's own targets, asserted under the commit tool's dotted action before any call. */
async function assertTargets(tool: CommitTool, account: string, targets: readonly string[], call: Call, deps: Parameters<Handler<ToolName>>[2]): Promise<void> {
  for (const name of targets) {
    const parts = name.split(".")
    if (parts.length !== 3) continue
    await deps.permission.assert(
      { action: actionOf(tool), resource: tableResource(account, parts[0]!, parts[1]!, parts[2]!), sessionID: call.sessionID, ...(call.messageID && call.id ? { messageID: call.messageID, callID: call.id } : {}) },
      call.signal,
    )
  }
}

interface CommitOutcome {
  readonly state: "ok" | "running"
  readonly statementId?: string
  readonly runId?: number
  readonly rowsAffected?: number
  readonly durationMs?: number
  readonly warnings?: readonly Warning[]
  readonly next?: string
}

/** A committed SQL plan: the plan's text, its warehouse, and the drift check afterwards. */
async function commitSql(tool: CommitTool, plan: Plan, call: Call, deps: Parameters<Handler<ToolName>>[2]): Promise<CommitOutcome> {
  if (plan.payload.kind !== "sql") throw new DatabricksError("PLAN_CHANGED", "The plan's payload is not the SQL this tool runs.")
  const payload = plan.payload
  const classified = classifyPlan(payload.sql)
  if (!classified.ok) throw planChanged("The planned text no longer classifies the way it did when it was planned.")
  await assertTargets(tool, plan.account, plan.fingerprint.targets, call, deps)
  const checked = await checkTargets(deps, { account: plan.account, tables: statementTables(payload.sql), ...(payload.catalog ? { catalog: payload.catalog } : {}), ...(payload.schema ? { schema: payload.schema } : {}), signal: call.signal })
  const category = categoryFor(classified, checked)
  if (category !== plan.category) throw planChanged(`The targets now make this a ${category} change, and the plan was previewed as ${plan.category}.`)
  if (JSON.stringify([...checked.names]) !== JSON.stringify([...plan.fingerprint.targets])) {
    throw planChanged(`The targets changed since the plan was made: it named ${plan.fingerprint.targets.join(", ") || "none"}, and the text resolves to ${checked.names.join(", ") || "none"} now.`)
  }
  const warehouseId = payload.warehouse
  if (plan.fingerprint.warehouse && plan.fingerprint.warehouse !== warehouseId) throw planChanged("The plan's warehouse is not the one it recorded.")
  const intent = (plan.fingerprint.policy ?? "running") as WarehouseIntent
  const ensured = await ensureChangeWarehouse(deps, {
    account: plan.account,
    warehouseId,
    intent,
    wait: deps.options.wait,
    sessionID: call.sessionID,
    ...(call.messageID && call.id ? { messageID: call.messageID, callID: call.id } : {}),
    signal: call.signal,
  })
  const parameters = commitParameters(payload.params)
  const { answer, durationMs } = await submitChange(deps, {
    account: plan.account,
    planId: plan.id,
    call,
    statement: payload.sql,
    warehouse: ensured.warehouse,
    ...(parameters ? { parameters } : {}),
    ...(payload.catalog ? { catalog: payload.catalog } : {}),
    ...(payload.schema ? { schema: payload.schema } : {}),
    wait: deps.options.wait,
  })
  const failure = changeFailure(answer)
  if (failure) throw failure
  if (!answer.statementId) throw new DatabricksError("UNAVAILABLE", "Databricks accepted the statement and answered no statement id.", "Check databricks_history({}) for the change before calling again.")
  const drift = await checkDrift({ databricks: deps.databricks, now: deps.clock.now }, { account: plan.account, statementId: answer.statementId, category: plan.category, planId: plan.id, signal: call.signal })
  const warnings = [...ensured.warnings, ...drift]
  const rowsAffected = answer.manifest?.totalRowCount
  return {
    state: "ok",
    statementId: answer.statementId,
    ...(rowsAffected === undefined ? {} : { rowsAffected }),
    durationMs,
    ...(warnings.length ? { warnings } : {}),
    next: `Databricks ran the change: ${statementNext(answer.statementId)} reads its statement.`,
  }
}

/**
 * One Jobs submit, with the one retry Databricks documents. `idempotency_token` guarantees "exactly one run is launched
 * with that idempotency token", and "upon failure you can retry until the request succeeds" ([29],
 * https://docs.databricks.com/api/jobs/v2/run-now.md), so an ambiguous failure is retried **once with the same token**
 * — the token, not the plugin, is what makes the retry safe. A cancelled call is never retried.
 */
async function submitOnce<T>(submit: () => Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return await submit()
  } catch (error) {
    if (signal.aborted) throw error
    if (!(error instanceof DatabricksError) || error.code !== "UNAVAILABLE") throw error
    return submit()
  }
}

/** A committed job run: `POST /api/2.2/jobs/run-now`, with the plan id as the idempotency token. */
async function commitJob(plan: Plan, call: Call, deps: Parameters<Handler<ToolName>>[2]): Promise<CommitOutcome> {
  if (plan.payload.kind !== "job") throw new DatabricksError("PLAN_CHANGED", "The plan's payload is not a job run.")
  const payload = plan.payload
  requireFeature(deps, plan.account, "jobs", "Committing a job run")
  if (plan.fingerprint.policy !== `job:${payload.jobId}`) throw planChanged("The plan's job is not the one it recorded.")
  const answer = await submitOnce(
    () => deps.databricks.runNow(plan.account, { jobId: payload.jobId, ...(payload.params ? { params: payload.params } : {}), idempotencyToken: plan.id }, call.signal),
    call.signal,
  )
  if (!Number.isSafeInteger(answer.runId)) throw new DatabricksError("UNAVAILABLE", "Databricks accepted the run and answered no run id.", "Check databricks_jobs({}) for the run before calling again.")
  return { state: "running", runId: answer.runId, next: `The job is running: databricks_jobs({ runId: ${answer.runId} }) shows its tasks and output.` }
}

/** A committed one-time notebook run: `POST /api/2.2/jobs/runs/submit` on serverless compute, with its timeout. */
async function commitNotebook(plan: Plan, call: Call, deps: Parameters<Handler<ToolName>>[2]): Promise<CommitOutcome> {
  if (plan.payload.kind !== "notebook") throw new DatabricksError("PLAN_CHANGED", "The plan's payload is not a notebook run.")
  const payload = plan.payload
  requireFeature(deps, plan.account, "jobs", "Committing a notebook run")
  if (plan.fingerprint.policy !== `notebook:${payload.path}`) throw planChanged("The plan's notebook is not the one it recorded.")
  const answer = await submitOnce(
    () => deps.databricks.submitRun(plan.account, { notebookPath: payload.path, ...(payload.params ? { params: payload.params } : {}), idempotencyToken: plan.id, timeoutSeconds: payload.timeoutSeconds }, call.signal),
    call.signal,
  )
  if (!Number.isSafeInteger(answer.runId)) throw new DatabricksError("UNAVAILABLE", "Databricks accepted the run and answered no run id.", "Check databricks_jobs({}) for the run before calling again.")
  return { state: "running", runId: answer.runId, next: `The notebook is running with a ${payload.timeoutSeconds}-second timeout: databricks_jobs({ runId: ${answer.runId} }) shows it.` }
}

/** What a commit's handler needs: the one input every commit tool takes, and the shared deps. */
type CommitDeps = Parameters<Handler<ToolName>>[2]

/** One commit tool: assert, take the plan once, then run exactly what it previewed. */
export function commitTool<T extends CommitTool>(tool: T): Handler<T> {
  const handler = async (input: { readonly planId: string }, call: Call, deps: CommitDeps): Promise<unknown> => {
    // The plan's own account, when the id names one: the assert must be about the account the plan belongs to.
    const peeked = deps.plans.peek(input.planId)
    const account = peeked?.plan.account ?? accountOf({}, deps)
    await assertTool(tool as ToolName, account, call, deps)
    const plan = deps.plans.take(input.planId, tool as ToolName, { sessionId: call.sessionID, agentId: call.agent, account })
    let outcome: CommitOutcome
    if (plan.payload.kind === "warehouse") {
      // The plan is valid and is consumed; the client has no warehouse update call, so nothing is sent. The contract
      // request is in the PR (DatabricksPort.editWarehouse).
      throw new DatabricksError("NOT_IMPLEMENTED", "This version's Databricks client has no warehouse update call, so it cannot apply this plan.", "Change the warehouse in Databricks' SQL warehouse settings; the plan's preview names each field and the rate it implies.")
    } else if (plan.payload.kind === "job") outcome = await commitJob(plan, call, deps)
    else if (plan.payload.kind === "notebook") outcome = await commitNotebook(plan, call, deps)
    else outcome = await commitSql(tool, plan, call, deps)
    return outcome
  }
  return handler as unknown as Handler<T>
}
