/**
 * `databricks_plan` (design §4, §5.5): classify a change, check its targets and its warehouse, and return a single-use
 * `planId` with the preview a person approves. **It writes nothing and sends no statement** — not even `EXPLAIN`
 * (design §5.5 step 3, review H2: `EXPLAIN` ran statements in Spark until SPARK-59689 and SPARK-61554, and a warehouse
 * channel's fixes cannot be known from the client). What replaces `EXPLAIN` is the parser's statement kind and category,
 * the Unity Catalog checks of the targets, Databricks' own parse at commit (a parse failure has no effect), and the
 * post-run Query History check (`src/drift.ts`).
 *
 * Four kinds of plan, one shape:
 *
 * - **SQL** (`sql`): the category comes only from `classifyPlan` (`src/domain/statements.ts`); the token rules can only
 *   raise it. Every target is resolved with `tables.get` (free, [27]) against the catalog and schema the statement will
 *   carry — so a one-part name is `<catalog>.<schema>.<name>`, never the other way round (`targets.ts`). A `CREATE` over
 *   an existing target is a replace, and so `delete` (§5.5). A name the plugin cannot fully qualify is refused rather
 *   than resolved by the server out of the person's rules' reach.
 * - **A job run** (`job`): `POST /api/2.2/jobs/run-now` at commit, with the job's parameters and `idempotency_token` =
 *   the plan id ([29], https://docs.databricks.com/api/jobs/v2/run-now.md). The preview names the job, what its last
 *   run's tasks were, and — once `DatabricksPort.getJob` lands (contract request 1) — each task's compute and the job's
 *   `timeout_seconds`.
 * - **A one-time notebook run** (`notebook`): `POST /api/2.2/jobs/runs/submit` on serverless compute, which returns a
 *   `run_id` and carries `timeout_seconds`, whose documented default is `0` — no timeout ([29],
 *   https://docs.databricks.com/api/jobs/v2/submit-run.md). So the plan always carries `runTimeoutSeconds`.
 * - **A warehouse edit** (`warehouse`, admin): the plan previews the change and the rate it implies. The commit applies
 *   it once `DatabricksPort.editWarehouse` lands (contract request 2); until then its commit answers `NOT_IMPLEMENTED`
 *   and nothing runs.
 *
 * The plan is stored with the account, session and agent that made it (`src/domain/plans.ts`), expires after
 * `planTtlSeconds`, is used once, and records the fingerprint its commit compares again: the target set and a JSON of
 * what the preview showed — each target's kind and type, the warehouse's size and cluster bounds, the job's settings —
 * so a change since the preview is `PLAN_CHANGED` (`context.ts`'s `PlanPolicy`).
 */
import { type Category, COMMIT_TOOL } from "../../domain/actions.js"
import type { Output } from "../../domain/contract.js"
import { DatabricksError } from "../../domain/errors.js"
import type { PlanPayload } from "../../domain/plans.js"
import { classifyPlan } from "../../domain/statements.js"
import { quoted } from "../../guards/pattern.js"
import { describe as describeWarehouse, usdPerHour } from "../../guards/warehouse.js"
import type { JobCompute, Warehouse } from "../../ports.js"
import { assertTool } from "../../registry.js"
import type { Call, Handler } from "../../tool-spec.js"
import { accountOf, encodePolicy, planWarehouse, requireFeature, warehouseNote, warehouseUseOf, type PlanPolicy, type WarehouseIntent } from "./context.js"
import { categoryFor, changeTargets, resolveTargets } from "./targets.js"

type Preview = NonNullable<Output<"plan">["preview"]>

/**
 * One task's compute, in the plugin's own words (design §5.5's job-run preview; `JobCompute` in src/ports.ts). A SQL
 * warehouse task is described and priced as a warehouse start is (`describe`, guards/warehouse.ts); a task whose compute
 * this version cannot read says so, and is never called serverless.
 */
