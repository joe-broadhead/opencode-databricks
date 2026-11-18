/**
 * The six commit tools (design §4, §5.5): `databricks_write`, `_delete`, `_share`, `_export`, `_run` and `_admin`.
 * Each takes `{ planId }` and nothing else: the text, the targets and the warehouse are the plan's, so what runs is
 * exactly what the preview showed.
 *
 * Every commit, in this order:
 *
 * 1. reads the plan without consuming it and checks the caller (session, agent, account), the TTL and the category, so a
 *    plan that is not this caller's, is spent or is the wrong tool's is refused **before** the person is asked anything
 *    (the review of #7's LOW 2: an assert on someone else's plan is a prompt they can never need);
 * 2. asserts its own dotted action (`assertTool`) on the operation its kind actually uses — `sql.statements.change`,
 *    `jobs.jobs.runNow`, `jobs.runs.submit` — so a rule on `work:jobs.*` reaches a job run;
 * 3. asserts each of the plan's targets under that action: a table as `<account>:table:<c>.<s>.<t>`, a function as
 *    `<account>:function:<c>.<s>.<f>`, a schema as `<account>:table:<c>.<s>.*` (`targets.ts`);
 * 4. takes the plan once (the authoritative check);
 * 5. **re-checks what the plan previewed**, before it sends anything: it classifies the planned text again, resolves its
 *    targets again with `tables.get` (and a CASCADE's contents with `tables.list`), and compares the category, the target
 *    set and the shapes the preview showed — each target's kind and type, the warehouse's size and cluster bounds — with
 *    the plan's policy. Any difference is `PLAN_CHANGED`;
 * 6. re-checks the warehouse policy (`ensureChangeWarehouse`): it starts one only when the plan previewed a start, and
 *    that start asserts `databricks.start` and is charged before Databricks is asked;
 * 7. sends the plan's exact text with `oc_plan=<planId>` and `oc_tool=<the commit tool>` (or the documented Jobs call),
 *    never re-sending a statement the API may already have;
 * 8. compares Query History's `statement_type` with the category (`src/drift.ts`) and reports a mismatch as a warning —
 *    the change has already run, so a bookkeeping difference never hides its statement id.
 */
import { actionOf, COMMIT_TOOL, type Operation, type ToolName } from "../../domain/actions.js"
import { DatabricksError } from "../../domain/errors.js"
import type { Plan } from "../../domain/plans.js"
import { classifyPlan } from "../../domain/statements.js"
import { checkDrift } from "../../drift.js"
import { assertTool, PRIMARY_OPERATION } from "../../registry.js"
import type { Call, Handler } from "../../tool-spec.js"
import type { Warning } from "../../guards/dependencies.js"
import { accountOf, changeFailure, commitParameters, decodePolicy, ensureChangeWarehouse, requireFeature, statementNext, submitChange } from "./context.js"
import { jobSettingsKey } from "./plan.js"
import { assertTargets, categoryFor, changeTargets, resolveTargets, type ResolvedTarget, type TargetKind } from "./targets.js"

/** The commit tools, and the category each one runs. */
export type CommitTool = "write" | "delete" | "share" | "export" | "run" | "admin"

type CommitDeps = Parameters<Handler<ToolName>>[2]

const planChanged = (detail: string): DatabricksError =>
  new DatabricksError("PLAN_CHANGED", detail, "Plan the change again with databricks_plan, and show the new preview before committing it.")

/** The operation a plan's kind actually uses (design §10.1). */
function operationFor(payload: Plan["payload"]["kind"], fallback: Operation): Operation {
  if (payload === "job") return "jobs.jobs.runNow"
  if (payload === "notebook") return "jobs.runs.submit"
  if (payload === "warehouse") return "sql.warehouses.edit"
  return fallback
}

/** The plan's targets, with the kinds its policy recorded; a plan without a policy is read as tables. */
function plannedTargets(plan: Plan): readonly ResolvedTarget[] {
  const policy = decodePolicy(plan.fingerprint.policy)
  if (policy?.targets) {
    return policy.targets.map((target) => ({ name: target.name, kind: target.kind as TargetKind, cascade: false, ...(target.type ? { type: target.type } : {}), ...(target.children ? { children: target.children.map((child) => ({ name: child.name, kind: child.kind as "schema" | "table" })) } : {}) }))
  }
  return plan.fingerprint.targets.map((name) => ({ name, kind: "table" as const, cascade: false }))
}

/**
 * The store's own checks, without consuming the plan: a plan that is not this caller's, is spent, is stale or is the
 * wrong tool's is refused before any assert (`PlanStorePort.take` repeats them atomically when it is taken).
 */
