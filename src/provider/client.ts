/**
 * The Databricks client: `src/ports.ts`'s `DatabricksPort` over the Statement Execution, Warehouses, Query History,
 * Queries, Unity Catalog, Jobs, Workspace, Files and SCIM APIs (design §1 D1, §16 package B).
 *
 * Every method names its operation, so the scope check happens before the call (`AUTH_SCOPE_MISSING`), and sends the
 * account's token to its own workspace host only. Wire shapes are mapped here; the statement submit policy (no blind
 * retry, history recovery, signal → cancel) is `http.ts`'s; values are `values.ts`'s; links are `links.ts`'s.
 *
 * Endpoints, as the design's §19 cites them:
 * - SCIM `GET /api/2.0/preview/scim/v2/Me` [30];
 * - SQL warehouses `GET /api/2.0/sql/warehouses`, `…/{id}`, `POST …/{id}/start|stop` [15];
 * - Statement Execution `POST /api/2.0/sql/statements`, `GET …/{id}`, `GET …/result/chunks/{n}`, `POST …/cancel` [6];
 * - Query History `GET /api/2.0/sql/history/queries` [24];
 * - Queries `GET /api/2.0/sql/queries`, `…/{id}` [30];
 * - Unity Catalog `GET /api/2.1/unity-catalog/{catalogs,schemas,tables,functions,volumes}`,
 *   `…/effective-permissions/{type}/{full_name}` [27][28];
 * - Jobs `GET /api/2.2/jobs/list`, `GET …/runs/list`, `…/runs/get`, `…/runs/get-output`, `POST …/run-now`,
 *   `POST …/runs/submit`, `…/runs/cancel` [29];
 * - Workspace `GET /api/2.0/workspace/list`, `…/export`; Files `GET /api/2.0/fs/directories/{path}` (the Workspace and
 *   Files APIs; the mapped fields are `src/ports.ts`'s).
 */
import type { Operation } from "../methods.js"
import { DatabricksError } from "../domain/errors.js"
import type {
  ChunkAnswer,
  Clock,
  DatabricksPort,
  Dependency,
  FunctionInfo,
  HistoryQuery,
  Identity,
  JobCompute,
  JobInfo,
  Page,
  RunInfo,
  StatementAnswer,
  StatementRequest,
  TableInfo,
  Warehouse,
  WarehouseEdit,
  WarehouseState,
} from "../ports.js"
import { type Fetch, type QueryValue, Statements, WorkspaceHttp, guardedLiveFetch } from "./http.js"
import { fetchLinkBytes } from "./links.js"
import { pollUntilDone, toChunkAnswer, toHistoryQuery, toStatementAnswer } from "./statements.js"