function computeNote(compute: JobCompute, warehouses: ReadonlyMap<string, string | undefined>): string {
  switch (compute.kind) {
    case "serverless":
      return "serverless compute"
    case "existing":
      return `the all-purpose cluster ${quoted(compute.clusterId)}`
    case "warehouse": {
      const described = warehouses.get(compute.warehouseId)
      return described === undefined ? `the SQL warehouse ${quoted(compute.warehouseId)}, which this identity cannot read` : `the SQL warehouse ${described}`
    }
    case "none":
      return `no compute (${compute.what})`
    case "job":
      return `the compute of job ${compute.jobId}`
    case "pipeline":
      return `the pipeline's own compute${compute.pipelineId ? ` (${quoted(compute.pipelineId)})` : ""}`
    case "for-each":
      return `each iteration on ${computeNote(compute.compute, warehouses)}`
    case "unknown":
      return `compute not determined (${compute.reason})`
    case "job-cluster": {
      const workers = compute.autoscale ? `${compute.autoscale.min}–${compute.autoscale.max} workers (autoscale)` : `${compute.numWorkers ?? 1} worker${compute.numWorkers === 1 ? "" : "s"}`
      return `a job cluster${compute.jobClusterKey ? ` shared as ${quoted(compute.jobClusterKey)}` : ""}${compute.nodeTypeId ? ` of ${quoted(compute.nodeTypeId)}` : ""} with ${workers}`
    }
  }
}

/** The job's settings as one string, for the plan's fingerprint: a job that changed since the preview is PLAN_CHANGED. */
export const jobSettingsKey = (job: { readonly name: string; readonly timeoutSeconds?: number; readonly tasks: readonly { readonly taskKey: string; readonly compute: unknown; readonly timeoutSeconds?: number }[] }): string =>
  JSON.stringify({ name: job.name, timeout: job.timeoutSeconds ?? 0, tasks: job.tasks.map((task) => ({ key: task.taskKey, compute: task.compute, timeout: task.timeoutSeconds ?? 0 })) })

/** Whether a notebook path exists, when the sign-in can read the workspace; never sends a statement. */
async function checkNotebook(deps: Parameters<Handler<"plan">>[2], account: string, path: string, signal: AbortSignal): Promise<{ exists?: boolean; note: string }> {
  const identity = deps.auth.account(account)
  // Only `workspace` can list a workspace folder; `files` lists volumes, not notebooks.
  if (!identity.features.includes("workspace")) return { note: "The notebook's path was not checked: the sign-in does not carry the workspace API family." }
  const parent = path.slice(0, path.lastIndexOf("/")) || "/"
  try {
    const entries = await deps.databricks.listWorkspace(account, parent, signal)
    const found = entries.find((entry) => entry.path === path)
    if (!found) return { exists: false, note: "No workspace object is at that path, so runs/submit would fail." }
    return { exists: true, note: found.objectType === "NOTEBOOK" ? "The notebook exists in the workspace." : "The path exists but is not a notebook, so runs/submit would fail." }
  } catch (error) {
    if (error instanceof DatabricksError && error.code === "NOT_FOUND") return { exists: false, note: "No workspace folder is at that path, so runs/submit would fail." }
    if (error instanceof DatabricksError && (error.code === "PERMISSION_DENIED" || error.code === "AUTH_SCOPE_MISSING")) return { note: "The notebook's path was not checked: the workspace read was refused." }
    throw error
  }
}

const adminDisabled = (): DatabricksError => new DatabricksError("ADMIN_DISABLED")

/** The write row's pipeline note: creating or refreshing these bills outside the warehouse (design §5.5, [21]). */
function pipelineNote(kind: string, sql: string): string | undefined {
  const pipeline = kind === "CreatePipelineDatasetContext" || /^\s*create\s+(or\s+refresh\s+)?materialized\s+view\b/iu.test(sql) || /^\s*create\s+streaming\s+table\b/iu.test(sql)
  return pipeline ? "A streaming table or materialized view: creating or refreshing it bills at serverless pipeline rates, outside this warehouse." : undefined
}

interface FieldChange {
  readonly field: string
  readonly from: string
  readonly to: string
}

function warehouseChanges(current: Warehouse, edit: Readonly<Record<string, unknown>>): FieldChange[] {
  const changes: FieldChange[] = []
  const add = (field: string, from: unknown, to: unknown) => {
    if (to === undefined || String(from) === String(to)) return
    changes.push({ field, from: String(from), to: String(to) })
  }
  add("size", current.clusterSize, edit.size)
  add("autoStopMinutes", current.autoStopMins, edit.autoStopMinutes)
  add("minClusters", current.minNumClusters, edit.minClusters)
  add("maxClusters", current.maxNumClusters, edit.maxClusters)
  return changes
}

interface StoredInput {
  readonly category: Category
  readonly kind: string
  readonly account: string
  readonly call: Call
  readonly payload: PlanPayload
  readonly preview: Preview
  readonly targets: readonly string[]
  readonly policy: PlanPolicy
  readonly warehouse?: string
  readonly reason?: string
}

