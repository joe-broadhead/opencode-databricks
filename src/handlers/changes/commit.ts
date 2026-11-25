/**
 * The six commit methods. Each takes `{ planId }` and nothing else: the register has checked the plan's account, its
 * single use and the method it commits, and hands the planning handler's full answer to this one as `call.plan`.
 *
 * A commit re-checks what the preview showed before it sends anything: it classifies the planned text again, resolves
 * its targets again, and compares the category, the target set and the warehouse's shape with the plan's fingerprint.
 * A difference is `PLAN_CHANGED`. A stopped warehouse refuses: a start is its own method.
 *
 * The statement carries `oc_plan=<planId>` and `oc_tool=<the commit method>`; Query History's statement type is
 * compared with the category afterwards, and a mismatch is a warning on an answer that already ran.
 */
import { DatabricksError } from "../../domain/errors.js"
import { classifyPlan } from "../../provider/classify.js"
import { checkDrift } from "../../provider/drift.js"
import type { Call, Handler } from "../types.js"
import type { Warning } from "../../provider/guards/dependencies.js"
import { accountOf, changeFailure, commitParameters, decodePolicy, ensureChangeWarehouse, requireFeature, statementNext, submitChange, warehouseUse } from "./context.js"
import { jobSettingsKey, type StoredPlan } from "./plan.js"
import { categoryFor, changeTargets, resolveTargets } from "./targets.js"

/** The commit tools, and the category each one runs. */
export type CommitTool = "write" | "delete" | "share" | "export" | "run" | "admin"

type CommitDeps = Parameters<Handler<"write">>[2]

const planChanged = (detail: string): DatabricksError =>
  new DatabricksError("PLAN_CHANGED", detail, "Plan the change again with the class's plan method and show the new preview before committing it.")

/** A plan as the commit sees it: the private answer plus the id and time the register bound it to. */
type Plan = StoredPlan & { readonly id: string; readonly sessionId: string; readonly agentId: string; readonly createdAt: number; readonly expiresAt: number }

interface CommitOutcome {
  readonly state: "ok" | "running"
  readonly trust: "untrusted"
  readonly statementId?: string
  readonly runId?: number
  readonly rowsAffected?: number
  readonly durationMs?: number
  /** This call's own cost: the warehouse the committed statement ran on, and its estimated $/hour. */
  readonly warehouse?: ReturnType<typeof warehouseUse>
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
    trust: "untrusted",
    statementId: answer.statementId,
    ...(rowsAffected === undefined ? {} : { rowsAffected }),
    durationMs,
    warehouse: warehouseUse(ensured, deps),
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
  return { state: "running", trust: "untrusted", runId: answer.runId, next: `The job is running: databricks_jobs({ runId: ${answer.runId} }) shows its tasks and output.` }
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
  return { state: "running", trust: "untrusted", runId: answer.runId, next: `The notebook is running with a ${payload.timeoutSeconds}-second timeout: databricks_jobs({ runId: ${answer.runId} }) shows it.` }
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
  return { state: "ok", trust: "untrusted", next: "The warehouse is edited: databricks_warehouses({}) shows its new size, auto-stop and estimated price." }
}

/** One commit tool: the register has checked the plan, the account and its single use; run exactly what it previewed. */
export function commitTool<T extends CommitTool>(tool: T): Handler<T> {
  const handler = async (input: { readonly planId: string }, call: Call, deps: CommitDeps): Promise<unknown> => {
    const answer = call.plan as { plan?: StoredPlan } | undefined
    const data = answer?.plan
    if (data === undefined || typeof data !== "object" || data.category !== tool) {
      throw new DatabricksError("CATEGORY_MISMATCH", `This is not a ${tool} plan.`, `Commit it with databricks_${data?.category ?? tool}({ planId }).`)
    }
    const now = deps.clock.now()
    const plan: Plan = {
      ...data,
      id: input.planId,
      account: call.account ?? data.account,
      sessionId: call.sessionID,
      agentId: call.agent,
      createdAt: now,
      expiresAt: now + 15 * 60_000,
    }
    if (plan.payload.kind === "warehouse") return commitWarehouse(plan, call, deps)
    if (plan.payload.kind === "job") return commitJob(plan, call, deps)
    if (plan.payload.kind === "notebook") return commitNotebook(plan, call, deps)
    return commitSql(tool, plan, call, deps)
  }
  return handler as unknown as Handler<T>
}