export interface DatabricksClientOptions {
  /** The auth port: the account's host, cloud and token. */
  readonly auth: ConstructorParameters<typeof WorkspaceHttp>[0]["auth"]
  readonly fetch?: Fetch
  readonly clock?: Clock
  /** Test seams, passed to the transport and the poll. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  readonly maxResponseBytes?: number
  readonly maxAttempts?: number
  readonly retryBaseMs?: number
  readonly recoveryTimeoutMs?: number
}

const WAREHOUSE_STATES: readonly WarehouseState[] = ["STARTING", "RUNNING", "STOPPING", "STOPPED", "DELETING", "DELETED"]

const text = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "")
const maybeText = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined)
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {})
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** One warehouse, from `GET /api/2.0/sql/warehouses` and the warehouse object. */
export function toWarehouse(value: unknown): Warehouse {
  const item = record(value)
  const state = text(item.state).toUpperCase() as WarehouseState
  const type = text(item.warehouse_type).toUpperCase()
  const numClusters = count(item.num_clusters)
  const statementTimeout = count(item.statement_timeout)
  return {
    id: text(item.id),
    name: text(item.name),
    state: WAREHOUSE_STATES.includes(state) ? state : "STOPPED",
    warehouseType: type === "PRO" || type === "CLASSIC" ? type : "TYPE_UNSPECIFIED",
    serverless: item.enable_serverless_compute === true,
    clusterSize: text(item.cluster_size),
    autoStopMins: count(item.auto_stop_mins) ?? 0,
    minNumClusters: count(item.min_num_clusters) ?? 1,
    maxNumClusters: count(item.max_num_clusters) ?? 1,
    ...(numClusters !== undefined ? { numClusters } : {}),
    ...(statementTimeout !== undefined ? { statementTimeoutSeconds: statementTimeout } : {}),
  }
}

/** One Unity Catalog dependency (`view_dependencies.dependencies[]`, `routine_dependencies.dependencies[]`). */
export function toDependency(value: unknown): Dependency | undefined {
  const item = record(value)
  const table = record(item.table)
  const fn = record(item.function)
  const connection = record(item.connection)
  const credential = record(item.credential)
  if (text(table.table_full_name)) return { kind: "table", name: text(table.table_full_name) }
  if (text(fn.function_full_name)) return { kind: "function", name: text(fn.function_full_name) }
  if (text(connection.connection_name)) return { kind: "connection", name: text(connection.connection_name) }
  if (text(credential.credential_name)) return { kind: "credential", name: text(credential.credential_name) }
  return undefined
}

/** A table or view (`GET /api/2.1/unity-catalog/tables/{full_name}`); `view_dependencies` stays undefined when absent. */
export function toTable(value: unknown): TableInfo {
  const item = record(value)
  const partitionColumns = list(item.columns)
    .map((entry) => record(entry))
    .filter((column) => count(column.partition_index) !== undefined)
    .sort((a, b) => (count(a.partition_index) ?? 0) - (count(b.partition_index) ?? 0))
    .map((column) => text(column.name))
  const dependencies = item.view_dependencies === undefined ? undefined : list(record(item.view_dependencies).dependencies).map(toDependency).filter((entry): entry is Dependency => entry !== undefined)
  const rowFilter = maybeText(record(item.row_filter).function_name)
  const updatedAt = count(item.updated_at)
  return {
    fullName: text(item.full_name),
    tableType: text(item.table_type),
    ...(maybeText(item.data_source_format) ? { dataSourceFormat: maybeText(item.data_source_format) } : {}),
    ...(maybeText(item.comment) ? { comment: maybeText(item.comment) } : {}),
    ...(maybeText(item.owner) ? { owner: maybeText(item.owner) } : {}),
    columns: list(item.columns).map((value) => {
      const column = record(value)
      const mask = maybeText(record(column.mask).function_name)
      return {
        name: text(column.name),
        typeText: text(column.type_text),
        ...(column.nullable === false ? { nullable: false } : {}),
        ...(maybeText(column.comment) ? { comment: maybeText(column.comment) } : {}),
        ...(mask ? { mask: { functionName: mask } } : {}),
      }
    }),
    ...(rowFilter ? { rowFilter: { functionName: rowFilter } } : {}),
    ...(maybeText(item.view_definition) ? { viewDefinition: maybeText(item.view_definition) } : {}),
    ...(dependencies !== undefined ? { viewDependencies: dependencies } : {}),
    ...(partitionColumns.length > 0 ? { partitionColumns } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  }
}

/** A function (`GET /api/2.1/unity-catalog/functions/{full_name}`). A TABLE_TYPE return makes it a UDTF. */
export function toFunction(value: unknown): FunctionInfo {
  const item = record(value)
  const dependencies = item.routine_dependencies === undefined ? undefined : list(record(item.routine_dependencies).dependencies).map(toDependency).filter((entry): entry is Dependency => entry !== undefined)
  return {
    fullName: text(item.full_name),
    routineBody: text(item.routine_body).toUpperCase() === "EXTERNAL" ? "EXTERNAL" : "SQL",
    ...(maybeText(item.external_language) ? { externalLanguage: maybeText(item.external_language) } : {}),
    ...(maybeText(item.routine_definition) ? { routineDefinition: maybeText(item.routine_definition) } : {}),
    ...(dependencies !== undefined ? { routineDependencies: dependencies } : {}),
    ...(maybeText(item.sql_path) ? { sqlPath: maybeText(item.sql_path) } : {}),
    isTableFunction: text(item.data_type).toUpperCase() === "TABLE_TYPE" || item.return_params !== undefined,
  }
}

/** One job run (`runs/list`, `runs/get`); `state` is the API's lifecycle state and result state. */
export function toRun(value: unknown): RunInfo {
  const item = record(value)
  const state = record(item.state)
  const start = count(item.start_time)
  const end = count(item.end_time)
  return {
    runId: count(item.run_id) ?? 0,
    ...(count(item.job_id) !== undefined ? { jobId: count(item.job_id) } : {}),
    ...(maybeText(item.run_name) ? { runName: maybeText(item.run_name) } : {}),
    state: {
      lifeCycleState: text(state.life_cycle_state),
      ...(maybeText(state.result_state) ? { resultState: maybeText(state.result_state) } : {}),
    },
    startTime: start ?? 0,
    ...(end !== undefined ? { endTime: end } : {}),
    ...(maybeText(item.creator_user_name) ? { creatorUserName: maybeText(item.creator_user_name) } : {}),
    ...(maybeText(item.trigger) ? { triggerType: maybeText(item.trigger) } : {}),
    ...(maybeText(item.run_type) ? { runType: maybeText(item.run_type) } : {}),
  }
}

/** A cluster's documented compute fields: `node_type_id`, `num_workers`, or `autoscale`'s min and max. */
function clusterCompute(cluster: Record<string, unknown>): { nodeTypeId?: string; numWorkers?: number; autoscale?: { min: number; max: number } } | undefined {
  const nodeTypeId = maybeText(cluster.node_type_id)
  const numWorkers = count(cluster.num_workers)
  const autoscale = record(cluster.autoscale)
  const min = count(autoscale.min_workers)
  const max = count(autoscale.max_workers)
  if (nodeTypeId === undefined && numWorkers === undefined && !(min !== undefined && max !== undefined)) return undefined
  return { ...(nodeTypeId ? { nodeTypeId } : {}), ...(numWorkers !== undefined ? { numWorkers } : {}), ...(min !== undefined && max !== undefined ? { autoscale: { min, max } } : {}) }
}

/** The SQL warehouse a task runs on, from the documented `warehouse_id` of a SQL, dbt or notebook task. */
function taskWarehouse(task: Record<string, unknown>): string | undefined {
  for (const key of ["sql_task", "dbt_task", "notebook_task"]) {
    const warehouse = maybeText(record(task[key]).warehouse_id)
    if (warehouse) return warehouse
  }
  return undefined
}

/** The task types `JobTaskSettings` documents (Jobs API 2.2, `TaskSettings`). */
const TASK_TYPES: ReadonlySet<string> = new Set([
  "notebook_task",
  "spark_python_task",
  "python_wheel_task",
  "spark_jar_task",
  "spark_submit_task",
  "pipeline_task",
  "sql_task",
  "dbt_task",
  "run_job_task",
  "condition_task",
  "for_each_task",
  "alert_task",
  "dashboard_task",
  "power_bi_task",
  "ai_runtime_task",
  "ai_function_task",
  "clean_rooms_notebook_task",
])

/**
 * The task types Databricks documents as supporting serverless compute: "Serverless compute is supported with the
 * notebook, Python script, dbt, Python wheel, and JAR task types"
 * (https://docs.databricks.com/aws/en/jobs/run-serverless-jobs).
 */
const SERVERLESS_TASK_TYPES: ReadonlySet<string> = new Set(["notebook_task", "spark_python_task", "python_wheel_task", "spark_jar_task", "spark_submit_task", "dbt_task"])

/**
 * Where one task of a job runs, from `GET /api/2.2/jobs/get`'s `JobTaskSettings`
 * (https://docs.databricks.com/api/jobs/v2/get-job.md). The rules, in order:
 *
 * - `condition_task` needs no compute; `run_job_task` runs on the other job's; `pipeline_task` on its pipeline's; a
 *   `for_each_task` runs its inner task once per iteration, so its compute is the inner task's (recursively).
 * - `existing_cluster_id` is that all-purpose cluster; `new_cluster` is a job cluster with its `node_type_id` and
 *   `num_workers` or `autoscale`; `job_cluster_key` is "the cluster specified in `job.settings.job_clusters`" (a key the
 *   settings do not hold is undetermined).
 * - A SQL warehouse task (`sql_task.warehouse_id`, `dbt_task.warehouse_id`, a notebook's `warehouse_id`) runs there.
 * - `environment_key` selects serverless compute. A notebook, Python script, Python wheel, JAR or dbt task with no
 *   compute field at all also runs on serverless, as the page above documents.
 * - **Absence is never read as serverless otherwise**: an unrecognised task type, a task with no task type, or a task
 *   type whose compute this version does not map is `unknown`, with a reason the preview states plainly.
 */
export function toJobCompute(value: unknown, jobSettings: unknown = {}): JobCompute {
  const task = record(value)
  const typeFields = Object.keys(task).filter((key) => key.endsWith("_task"))
  const unknownType = typeFields.find((key) => !TASK_TYPES.has(key))
  if (unknownType !== undefined) return { kind: "unknown", reason: `its task type ${unknownType} is not one this version knows` }
  if (typeFields.length === 0) return { kind: "unknown", reason: "the task names no task type" }
  if (typeFields.length > 1) return { kind: "unknown", reason: `the task names more than one task type (${typeFields.join(", ")})` }
  const type = typeFields[0]!
  if (type === "condition_task") return { kind: "none", what: "a condition task needs no compute" }
  if (type === "run_job_task") {
    const jobId = count(record(task.run_job_task).job_id)
    return jobId === undefined ? { kind: "unknown", reason: "its run_job_task names no job" } : { kind: "job", jobId }
  }
  if (type === "pipeline_task") {
    const pipelineId = maybeText(record(task.pipeline_task).pipeline_id)
    return { kind: "pipeline", ...(pipelineId ? { pipelineId } : {}) }
  }
  if (type === "for_each_task") {
    const inner = record(task.for_each_task).task
    if (inner === undefined) return { kind: "unknown", reason: "its for_each_task names no inner task" }
    return { kind: "for-each", compute: toJobCompute(inner, jobSettings) }
  }
  const existing = maybeText(task.existing_cluster_id)
  if (existing) return { kind: "existing", clusterId: existing }
  const inline = clusterCompute(record(task.new_cluster))
  if (inline) return { kind: "job-cluster", ...inline }
  const key = maybeText(task.job_cluster_key)
  if (key) {
    const shared = list(record(jobSettings).job_clusters)
      .map(record)
      .find((cluster) => maybeText(cluster.job_cluster_key) === key)
    const sharedCompute = shared === undefined ? undefined : clusterCompute(record(shared.new_cluster))
    if (sharedCompute) return { kind: "job-cluster", jobClusterKey: key, ...sharedCompute }
    return { kind: "unknown", reason: `its job cluster ${key} is not in the job's settings` }
  }
  const warehouse = taskWarehouse(task)
  if (warehouse) return { kind: "warehouse", warehouseId: warehouse }
  if (type === "sql_task") return { kind: "unknown", reason: "its SQL task names no warehouse" }
  if (maybeText(task.environment_key)) return { kind: "serverless" }
  if (SERVERLESS_TASK_TYPES.has(type)) return { kind: "serverless" }
  return { kind: "unknown", reason: `its ${type.replace(/_task$/u, "")} task does not document the compute it uses` }
}

/** One job's settings (`GET /api/2.2/jobs/get`); `timeout_seconds` 0 is documented as "no timeout". */
export function toJobInfo(value: unknown): JobInfo {
  const job = record(value)
  const settings = record(job.settings)
  const timeout = count(settings.timeout_seconds)
  return {
    jobId: count(job.job_id) ?? 0,
    name: text(settings.name),
    ...(maybeText(job.creator_user_name) ? { creatorUserName: maybeText(job.creator_user_name) } : {}),
    ...(maybeText(job.run_as_user_name) ? { runAsUserName: maybeText(job.run_as_user_name) } : {}),
    ...(timeout !== undefined ? { timeoutSeconds: timeout } : {}),
    tasks: list(settings.tasks)
      .map(record)
      .map((task) => {
        const taskTimeout = count(task.timeout_seconds)
        return { taskKey: text(task.task_key), compute: toJobCompute(task, settings), ...(taskTimeout !== undefined ? { timeoutSeconds: taskTimeout } : {}) }
      }),
  }
}

/**
 * The fields `POST /api/2.0/sql/warehouses/{id}/edit` documents
 * (https://docs.databricks.com/api/warehouses/v1/edit-warehouse.md). The body is a set of optional fields whose omitted
 * ones take documented defaults (`auto_stop_mins` defaults to 120, `enable_photon` to true, …), so the client sends the
 * warehouse read back with only the changed fields replaced: a partial body would silently reset the rest.
 */
/** How many `jobs/get` array pages one call reads: 10 pages of 100 tasks is far beyond a job this plugin should run. */
const JOB_PAGES_MAX = 10

/** One page of `models` asks for the documented maximum (its `max_results` is at most 100). */
const MODEL_PAGE = 100
/** How many pages one `listModels` reads before it gives up: 10,000 models in one schema is more than a CASCADE should drop. */
const MODEL_PAGES_MAX = 100

const WAREHOUSE_EDIT_FIELDS = ["name", "cluster_size", "min_num_clusters", "max_num_clusters", "auto_stop_mins", "creator_name", "instance_profile_arn", "tags", "spot_instance_policy", "enable_photon", "channel", "enable_serverless_compute", "warehouse_type", "statement_timeout"] as const

/** Base64 → text, for `workspace/export`'s `content`. */
function decodeBase64(value: string): string {
  try {
    return Buffer.from(value, "base64").toString("utf8")
  } catch {
    return value
  }
}

/** A path on the workspace or Files API: every segment encoded, `/` kept. */
const encodedPath = (path: string): string => path.split("/").map((segment) => encodeURIComponent(segment)).join("/")

/** The client, as one `DatabricksPort`. */
export function createDatabricksClient(options: DatabricksClientOptions): DatabricksPort {
  const http = new WorkspaceHttp({
    auth: options.auth,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.maxResponseBytes !== undefined ? { maxResponseBytes: options.maxResponseBytes } : {}),
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    ...(options.retryBaseMs !== undefined ? { retryBaseMs: options.retryBaseMs } : {}),
  })
  const fetchImpl: Fetch = options.fetch ?? guardedLiveFetch
  const statements = new Statements(http, {
    ...(options.clock ? { now: options.clock.now } : {}),
    ...(options.recoveryTimeoutMs !== undefined ? { recoveryTimeoutMs: options.recoveryTimeoutMs } : {}),
  })

  const call = async (account: string, operation: Operation, method: "GET" | "POST", path: string, input: { query?: Readonly<Record<string, QueryValue>>; body?: unknown; idempotent?: boolean; signal: AbortSignal }) =>
    (await http.request({ account, operation, method, path, ...input })).body

  const page = <T>(body: unknown, key: string, map: (value: unknown) => T): Page<T> => {
    const answer = record(body)
    const next = maybeText(answer.next_page_token)
    return { items: list(answer[key]).map(map), ...(next ? { nextPageToken: next } : {}) }
  }

  /**
   * The Queries API warns that "calling this API concurrently 10 or more times could result in throttling, service
   * degradation, or a temporary ban" (Queries, List queries), so a saved query's reads are serialised per account.
   */
  const queryReads = new Map<string, Promise<unknown>>()
  const oneAtATime = <T>(account: string, run: () => Promise<T>): Promise<T> => {
    const previous = queryReads.get(account) ?? Promise.resolve()
    const next = previous.then(run, run)
    queryReads.set(account, next.then(
      () => undefined,
      () => undefined,
    ))
    return next
  }

  /** A statement read, with a gone statement (12 hours of results) reported as RESULTS_EXPIRED. */
  const statement = async <T>(account: string, path: string, map: (body: unknown) => T, signal: AbortSignal): Promise<T> => {
    try {
      return map(await call(account, "sql.statements.get", "GET", path, { idempotent: true, signal }))
    } catch (error) {
      // A statement the warehouse no longer holds: its 12 hours of results are gone (design §12 RESULTS_EXPIRED).
      if (error instanceof DatabricksError && error.code === "NOT_FOUND") {
        throw new DatabricksError("RESULTS_EXPIRED", "The statement is gone; Databricks keeps a result for 12 hours.", "Run the query again.", error.providerError)
      }
      throw error
    }
  }

  const port: DatabricksPort = {
    async me(account: string, signal: AbortSignal): Promise<Identity> {
      const answer = record(await call(account, "scim.me.get", "GET", "/api/2.0/preview/scim/v2/Me", { idempotent: true, signal }))
      const groups = list(answer.groups)
        .map((entry) => record(entry))
        .map((group) => ({ id: text(group.value ?? group.id), ...(maybeText(group.display) ?? maybeText(group.displayName) ? { displayName: maybeText(group.display) ?? maybeText(group.displayName) } : {}) }))
        .filter((group) => group.id !== "")
      return {
        id: text(answer.id),
        userName: text(answer.userName),
        ...(maybeText(answer.displayName) ? { displayName: maybeText(answer.displayName) } : {}),
        ...(groups.length > 0 ? { groups } : {}),
      }
    },

    async listWarehouses(account: string, signal: AbortSignal): Promise<readonly Warehouse[]> {
      const answer = record(await call(account, "sql.warehouses.list", "GET", "/api/2.0/sql/warehouses", { idempotent: true, signal }))
      return list(answer.warehouses).map(toWarehouse)
    },

    async getWarehouse(account: string, id: string, signal: AbortSignal): Promise<Warehouse> {
      return toWarehouse(await call(account, "sql.warehouses.get", "GET", `/api/2.0/sql/warehouses/${encodeURIComponent(id)}`, { idempotent: true, signal }))
    },

    async startWarehouse(account: string, id: string, signal: AbortSignal): Promise<void> {
      try {
        await call(account, "sql.warehouses.start", "POST", `/api/2.0/sql/warehouses/${encodeURIComponent(id)}/start`, { body: {}, idempotent: true, signal })
      } catch (error) {
        if (error instanceof DatabricksError && error.code === "PERMISSION_DENIED") throw new DatabricksError("WAREHOUSE_FORBIDDEN", undefined, undefined, error.providerError)
        throw error
      }
    },

    /**
     * `POST /api/2.0/sql/warehouses/{id}/edit` (`sql.warehouses.edit`): the warehouse read back with the plan's fields
     * replaced, because the body's omitted fields take documented defaults (see `WAREHOUSE_EDIT_FIELDS`). A 404 is
     * `NOT_FOUND` and a 403 `PERMISSION_DENIED`, as everywhere else in this client.
     */
    async editWarehouse(account: string, id: string, edit: WarehouseEdit, signal: AbortSignal): Promise<void> {
      const current = record(await call(account, "sql.warehouses.get", "GET", `/api/2.0/sql/warehouses/${encodeURIComponent(id)}`, { idempotent: true, signal }))
      const body: Record<string, unknown> = {}
      for (const field of WAREHOUSE_EDIT_FIELDS) if (current[field] !== undefined) body[field] = current[field]
      if (edit.clusterSize !== undefined) body.cluster_size = edit.clusterSize
      if (edit.autoStopMins !== undefined) body.auto_stop_mins = edit.autoStopMins
      if (edit.minNumClusters !== undefined) body.min_num_clusters = edit.minNumClusters
      if (edit.maxNumClusters !== undefined) body.max_num_clusters = edit.maxNumClusters
      await call(account, "sql.warehouses.edit", "POST", `/api/2.0/sql/warehouses/${encodeURIComponent(id)}/edit`, { body, idempotent: true, signal })
    },

    /**
     * `GET /api/2.2/jobs/get` (`jobs.jobs.get`): one job's settings and each task's compute. The reference paginates
     * the array properties — "a request for a single job will return … the first 100 elements of array properties
     * (`tasks`, `job_clusters`, …); use the `next_page_token` field … and pass its value as the page cursor" — so every
     * page is read and the arrays merged (https://docs.databricks.com/api/jobs/v2/get-job.md).
     */
    async getJob(account: string, jobId: number, signal: AbortSignal): Promise<JobInfo> {
      const pages: Record<string, unknown>[] = []
      let pageToken: string | undefined
      for (let page = 0; page < JOB_PAGES_MAX; page++) {
        const answer = record(
          await call(account, "jobs.jobs.get", "GET", "/api/2.2/jobs/get", { query: { job_id: jobId, ...(pageToken === undefined ? {} : { pageToken }) }, idempotent: true, signal }),
        )
        pages.push(answer)
        const next = maybeText(answer.next_page_token)
        if (next === undefined) break
        pageToken = next
        if (page === JOB_PAGES_MAX - 1) throw new DatabricksError("UNAVAILABLE", `Job ${jobId} has more array pages than this client reads in one call.`, "Read it in Databricks, or split its tasks into fewer jobs.")
      }
      const first = pages[0] ?? {}
      const settings = pages.reduce<Record<string, unknown>>((merged, page) => {
        const current = record(page.settings)
        return {
          ...merged,
          ...current,
          tasks: [...list(merged.tasks), ...list(current.tasks)],
          job_clusters: [...list(merged.job_clusters), ...list(current.job_clusters)],
        }
      }, {})
      return toJobInfo({ ...first, settings })
    },

    async stopWarehouse(account: string, id: string, signal: AbortSignal): Promise<void> {
      try {
        await call(account, "sql.warehouses.stop", "POST", `/api/2.0/sql/warehouses/${encodeURIComponent(id)}/stop`, { body: {}, idempotent: true, signal })
      } catch (error) {
        // Stopping needs Can manage: a refusal here is STOP_NOT_PERMITTED, not a general denial (design §7 layer 2b).
        if (error instanceof DatabricksError && error.code === "PERMISSION_DENIED") throw new DatabricksError("STOP_NOT_PERMITTED", undefined, undefined, error.providerError)
        throw error
      }
    },

    // The submit is never retried after it may have reached the server (design §9).
    submit(request: StatementRequest, signal: AbortSignal): Promise<StatementAnswer> {
      return statements.submit(request, signal)
    },

    getStatement(account: string, statementId: string, signal: AbortSignal): Promise<StatementAnswer> {
      return statement(account, `/api/2.0/sql/statements/${encodeURIComponent(statementId)}`, toStatementAnswer, signal)
    },

    // The chunk endpoint answers the *result element's* fields at the top level, not a StatementResponse.
    getChunk(account: string, statementId: string, chunkIndex: number, signal: AbortSignal): Promise<ChunkAnswer> {
      return statement(account, `/api/2.0/sql/statements/${encodeURIComponent(statementId)}/result/chunks/${chunkIndex}`, toChunkAnswer, signal)
    },

    /** The design's asynchronous read: CONTINUE, then a poll at most once a second, cancelling on a stop (§9). */
    waitForStatement(account: string, statementId: string, wait: { readonly untilMs: number }, signal: AbortSignal): Promise<StatementAnswer> {
      return pollUntilDone(port, {
        account,
        statementId,
        untilMs: wait.untilMs,
        signal,
        ...(options.clock ? { now: options.clock.now } : {}),
      })
    },

    async cancelStatement(account: string, statementId: string, signal: AbortSignal): Promise<void> {
      await call(account, "sql.statements.cancel", "POST", `/api/2.0/sql/statements/${encodeURIComponent(statementId)}/cancel`, { body: {}, idempotent: true, signal })
    },

    async history(account: string, filter, signal: AbortSignal): Promise<Page<HistoryQuery>> {
      const query: Record<string, QueryValue> = {}
      if (filter.userIds?.length) query["filter_by.user_ids"] = filter.userIds
      if (filter.warehouseIds?.length) query["filter_by.warehouse_ids"] = filter.warehouseIds
      if (filter.statementIds?.length) query["filter_by.statement_ids"] = filter.statementIds
      if (filter.startMs !== undefined) query["filter_by.query_start_time_range.start_time_ms"] = filter.startMs
      if (filter.endMs !== undefined) query["filter_by.query_start_time_range.end_time_ms"] = filter.endMs
      if (filter.pageToken) query.pageToken = filter.pageToken
      // 1,000 rows a page is the API's cap (Query History [24]); the default is 100.
      query.max_results = Math.min(filter.maxResults ?? 100, 1000)
      // `metrics` (read bytes, result_from_cache) comes only when asked for, and the API asks for a small page with it.
      if (filter.includeMetrics === true) query.include_metrics = true
      const answer = record(await call(account, "sql.history.queries.list", "GET", "/api/2.0/sql/history/queries", { query, idempotent: true, signal }))
      const next = maybeText(answer.next_page_token)
      return { items: list(answer.res).map(toHistoryQuery), ...(next ? { nextPageToken: next } : {}) }
    },

    async listCatalogs(account: string, pageInput, signal: AbortSignal): Promise<Page<{ name: string; comment?: string; owner?: string }>> {
      const query: Record<string, QueryValue> = {}
      if (pageInput.pageToken) query.pageToken = pageInput.pageToken
      if (pageInput.maxResults !== undefined) query.max_results = pageInput.maxResults
      return page(await call(account, "unity-catalog.catalogs.list", "GET", "/api/2.1/unity-catalog/catalogs", { query, idempotent: true, signal }), "catalogs", (value) => {
        const item = record(value)
        return { name: text(item.name), ...(maybeText(item.comment) ? { comment: maybeText(item.comment) } : {}), ...(maybeText(item.owner) ? { owner: maybeText(item.owner) } : {}) }
      })
    },

    async listSchemas(account: string, catalog: string, pageInput, signal: AbortSignal): Promise<Page<{ name: string; comment?: string; owner?: string }>> {
      const query: Record<string, QueryValue> = { catalog_name: catalog }
      if (pageInput.pageToken) query.pageToken = pageInput.pageToken
      if (pageInput.maxResults !== undefined) query.max_results = pageInput.maxResults
      return page(await call(account, "unity-catalog.schemas.list", "GET", "/api/2.1/unity-catalog/schemas", { query, idempotent: true, signal }), "schemas", (value) => {
        const item = record(value)
        return { name: text(item.name), ...(maybeText(item.comment) ? { comment: maybeText(item.comment) } : {}), ...(maybeText(item.owner) ? { owner: maybeText(item.owner) } : {}) }
      })
    },

    async listTables(account: string, catalog: string, schema: string, pageInput, signal: AbortSignal): Promise<Page<{ name: string; tableType: string; comment?: string; owner?: string; updatedAt?: number }>> {
      const query: Record<string, QueryValue> = { catalog_name: catalog, schema_name: schema }
      if (pageInput.pageToken) query.pageToken = pageInput.pageToken
      if (pageInput.maxResults !== undefined) query.max_results = pageInput.maxResults
      return page(await call(account, "unity-catalog.tables.list", "GET", "/api/2.1/unity-catalog/tables", { query, idempotent: true, signal }), "tables", (value) => {
        const item = record(value)
        const updatedAt = count(item.updated_at)
        return {
          name: text(item.name),
          tableType: text(item.table_type),
          ...(maybeText(item.comment) ? { comment: maybeText(item.comment) } : {}),
          ...(maybeText(item.owner) ? { owner: maybeText(item.owner) } : {}),
          ...(updatedAt !== undefined ? { updatedAt } : {}),
        }
      })
    },

    async getTable(account: string, fullName: string, signal: AbortSignal): Promise<TableInfo> {
      return toTable(await call(account, "unity-catalog.tables.get", "GET", `/api/2.1/unity-catalog/tables/${encodeURIComponent(fullName)}`, { idempotent: true, signal }))
    },

    async listFunctions(account: string, catalog: string, schema: string, pageInput, signal: AbortSignal): Promise<Page<{ name: string; routineBody: string }>> {
      const query: Record<string, QueryValue> = { catalog_name: catalog, schema_name: schema }
      if (pageInput.pageToken) query.pageToken = pageInput.pageToken
      return page(await call(account, "unity-catalog.functions.list", "GET", "/api/2.1/unity-catalog/functions", { query, idempotent: true, signal }), "functions", (value) => {
        const item = record(value)
        return { name: text(item.name), routineBody: text(item.routine_body).toUpperCase() === "EXTERNAL" ? "EXTERNAL" : "SQL" }
      })
    },

    async getFunction(account: string, fullName: string, signal: AbortSignal): Promise<FunctionInfo> {
      return toFunction(await call(account, "unity-catalog.functions.get", "GET", `/api/2.1/unity-catalog/functions/${encodeURIComponent(fullName)}`, { idempotent: true, signal }))
    },

    /**
     * `GET /api/2.1/unity-catalog/models?catalog_name=&schema_name=` (`unity-catalog.registered-models.list`): every
     * page, because "clients must continue reading pages until next_page_token is absent", and a page may hold zero
     * models while still carrying a token
     * (https://docs.databricks.com/api/uc-registered-models/v1/list-registered-models.md). A 404 is `NOT_FOUND` and a
     * 403 `PERMISSION_DENIED`, as everywhere else in this client.
     */
    async listModels(account: string, catalog: string, schema: string, signal: AbortSignal): Promise<readonly { readonly name: string; readonly fullName?: string }[]> {
      const models: { name: string; fullName?: string }[] = []
      let pageToken: string | undefined
      for (let page = 0; page < MODEL_PAGES_MAX; page++) {
        const answer = record(
          await call(account, "unity-catalog.registered-models.list", "GET", "/api/2.1/unity-catalog/models", {
            query: { catalog_name: catalog, schema_name: schema, max_results: MODEL_PAGE, ...(pageToken === undefined ? {} : { pageToken }) },
            idempotent: true,
            signal,
          }),
        )
        for (const entry of list(answer.registered_models)) {
          const model = record(entry)
          const name = text(model.name)
          if (name === "") continue
          models.push({ name, ...(maybeText(model.full_name) ? { fullName: maybeText(model.full_name) } : {}) })
        }
        const next = maybeText(answer.next_page_token)
        if (next === undefined) return models
        pageToken = next
      }
      throw new DatabricksError("UNAVAILABLE", `Registered models in ${catalog}.${schema} have more than ${MODEL_PAGES_MAX * MODEL_PAGE} entries, more than this client reads in one call.`, "List them in Databricks, or narrow the schema.")
    },

    async listVolumes(account: string, catalog: string, schema: string, pageInput, signal: AbortSignal): Promise<Page<{ name: string; volumeType: string }>> {
      const query: Record<string, QueryValue> = { catalog_name: catalog, schema_name: schema }
      if (pageInput.pageToken) query.pageToken = pageInput.pageToken
      return page(await call(account, "unity-catalog.volumes.list", "GET", "/api/2.1/unity-catalog/volumes", { query, idempotent: true, signal }), "volumes", (value) => {
        const item = record(value)
        return { name: text(item.name), volumeType: text(item.volume_type) }
      })
    },

    async effectivePermissions(account: string, securable, signal: AbortSignal, principal?: string) {
      // The API names a securable type in upper case (TABLE, SCHEMA, CATALOG, FUNCTION, VOLUME…), pages, and takes
      // `principal` to narrow the assignments to one person or group.
      const assignments: { principal: string; privileges: string[] }[] = []
      let cursor: string | undefined
      do {
        const query: Record<string, QueryValue> = {}
        if (principal) query.principal = principal
        if (cursor) query.pageToken = cursor
        const body = record(
          await call(account, "unity-catalog.effective-permissions.get", "GET", `/api/2.1/unity-catalog/effective-permissions/${encodeURIComponent(securable.type.toUpperCase())}/${encodeURIComponent(securable.fullName)}`, {
            query,
            idempotent: true,
            signal,
          }),
        )
        for (const value of list(body.privilege_assignments)) {
          const assignment = record(value)
          assignments.push({
            principal: text(assignment.principal),
            privileges: list(assignment.privileges)
              .map((entry) => text(record(entry).privilege))
              .filter((privilege) => privilege !== ""),
          })
        }
        cursor = maybeText(body.next_page_token)
      } while (cursor !== undefined)
      return assignments
    },

    async listConnections(account: string, pageInput, signal: AbortSignal): Promise<Page<{ name: string; connectionType?: string }>> {
      const query: Record<string, QueryValue> = { max_results: 1000 }
      if (pageInput.pageToken) query.pageToken = pageInput.pageToken
      return page(await call(account, "unity-catalog.connections.list", "GET", "/api/2.1/unity-catalog/connections", { query, idempotent: true, signal }), "connections", (value) => {
        const item = record(value)
        return { name: text(item.name), ...(maybeText(item.connection_type) ? { connectionType: maybeText(item.connection_type) } : {}) }
      })
    },

    async currentMetastoreAssignment(account: string, signal: AbortSignal) {
      const item = record(await call(account, "unity-catalog.current-metastore-assignment.get", "GET", "/api/2.1/unity-catalog/current-metastore-assignment", { idempotent: true, signal }))
      return { ...(maybeText(item.default_catalog_name) ? { defaultCatalogName: maybeText(item.default_catalog_name) } : {}) }
    },

    async listTagAssignments(account: string, entity, signal: AbortSignal) {
      // The UC tag-assignment endpoint and its `tag_assignments[]` shape follow the port's types; its reference page was
      // not reachable when this was written, so a failure here leaves package C's DEPENDENCIES_UNKNOWN refusal in
      // place, which is the safe direction. Nothing is returned when the call fails.
      const body = record(
        await call(account, "unity-catalog.tag-assignments.list", "GET", "/api/2.1/unity-catalog/tag-assignments", {
          query: { entity_type: entity.type, entity_name: entity.fullName },
          idempotent: true,
          signal,
        }),
      )
      const column = entity.type === "columns" ? entity.fullName.split(".").at(-1) : undefined
      return list(body.tag_assignments)
        .map((value) => {
          const item = record(value)
          const key = text(item.tag_key)
          if (key === "") return undefined
          return { key, ...(maybeText(item.tag_value) ? { value: maybeText(item.tag_value) } : {}), ...(column ? { column } : {}) }
        })
        .filter((entry): entry is { key: string; value?: string; column?: string } => entry !== undefined)
    },

    listQueries(account: string, pageInput, signal: AbortSignal): Promise<Page<{ id: string; name: string; owner?: string; warehouseId?: string; queryText: string }>> {
      const query: Record<string, QueryValue> = { page_size: 100 }
      if (pageInput.pageToken) query.pageToken = pageInput.pageToken
      return oneAtATime(account, async () => page(await call(account, "sql.queries.list", "GET", "/api/2.0/sql/queries", { query, idempotent: true, signal }), "results", (value) => {
        const item = record(value)
        return {
          id: text(item.id),
          name: text(item.display_name),
          ...(maybeText(item.owner_user_name) ? { owner: maybeText(item.owner_user_name) } : {}),
          ...(maybeText(item.warehouse_id) ? { warehouseId: maybeText(item.warehouse_id) } : {}),
          queryText: text(item.query_text),
        }
      }))
    },

    getQuery(account: string, id: string, signal: AbortSignal) {
      return oneAtATime(account, async () => {
        const item = record(await call(account, "sql.queries.get", "GET", `/api/2.0/sql/queries/${encodeURIComponent(id)}`, { idempotent: true, signal }))
        return {
          id: text(item.id),
          name: text(item.display_name),
          ...(maybeText(item.warehouse_id) ? { warehouseId: maybeText(item.warehouse_id) } : {}),
          queryText: text(item.query_text),
        }
      })
    },

    async listJobs(account: string, pageInput, signal: AbortSignal): Promise<Page<{ jobId: number; name: string; creatorUserName?: string }>> {
      const query: Record<string, QueryValue> = {}
      if (pageInput.pageToken) query.pageToken = pageInput.pageToken
      if (pageInput.limit !== undefined) query.limit = pageInput.limit
      return page(await call(account, "jobs.jobs.list", "GET", "/api/2.2/jobs/list", { query, idempotent: true, signal }), "jobs", (value) => {
        const item = record(value)
        const settings = record(item.settings)
        return {
          jobId: count(item.job_id) ?? 0,
          name: maybeText(settings.name) ?? maybeText(item.name) ?? `job-${text(item.job_id)}`,
          ...(maybeText(item.creator_user_name) ? { creatorUserName: maybeText(item.creator_user_name) } : {}),
        }
      })
    },

    async listRuns(account: string, filter, signal: AbortSignal): Promise<Page<RunInfo>> {
      const query: Record<string, QueryValue> = {}
      if (filter.jobId !== undefined) query.job_id = filter.jobId
      if (filter.completedOnly !== undefined) query.completed_only = filter.completedOnly
      if (filter.startTimeFrom !== undefined) query.start_time_from = filter.startTimeFrom
      if (filter.startTimeTo !== undefined) query.start_time_to = filter.startTimeTo
      if (filter.pageToken) query.pageToken = filter.pageToken
      if (filter.limit !== undefined) query.limit = Math.min(filter.limit, 25)
      return page(await call(account, "jobs.runs.list", "GET", "/api/2.2/jobs/runs/list", { query, idempotent: true, signal }), "runs", toRun)
    },

    async getRun(account: string, runId: number, signal: AbortSignal) {
      const answer = record(await call(account, "jobs.runs.get", "GET", "/api/2.2/jobs/runs/get", { query: { run_id: runId }, idempotent: true, signal }))
      const run = toRun(answer)
      return {
        ...run,
        tasks: list(answer.tasks).map((value) => {
          const task = record(value)
          const state = record(task.state)
          const duration = count(task.execution_duration)
          const error = maybeText(record(task.state).state_message)
          return {
            taskKey: text(task.task_key),
            state: maybeText(state.result_state) ?? text(state.life_cycle_state),
            ...(duration !== undefined ? { durationMs: duration } : {}),
            ...(error ? { error } : {}),
          }
        }),
      }
    },

    async getRunOutput(account: string, runId: number, signal: AbortSignal) {
      const answer = record(await call(account, "jobs.runs.output.get", "GET", "/api/2.2/jobs/runs/get-output", { query: { run_id: runId }, idempotent: true, signal }))
      // A notebook task's result is the one output the API renders as text; a SQL task's output is a link.
      const output = maybeText(record(answer.notebook_output).result) ?? maybeText(answer.error) ?? maybeText(answer.logs)
      return { ...(output !== undefined ? { output } : {}), ...(answer.truncated === true ? { truncated: true } : {}) }
    },

    async runNow(account: string, input, signal: AbortSignal) {
      const answer = record(await call(account, "jobs.jobs.runNow", "POST", "/api/2.2/jobs/run-now", {
        body: {
          job_id: input.jobId,
          // Jobs API 2.2 run-now documents `job_parameters` ("Job-level parameters used in the run"), and no
          // `notebook_params`: https://docs.databricks.com/api/workspace/jobs/runnow (review of #7, M3).
          ...(input.params ? { job_parameters: input.params } : {}),
          idempotency_token: input.idempotencyToken,
        },
        idempotent: false,
        signal,
      }))
      return { runId: count(answer.run_id) ?? 0 }
    },

    async submitRun(account: string, input, signal: AbortSignal) {
      const answer = record(await call(account, "jobs.runs.submit", "POST", "/api/2.2/jobs/runs/submit", {
        body: {
          run_name: `opencode-${input.idempotencyToken.slice(0, 8)}`,
          tasks: [
            {
              task_key: "run",
              notebook_task: { notebook_path: input.notebookPath, ...(input.params ? { base_parameters: input.params } : {}) },
            },
          ],
          timeout_seconds: input.timeoutSeconds,
          idempotency_token: input.idempotencyToken,
        },
        idempotent: false,
        signal,
      }))
      return { runId: count(answer.run_id) ?? 0 }
    },

    async cancelRun(account: string, runId: number, signal: AbortSignal): Promise<void> {
      await call(account, "jobs.runs.cancel", "POST", "/api/2.2/jobs/runs/cancel", { body: { run_id: runId }, idempotent: true, signal })
    },

    async listWorkspace(account: string, path: string, signal: AbortSignal) {
      const body = record(await call(account, "workspace.objects.list", "GET", "/api/2.0/workspace/list", { query: { path }, idempotent: true, signal }))
      return list(body.objects).map((value) => {
        const item = record(value)
        const size = count(item.object_size)
        const modified = count(item.modified_at)
        return {
          path: text(item.path),
          objectType: text(item.object_type),
          ...(size !== undefined ? { size } : {}),
          ...(modified !== undefined ? { modifiedAt: modified } : {}),
        }
      })
    },

    async exportNotebook(account: string, path: string, signal: AbortSignal) {
      const body = record(await call(account, "workspace.objects.get", "GET", "/api/2.0/workspace/export", { query: { path, format: "SOURCE" }, idempotent: true, signal }))
      return { source: decodeBase64(text(body.content)) }
    },

    async listDirectory(account: string, path: string, signal: AbortSignal) {
      const body = record(await call(account, "files.directories.list", "GET", `/api/2.0/fs/directories/${encodedPath(path)}`, { idempotent: true, signal }))
      return list(body.contents).map((value) => {
        const item = record(value)
        const size = count(item.file_size)
        const modified = count(item.last_modified)
        return {
          path: text(item.path),
          isDirectory: item.is_directory === true,
          ...(size !== undefined ? { size } : {}),
          ...(modified !== undefined ? { modifiedAt: modified } : {}),
        }
      })
    },

    /** One external link's bytes: no workspace token, the account cloud's storage hosts only (design §8.2 step 2). */
    fetchLink(account: string, link, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
      return fetchLinkBytes(fetchImpl, link, options.auth.account(account).cloud, signal)
    },
  }

  return port
}