/** Stores the plan and answers the preview (design §5.5: single use, bound to its caller, TTL). */
function stored(deps: Parameters<Handler<"plan">>[2], input: StoredInput): Output<"plan"> {
  const commitWith = `databricks_${COMMIT_TOOL[input.category]}`
  const plan = deps.plans.create({
    category: input.category,
    kind: input.kind,
    account: input.account,
    sessionId: input.call.sessionID,
    agentId: input.call.agent,
    payload: input.payload,
    preview: input.preview,
    fingerprint: { targets: input.targets, ...(input.warehouse ? { warehouse: input.warehouse } : {}), policy: encodePolicy(input.policy) },
    ...(input.reason ? { reason: input.reason } : {}),
  })
  return {
    state: "planned",
    planId: plan.id,
    expiresAt: new Date(plan.expiresAt).toISOString(),
    category: input.category,
    commitWith,
    preview: input.preview,
    next: `Show the preview, then ${commitWith}({ planId: "${plan.id}" }).`,
  }
}

const plan: Handler<"plan"> = async (input, call, deps) => {
  const account = accountOf(input, deps)
  await assertTool("plan", account, call, deps)
  const kinds = [input.sql !== undefined, input.job !== undefined, input.notebook !== undefined, typeof input.warehouse === "object"].filter(Boolean).length
  if (kinds !== 1) {
    throw new DatabricksError("INPUT_INVALID", kinds === 0 ? "A plan needs one of sql, job, notebook or warehouse." : "A plan takes one of sql, job, notebook or warehouse, and this input names more than one.", "Call databricks_plan again with exactly one of them.")
  }

  if (input.sql !== undefined) {
    const classified = classifyPlan(input.sql)
    if (!classified.ok) throw new DatabricksError(classified.code, classified.detail)
    if (classified.category === "admin" && !deps.options.admin.enabled) throw adminDisabled()
    if (classified.category === "admin" && deps.options.admin.requireReason && !input.reason) throw new DatabricksError("ADMIN_REASON_REQUIRED")
    if (typeof input.warehouse === "object") throw new DatabricksError("INPUT_INVALID", "A SQL plan names its warehouse as an id, not as an edit.", "Pass warehouse as an id for a SQL plan, or plan a warehouse edit without sql.")
    if (input.job !== undefined || input.notebook !== undefined) throw new DatabricksError("INPUT_INVALID", "A SQL plan cannot also name a job or a notebook.", "Pass one of sql, job, notebook or warehouse.")
    const identity = deps.auth.account(account)
    const warehouseId = input.warehouse ?? identity.warehouse
    if (!warehouseId) throw new DatabricksError("WAREHOUSE_REQUIRED")
    // The defaults the statement will carry: its own, or the account's. A one-part target resolves against these, and
    // the commit sends them, so the statement runs against exactly the defaults the preview used.
    const catalog = input.catalog ?? identity.catalog
    const schema = input.schema ?? identity.schema
    const defaults = { ...(catalog ? { catalog } : {}), ...(schema ? { schema } : {}) }
    const warehouse = await planWarehouse(deps, { account, warehouseId, signal: call.signal })
    const checked = await resolveTargets(deps, { account, targets: changeTargets(input.sql), defaults, signal: call.signal })
    const category = categoryFor(classified, checked)
    const replaced = category !== classified.category
    const notes = [...classified.notes, ...checked.notes, warehouseNote(warehouse.warehouse, warehouse.intent, deps)]
    if (replaced) notes.push("Its first target already exists, so this is a replace: a delete plan.")
    const pipeline = pipelineNote(classified.kind, input.sql)
    if (pipeline) notes.push(pipeline)
    if (classified.raisedBy.length) notes.push(`Raised to run by ${classified.raisedBy.join(", ")}.`)
    const preview: Preview = {
      kind: classified.kind,
      parsed: classified.parsed,
      targets: checked.targets.map((target) => ({ name: target.name, ...(target.type ? { type: target.type } : {}), ...(target.owner ? { owner: target.owner } : {}), ...(target.exists === undefined ? {} : { exists: target.exists }) })),
      tables: classified.tables.map((parts) => parts.join(".")),
      functions: [...classified.functions],
      warehouse: warehouseUseOf(warehouse.warehouse, deps),
      notes,
      ...(input.reason ? { reason: input.reason } : {}),
    }
    const payload: PlanPayload = { kind: "sql", sql: input.sql, ...(input.params ? { params: input.params } : {}), warehouse: warehouse.warehouse.id, ...(catalog ? { catalog } : {}), ...(schema ? { schema } : {}) }
    const policy: PlanPolicy = {
      kind: "sql",
      warehouse: { id: warehouse.warehouse.id, intent: warehouse.intent, size: warehouse.warehouse.clusterSize, minClusters: warehouse.warehouse.minNumClusters, maxClusters: warehouse.warehouse.maxNumClusters, autoStopMinutes: warehouse.warehouse.autoStopMins },
      targets: checked.targets.map((target) => ({ name: target.name, kind: target.kind, ...(target.type ? { type: target.type } : {}), ...(target.children ? { children: target.children } : {}) })),
    }
    return stored(deps, { category, kind: classified.kind, account, call, payload, preview, targets: checked.names, policy, warehouse: warehouse.warehouse.id, ...(input.reason ? { reason: input.reason } : {}) })
  }

  if (input.job !== undefined) {
    if (input.warehouse !== undefined || input.params !== undefined || input.catalog !== undefined || input.schema !== undefined) throw new DatabricksError("INPUT_INVALID", "A job plan takes job and reason only: its parameters go inside job.params.", "Pass job: { jobId, params }.")
    requireFeature(deps, account, "jobs", "Planning a job run")
    const jobId = input.job.jobId
    const job = await deps.databricks.getJob(account, jobId, call.signal).catch((error: unknown) => {
      if (error instanceof DatabricksError && error.code === "NOT_FOUND") {
        throw new DatabricksError("NOT_FOUND", `No job with the id ${jobId} is visible to this identity.`, "Call databricks_jobs({}) to list the jobs you can see, then plan the run again.")
      }
      throw error
    })
    const creator = job.creatorUserName === undefined ? "" : ` by ${quoted(job.creatorUserName)}`
    const timeout = job.timeoutSeconds === undefined ? "the job's own timeout" : job.timeoutSeconds === 0 ? "no timeout (timeout_seconds 0)" : `timeout_seconds ${job.timeoutSeconds}, which stops it`
    // A SQL warehouse task's price is the warehouse's own: read each one (free) so the preview names it as a start does.
    const warehouses = new Map<string, string | undefined>()
    for (const task of job.tasks) {
      if (task.compute.kind !== "warehouse" || warehouses.has(task.compute.warehouseId)) continue
      try {
        warehouses.set(task.compute.warehouseId, describeWarehouse(await deps.databricks.getWarehouse(account, task.compute.warehouseId, call.signal), deps.options))
      } catch (error) {
        if (error instanceof DatabricksError && (error.code === "NOT_FOUND" || error.code === "PERMISSION_DENIED")) warehouses.set(task.compute.warehouseId, undefined)
        else throw error
      }
    }
    const tasks = job.tasks.map((task) => `${quoted(task.taskKey)} on ${computeNote(task.compute, warehouses)}${task.timeoutSeconds === undefined ? "" : `, task timeout ${task.timeoutSeconds}s`}`)
    const notes = [
      "A job run: its effects are not known until it runs.",
      `The job ${quoted(job.name)}${creator} runs with its own settings and its own Run as identity; billed separately at the job's own compute rates.`,
      tasks.length === 0 ? "The job has no tasks this version can see." : `Its tasks: ${tasks.join("; ")}.`,
      `The run runs for ${timeout}.`,
      "The run is submitted with idempotency_token = this plan's id, so a retried submit launches one run, not two.",
    ]
    const preview: Preview = { kind: "job", parsed: false, targets: [], tables: [], functions: [], notes, ...(input.reason ? { reason: input.reason } : {}) }
    const payload: PlanPayload = { kind: "job", jobId: input.job.jobId, ...(input.job.params ? { params: input.job.params } : {}) }
    const policy: PlanPolicy = { kind: "job", job: { jobId: input.job.jobId, settings: jobSettingsKey(job) } }
    return stored(deps, { category: "run", kind: "job", account, call, payload, preview, targets: [], policy, ...(input.reason ? { reason: input.reason } : {}) })
  }

  if (input.notebook !== undefined) {
    if (input.warehouse !== undefined || input.params !== undefined || input.catalog !== undefined || input.schema !== undefined) throw new DatabricksError("INPUT_INVALID", "A notebook plan takes notebook and reason only: its parameters go inside notebook.params.", "Pass notebook: { path, params }.")
    requireFeature(deps, account, "jobs", "Planning a notebook run")
    const timeoutSeconds = deps.options.runTimeoutSeconds
    const checked = await checkNotebook(deps, account, input.notebook.path, call.signal)
    const notes = [
      "A one-time notebook run: its effects are not known until it runs.",
      `Submitted with runs/submit on serverless compute and billed separately at serverless job rates, with timeout_seconds ${timeoutSeconds}: Databricks stops the run at that timeout.`,
      checked.note,
      "The run is submitted with idempotency_token = this plan's id, so a retried submit launches one run, not two.",
    ]
    const preview: Preview = {
      kind: "notebook",
      parsed: false,
      targets: [{ name: input.notebook.path, type: "NOTEBOOK", ...(checked.exists === undefined ? {} : { exists: checked.exists }) }],
      tables: [],
      functions: [],
      notes,
      ...(input.reason ? { reason: input.reason } : {}),
    }
    const payload: PlanPayload = { kind: "notebook", path: input.notebook.path, ...(input.notebook.params ? { params: input.notebook.params } : {}), timeoutSeconds }
    const policy: PlanPolicy = { kind: "notebook", notebook: { path: input.notebook.path } }
    return stored(deps, { category: "run", kind: "notebook", account, call, payload, preview, targets: [], policy, ...(input.reason ? { reason: input.reason } : {}) })
  }

  // A warehouse edit: admin only, with a reason when the option requires one.
  if (!deps.options.admin.enabled) throw adminDisabled()
  if (deps.options.admin.requireReason && !input.reason) throw new DatabricksError("ADMIN_REASON_REQUIRED")
  const edit = input.warehouse as { id: string; edit: Readonly<Record<string, unknown>> }
  if (edit.edit.statementTimeoutSeconds !== undefined) {
    // The edit page does document `statement_timeout` (Public Preview), but this version's `WarehouseEdit` has no field
    // for it (review of #7, request 2's ruling kept it out until the page was cited; it now is). Say "not yet supported"
    // rather than claiming the body has no such field.
    throw new DatabricksError("INPUT_INVALID", "statementTimeoutSeconds is not yet supported in a warehouse edit by this version.", "Set statement_timeout in the Databricks SQL warehouse settings, or with the warehouse's SQL configuration.")
  }
  const current = await deps.databricks.getWarehouse(account, edit.id, call.signal)
  const changes = warehouseChanges(current, edit.edit)
  if (changes.length === 0) throw new DatabricksError("INPUT_INVALID", "The warehouse edit changes nothing.", "Name at least one of size, autoStopMinutes, minClusters, maxClusters or statementTimeoutSeconds, with a different value.")
  const minClusters = typeof edit.edit.minClusters === "number" ? edit.edit.minClusters : undefined
  const maxClusters = typeof edit.edit.maxClusters === "number" ? edit.edit.maxClusters : undefined
  if (minClusters !== undefined && maxClusters !== undefined && minClusters > maxClusters) {
    throw new DatabricksError("INPUT_INVALID", "minClusters is above maxClusters in this edit.", "Set minClusters at or below maxClusters.")
  }
  const before = usdPerHour(current, deps.options)
  const after = edit.edit.size === undefined ? before : usdPerHour({ ...current, clusterSize: String(edit.edit.size) }, deps.options)
  const resultingAutoStop = typeof edit.edit.autoStopMinutes === "number" ? edit.edit.autoStopMinutes : current.autoStopMins
  const notes = [
    `A warehouse edit of ${describeWarehouse(current, deps.options)}: an administrative change through the control plane, free by itself.`,
    `Changes: ${changes.map((change) => `${change.field} ${change.from} → ${change.to}`).join("; ")}.`,
    `The rate is about $${before.toFixed(2)}/hour now and about $${after.toFixed(2)}/hour after, while the warehouse runs (a list-price estimate).`,
    ...(resultingAutoStop === 0 ? ["It never auto-stops: it bills until someone stops it, as an idle warehouse accumulates DBU charges until it is stopped."] : []),
    "Committing re-reads the warehouse first: a size or cluster bound that changed since this preview is PLAN_CHANGED.",
  ]
  const preview: Preview = { kind: "warehouse", parsed: false, targets: [], tables: [], functions: [], notes, ...(input.reason ? { reason: input.reason } : {}) }
  const payload: PlanPayload = { kind: "warehouse", id: edit.id, edit: { ...edit.edit } }
  const policy: PlanPolicy = {
    kind: "warehouse",
    warehouse: { id: edit.id, intent: "running", size: current.clusterSize, minClusters: current.minNumClusters, maxClusters: current.maxNumClusters, autoStopMinutes: current.autoStopMins },
  }
  return stored(deps, { category: "admin", kind: "warehouse", account, call, payload, preview, targets: [], policy, warehouse: edit.id, ...(input.reason ? { reason: input.reason } : {}) })
}

export default plan
