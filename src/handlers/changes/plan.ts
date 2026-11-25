/**
 * The six plan methods. Each class has one, because the contract binds one planning method to exactly one commit
 * method; they share the classifier and refuse a change of another class with the plan method to call instead.
 *
 * A plan writes nothing and sends no statement. It classifies the text, resolves every target with free Unity Catalog
 * reads, reads the warehouse (free), and answers the preview a person sees plus the private plan the commit reads.
 * The register mints the `planId`, stores the answer for 15 minutes, and lets it commit once.
 *
 * A SQL plan's category comes only from `classifyPlan`; a `CREATE` over an existing target is a replace, and so a
 * `delete`. A job run and a one-time notebook run are `run`; a warehouse edit is `admin`.
 */
import { type Category, COMMIT_TOOL } from "../../methods.js"
import type { Output } from "../schemas.js"
import { DatabricksError } from "../../domain/errors.js"
import { classifyPlan } from "../../provider/classify.js"
import { quoted } from "../../provider/guards/pattern.js"
import { describe as describeWarehouse, usdPerHour } from "../../provider/guards/warehouse.js"
import type { JobCompute, Warehouse } from "../../ports.js"
import type { Call, Handler } from "../types.js"
import { accountOf, encodePolicy, planWarehouse, requireFeature, warehouseNote, warehouseUseOf, type PlanPolicy, type WarehouseIntent } from "./context.js"
import { categoryFor, changeTargets, resolveTargets } from "./targets.js"

/** The preview a person sees. */
interface Preview {
  readonly kind: string
  readonly parsed: boolean
  readonly targets: readonly { readonly name: string; readonly type?: string; readonly owner?: string; readonly exists?: boolean }[]
  readonly tables: readonly string[]
  readonly functions: readonly string[]
  readonly warehouse?: { readonly id: string; readonly name: string; readonly usdPerHour: number }
  readonly notes: readonly string[]
  readonly reason?: string
}

/** The plan handler's answer: the commit method, the preview fields, and the private plan the commit reads. */
interface PlanAnswer {
  readonly method: string
  readonly output: Preview
  readonly changes: readonly string[]
  readonly cost: unknown
  readonly trust: "untrusted"
  readonly plan: StoredPlan
}

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
async function checkNotebook(deps: Parameters<Handler<"plan_write">>[2], account: string, path: string, signal: AbortSignal): Promise<{ exists?: boolean; note: string }> {
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

export type PlanPayload =
  | { readonly kind: "sql"; readonly sql: string; readonly params?: readonly { readonly name: string; readonly value: unknown; readonly type?: string }[]; readonly warehouse: string; readonly catalog?: string; readonly schema?: string }
  | { readonly kind: "job"; readonly jobId: number; readonly params?: Readonly<Record<string, string>> }
  | { readonly kind: "notebook"; readonly path: string; readonly params?: Readonly<Record<string, string>>; readonly timeoutSeconds: number }
  | { readonly kind: "warehouse"; readonly id: string; readonly edit: Readonly<Record<string, unknown>> }

/** The private half of a plan: what the commit needs and what it re-checks, kept by the register as `call.plan`. */
export interface StoredPlan {
  readonly category: Category
  readonly kind: string
  readonly account: string
  readonly payload: PlanPayload
  readonly preview: Preview
  readonly fingerprint: { readonly targets: readonly string[]; readonly warehouse?: string; readonly policy?: string }
  readonly reason?: string
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

/**
 * The plan's answer: the commit method the register binds the plan to, the preview fields a person sees, and the private
 * plan the commit receives as `call.plan`. No `planId`: the register mints it.
 */
function stored(input: StoredInput): PlanAnswer {
  const plan: StoredPlan = {
    category: input.category,
    kind: input.kind,
    account: input.account,
    payload: input.payload,
    preview: input.preview,
    fingerprint: { targets: input.targets, ...(input.warehouse ? { warehouse: input.warehouse } : {}), policy: encodePolicy(input.policy) },
    ...(input.reason ? { reason: input.reason } : {}),
  }
  return {
    method: COMMIT_TOOL[input.category],
    output: input.preview,
    changes: [...input.preview.notes],
    cost: input.preview.warehouse,
    trust: "untrusted",
    plan,
  }
}

/** One class's plan: the same classifier, refusing a change that belongs to another class's plan method. */
function planFor(wanted: Category) {
  return async (input: import("../schemas.js").Input<"plan_write">, call: Call, deps: Parameters<Handler<"plan_write">>[2]): Promise<PlanAnswer> => {
  const account = accountOf(input as never, deps)
  const kinds = [input.sql !== undefined, input.job !== undefined, input.notebook !== undefined, typeof input.warehouse === "object"].filter(Boolean).length
  if (kinds !== 1) {
    throw new DatabricksError("INPUT_INVALID", kinds === 0 ? "A plan needs one of sql, job, notebook or warehouse." : "A plan takes one of sql, job, notebook or warehouse, and this input names more than one.", "Call the plan method again with exactly one of them.")
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
    if (category !== wanted) {
      throw new DatabricksError("INPUT_INVALID", `This is a ${category} change, and ${wanted} is another class.`, `Call databricks_plan_${category} with the same input; each class has its own plan and commit.`)
    }
    const replaced = category !== wanted
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
    return stored({ category, kind: classified.kind, account, call, payload, preview, targets: checked.names, policy, warehouse: warehouse.warehouse.id, ...(input.reason ? { reason: input.reason } : {}) })
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
    if (wanted !== "run") throw new DatabricksError("INPUT_INVALID", "A job run is a run change, and this is another class's plan.", "Call databricks_plan_run.")
    const preview: Preview = { kind: "job", parsed: false, targets: [], tables: [], functions: [], notes, ...(input.reason ? { reason: input.reason } : {}) }
    const payload: PlanPayload = { kind: "job", jobId: input.job.jobId, ...(input.job.params ? { params: input.job.params } : {}) }
    const policy: PlanPolicy = { kind: "job", job: { jobId: input.job.jobId, settings: jobSettingsKey(job) } }
    return stored({ category: "run", kind: "job", account, call, payload, preview, targets: [], policy, ...(input.reason ? { reason: input.reason } : {}) })
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
    if (wanted !== "run") throw new DatabricksError("INPUT_INVALID", "A notebook run is a run change, and this is another class's plan.", "Call databricks_plan_run.")
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
    return stored({ category: "run", kind: "notebook", account, call, payload, preview, targets: [], policy, ...(input.reason ? { reason: input.reason } : {}) })
  }

  // A warehouse edit: admin only, with a reason when the option requires one.
  if (wanted !== "admin") throw new DatabricksError("INPUT_INVALID", "A warehouse edit is an admin change, and this is another class's plan.", "Call databricks_plan_admin.")
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
  return stored({ category: "admin", kind: "warehouse", account, call, payload, preview, targets: [], policy, warehouse: edit.id, ...(input.reason ? { reason: input.reason } : {}) })
  }
}

export const planWrite: Handler<"plan_write"> = planFor("write") as unknown as Handler<"plan_write">
export const planDelete: Handler<"plan_delete"> = planFor("delete") as unknown as Handler<"plan_delete">
export const planShare: Handler<"plan_share"> = planFor("share") as unknown as Handler<"plan_share">
export const planExport: Handler<"plan_export"> = planFor("export") as unknown as Handler<"plan_export">
export const planRun: Handler<"plan_run"> = planFor("run") as unknown as Handler<"plan_run">
export const planAdmin: Handler<"plan_admin"> = planFor("admin") as unknown as Handler<"plan_admin">