function checkPlan(entry: { readonly plan: Plan; readonly used: boolean }, tool: ToolName, caller: { readonly sessionId: string; readonly agentId: string; readonly account: string }, now: number): void {
  const { plan } = entry
  if (plan.sessionId !== caller.sessionId || plan.agentId !== caller.agentId || plan.account !== caller.account) throw new DatabricksError("PLAN_CALLER_MISMATCH")
  if (entry.used) throw new DatabricksError("PLAN_ALREADY_USED")
  if (now >= plan.expiresAt) throw new DatabricksError("PLAN_EXPIRED")
  const expected = COMMIT_TOOL[plan.category]
  if (tool !== expected) throw new DatabricksError("CATEGORY_MISMATCH", `This is a ${plan.category} plan.`, `Commit it with databricks_${expected}({ planId }).`)
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
async function commitSql(tool: CommitTool, plan: Plan, call: Call, deps: CommitDeps): Promise<CommitOutcome> {
  if (plan.payload.kind !== "sql") throw new DatabricksError("PLAN_CHANGED", "The plan's payload is not the SQL this tool runs.")
  const payload = plan.payload
  const policy = decodePolicy(plan.fingerprint.policy)
  const defaults = { ...(payload.catalog ? { catalog: payload.catalog } : {}), ...(payload.schema ? { schema: payload.schema } : {}) }
  const classified = classifyPlan(payload.sql)
  if (!classified.ok) throw planChanged("The planned text no longer classifies the way it did when it was planned.")
  const checked = await resolveTargets(deps, { account: plan.account, targets: changeTargets(payload.sql), defaults, signal: call.signal })
  const category = categoryFor(classified, checked)
  if (category !== plan.category) throw planChanged(`The targets now make this a ${category} change, and the plan was previewed as ${plan.category}.`)
  if (JSON.stringify([...checked.names]) !== JSON.stringify([...plan.fingerprint.targets])) {
    throw planChanged(`The targets changed since the plan was made: it named ${plan.fingerprint.targets.join(", ") || "none"}, and the text resolves to ${checked.names.join(", ") || "none"} now.`)
  }
  if (policy?.targets) {
    const before = JSON.stringify(policy.targets.map((target) => ({ name: target.name, kind: target.kind, type: target.type ?? null, children: target.children ?? null })))
    const now = JSON.stringify(checked.targets.map((target) => ({ name: target.name, kind: target.kind, type: target.type ?? null, children: target.children ?? null })))
    if (before !== now) throw planChanged("A target's kind, type or contents changed since the plan was made.")
  }
  const warehouseId = payload.warehouse
  if (plan.fingerprint.warehouse && plan.fingerprint.warehouse !== warehouseId) throw planChanged("The plan's warehouse is not the one it recorded.")
  const intended = policy?.warehouse
  const ensured = await ensureChangeWarehouse(deps, {
    account: plan.account,
    warehouseId,
    intent: intended?.intent ?? "running",
    ...(intended ? { planned: { size: intended.size, minClusters: intended.minClusters, maxClusters: intended.maxClusters, autoStopMinutes: intended.autoStopMinutes } } : {}),
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
    tool,
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
  const recovered = answer.ambiguous === true
  return {
    state: "ok",
    statementId: answer.statementId,
    ...(rowsAffected === undefined ? {} : { rowsAffected }),
    durationMs,
    ...(warnings.length ? { warnings } : {}),
    next: recovered
      ? `The submit got no answer and Databricks found the statement by this call's tag, so it is reported rather than resent: ${statementNext(answer.statementId)} reads it. Nothing was retried.`
      : `Databricks ran the change: ${statementNext(answer.statementId)} reads its statement.`,
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
async function commitJob(plan: Plan, call: Call, deps: CommitDeps): Promise<CommitOutcome> {
  if (plan.payload.kind !== "job") throw new DatabricksError("PLAN_CHANGED", "The plan's payload is not a job run.")
  const payload = plan.payload
  requireFeature(deps, plan.account, "jobs", "Committing a job run")
  const policy = decodePolicy(plan.fingerprint.policy)
  if (policy?.job?.jobId !== payload.jobId) throw planChanged("The plan's job is not the one it recorded.")
  if (policy.job.settings !== undefined) {
    // The preview listed the job's name, timeout and each task's compute: a job that changed since is PLAN_CHANGED.
    const job = await deps.databricks.getJob(plan.account, payload.jobId, call.signal)
    if (jobSettingsKey(job) !== policy.job.settings) throw planChanged("The job's settings changed since the plan was made: its name, timeout or tasks are not the ones the preview listed.")
  }
  const answer = await submitOnce(
    () => deps.databricks.runNow(plan.account, { jobId: payload.jobId, ...(payload.params ? { params: payload.params } : {}), idempotencyToken: plan.id }, call.signal),
    call.signal,
  )
  if (!Number.isSafeInteger(answer.runId)) throw new DatabricksError("UNAVAILABLE", "Databricks accepted the run and answered no run id.", "Check databricks_jobs({}) for the run before calling again.")
  return { state: "running", runId: answer.runId, next: `The job is running: databricks_jobs({ runId: ${answer.runId} }) shows its tasks and output.` }
}

/** A committed one-time notebook run: `POST /api/2.2/jobs/runs/submit` on serverless compute, with its timeout. */
async function commitNotebook(plan: Plan, call: Call, deps: CommitDeps): Promise<CommitOutcome> {
  if (plan.payload.kind !== "notebook") throw new DatabricksError("PLAN_CHANGED", "The plan's payload is not a notebook run.")
  const payload = plan.payload
  requireFeature(deps, plan.account, "jobs", "Committing a notebook run")
  if (decodePolicy(plan.fingerprint.policy)?.notebook?.path !== payload.path) throw planChanged("The plan's notebook is not the one it recorded.")
  const answer = await submitOnce(
    () => deps.databricks.submitRun(plan.account, { notebookPath: payload.path, ...(payload.params ? { params: payload.params } : {}), idempotencyToken: plan.id, timeoutSeconds: payload.timeoutSeconds }, call.signal),
    call.signal,
  )
  if (!Number.isSafeInteger(answer.runId)) throw new DatabricksError("UNAVAILABLE", "Databricks accepted the run and answered no run id.", "Check databricks_jobs({}) for the run before calling again.")
  return { state: "running", runId: answer.runId, next: `The notebook is running with a ${payload.timeoutSeconds}-second timeout: databricks_jobs({ runId: ${answer.runId} }) shows it.` }
}

/** A committed warehouse edit: `POST /api/2.0/sql/warehouses/{id}/edit`, after re-reading the warehouse. */
async function commitWarehouse(plan: Plan, call: Call, deps: CommitDeps): Promise<CommitOutcome> {
  if (plan.payload.kind !== "warehouse") throw new DatabricksError("PLAN_CHANGED", "The plan's payload is not a warehouse edit.")
  const payload = plan.payload
  const policy = decodePolicy(plan.fingerprint.policy)
  const current = await deps.databricks.getWarehouse(plan.account, payload.id, call.signal)
  if (policy?.warehouse) {
    const planned = policy.warehouse
    const now = { size: current.clusterSize, minClusters: current.minNumClusters, maxClusters: current.maxNumClusters, autoStopMinutes: current.autoStopMins }
    const changed = (Object.keys(now) as (keyof typeof now)[]).filter((key) => String(now[key]) !== String(planned[key as "size" | "minClusters" | "maxClusters" | "autoStopMinutes"]))
    if (changed.length) throw planChanged(`The warehouse changed since the plan was made: ${changed.map((key) => `${key} was ${String(planned[key as "size" | "minClusters" | "maxClusters" | "autoStopMinutes"])} and is ${String(now[key])}`).join("; ")}.`)
  }
  const raw = payload.edit
  const edit = {
    ...(typeof raw.size === "string" ? { clusterSize: raw.size } : {}),
    ...(typeof raw.autoStopMinutes === "number" ? { autoStopMins: raw.autoStopMinutes } : {}),
    ...(typeof raw.minClusters === "number" ? { minNumClusters: raw.minClusters } : {}),
    ...(typeof raw.maxClusters === "number" ? { maxNumClusters: raw.maxClusters } : {}),
  }
  if (Object.keys(edit).length === 0) throw planChanged("The plan's edit names no field this version can change.")
  await deps.databricks.editWarehouse(plan.account, payload.id, edit, call.signal)
  return { state: "ok", next: "The warehouse is edited: databricks_warehouses({}) shows its new size, auto-stop and estimated price." }
}

/** One commit tool: check, assert, take the plan once, then run exactly what it previewed. */
export function commitTool<T extends CommitTool>(tool: T): Handler<T> {
  const handler = async (input: { readonly planId: string }, call: Call, deps: CommitDeps): Promise<unknown> => {
    const peeked = deps.plans.peek(input.planId)
    const account = peeked?.plan.account ?? accountOf({}, deps)
    const caller = { sessionId: call.sessionID, agentId: call.agent, account }
    // 1. The store's checks without consuming: no prompt on a plan this caller could never commit.
    if (peeked) checkPlan(peeked, tool as ToolName, caller, deps.clock.now())
    // 2. The tool's own action, on the operation its kind uses.
    const operation = operationFor(peeked?.plan.payload.kind ?? "sql", PRIMARY_OPERATION[tool as ToolName])
    await assertTool(tool as ToolName, account, call, deps, operation)
    // 3. Every target the plan recorded.
    if (peeked) {
      await assertTargets({ permission: deps.permission }, { account, action: actionOf(tool), targets: plannedTargets(peeked.plan), sessionID: call.sessionID, ...(call.messageID && call.id ? { messageID: call.messageID, callID: call.id } : {}), signal: call.signal })
    }
    // 4. Take it once.
    const plan = deps.plans.take(input.planId, tool as ToolName, caller)
    if (plan.payload.kind === "warehouse") return commitWarehouse(plan, call, deps)
    if (plan.payload.kind === "job") return commitJob(plan, call, deps)
    if (plan.payload.kind === "notebook") return commitNotebook(plan, call, deps)
    return commitSql(tool, plan, call, deps)
  }
  return handler as unknown as Handler<T>
}
