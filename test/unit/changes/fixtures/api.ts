/**
 * A fake Databricks API that knows only the **documented** shapes, for package D's tests. Every call is checked against
 * `fixtures/jobs.ts` and `fixtures/workspace.ts` before it is answered:
 *
 * - the method and path must be the documented one (a wrong method is refused, not ignored);
 * - a body field outside the documented set, or a missing required one, is refused;
 * - a documented constraint is enforced: `idempotency_token` at most 64 characters, `tasks` at most 100, `list`
 *   `limit` in `[1..100]`, `runs/list` `limit` in `[1..25]`, `wait_timeout` of `0` or `5..50`, a `format` of
 *   `JSON_ARRAY`/`ARROW_STREAM`/`CSV`, a `disposition` of `INLINE`/`EXTERNAL_LINKS`, `query_tags` an array of
 *   `{key, value?}` with at most 20 entries;
 * - a query parameter the page does not document is refused, and a required one must be there.
 *
 * A wrong request is recorded in `rejections` and thrown as `Rejected`, so a test fails loudly instead of silently
 * getting a plausible answer — the trap the reviews of the other packages found in invented fixtures.
 *
 * The **values** here are invented, like every fixture in this repository; the **shapes** are the reference's, and each
 * one cites its page in `jobs.ts` / `workspace.ts`.
 */
import {
  CANCEL_RUN,
  CANCEL_RUN_RESPONSE,
  GET_RUN,
  GET_RUN_OUTPUT,
  GET_RUN_OUTPUT_RESPONSE,
  IDEMPOTENCY_TOKEN_MAX,
  LIST_JOBS,
  LIST_JOBS_LIMIT_MAX,
  LIST_RUNS,
  LIST_RUNS_LIMIT_MAX,
  NOTEBOOK_TASK_FIELDS,
  RUN_NOW,
  RUN_NOW_RESPONSE,
  SUBMIT_RUN,
  SUBMIT_RUN_RESPONSE,
  SUBMIT_RUN_TASK_FIELDS,
  SUBMIT_RUN_TASKS_MAX,
  type Fixture,
} from "./jobs.js"
import {
  CANCEL_STATEMENT,
  DISPOSITIONS,
  EXECUTE_STATEMENT,
  FILES_LIST_DIRECTORY,
  QUERY_HISTORY,
  QUERY_HISTORY_MAX_RESULTS,
  WAIT_TIMEOUT,
  WORKSPACE_EXPORT,
  WORKSPACE_EXPORT_FORMATS,
  WORKSPACE_LIST,
} from "./workspace.js"

/** A request the documented API would not accept. */
export class Rejected extends Error {
  constructor(readonly why: string) {
    super(why)
    this.name = "Rejected"
  }
}

/** One run, in the documented shape (`GET /api/2.2/jobs/runs/get`). */
export interface DocRun {
  readonly run_id: number
  readonly job_id?: number
  readonly run_name?: string
  /** `creator_user_name`: "The creator user name" (`GET /api/2.2/jobs/runs/get`). */
  readonly creator_user_name?: string
  readonly run_type?: string
  readonly trigger?: string
  readonly state: { readonly life_cycle_state: string; readonly result_state?: string; readonly state_message?: string }
  readonly start_time: number
  readonly end_time?: number
  readonly tasks: readonly {
    readonly task_key: string
    readonly state: { readonly life_cycle_state: string; readonly result_state?: string; readonly state_message?: string }
    readonly start_time?: number
    readonly end_time?: number
    readonly run_duration?: number
  }[]
}

/** A statement's answer, in the documented `StatementResponse` shape. */
export type DocStatement = Record<string, unknown>

export interface ApiState {
  readonly jobs: Map<number, { readonly name: string; readonly creator?: string }>
  readonly runs: Map<number, DocRun>
  /** Workspace object listings by directory path, as `GET /api/2.0/workspace/list` answers them. */
  readonly workspace: Map<string, readonly { readonly path: string; readonly object_type: string; readonly object_id?: number; readonly language?: string }[]>
  /** Notebook source by path, exported as `format=SOURCE` through `GET /api/2.0/workspace/export`. */
  readonly notebooks: Map<string, string>
  /** Files API listings by directory path. */
  readonly directories: Map<string, readonly { readonly path: string; readonly is_directory: boolean; readonly file_size?: number; readonly last_modified?: number }[]>
  /** Statement answers by statement text, or one answer for everything. */
  readonly statements: Map<string, DocStatement | ((statement: string) => DocStatement)>
  readonly history: readonly Record<string, unknown>[]
}

export interface ApiRequest {
  readonly method: string
  readonly path: string
  readonly query: Readonly<Record<string, string>>
  readonly body?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

const numberIn = (value: unknown, min: number, max?: number): boolean => Number.isSafeInteger(value) && (value as number) >= min && (max === undefined || (value as number) <= max)

export class DocumentedApi {
  readonly requests: ApiRequest[] = []
  readonly rejections: string[] = []
  /** `run_id` per `idempotency_token`, as the Jobs API documents: one run for one token, ever. */
  readonly idempotency = new Map<string, number>()
  private nextRunId = 455_644_834
  /** Statement ids in the order they were executed, so a history record can name one. */
  readonly executed: string[] = []
  /** The answer Query History gives for a statement: `DELETE` unless a test says otherwise. */
  statementType = "DELETE"

  constructor(readonly state: ApiState) {}

  /** Every request that reached the fake, by `METHOD path`. */
  paths(): string[] {
    return this.requests.map((request) => `${request.method} ${request.path}`)
  }

  mustNotReject(): void {
    if (this.rejections.length > 0) throw new Error(`the fake rejected documented-shape requests: ${this.rejections.join(" | ")}`)
  }

  private reject(why: string): never {
    this.rejections.push(why)
    throw new Rejected(why)
  }

  /** Records a request outside every documented route, for a caller that answers 404 instead of throwing. */
  note(why: string): void {
    this.rejections.push(why)
  }

  /**
   * Records the call, then checks the method, the path and every field against the documented fixture. Public so a test
   * can prove the fake refuses a wrong method, a wrong path and an unknown field — not only the calls a tool happens to
   * make.
   */
  checkRoute(fixture: Fixture, method: string, path: string, query: Readonly<Record<string, string>>, body?: unknown): void {
    this.requests.push({ method, path, query, ...(body === undefined ? {} : { body }) })
    if (method !== fixture.method) this.reject(`${method} ${path} is not ${fixture.method} ${fixture.path} (${fixture.cite})`)
    const pattern = new RegExp(`^${fixture.path.replace(/\{[^}]+\}/gu, ".+")}$`, "u")
    if (!pattern.test(path)) this.reject(`${path} is not ${fixture.path} (${fixture.cite})`)
    for (const name of Object.keys(query)) if (!(fixture.query ?? []).includes(name)) this.reject(`${fixture.path} has no query parameter ${name} (${fixture.cite})`)
    for (const name of fixture.queryRequired ?? []) if (query[name] === undefined) this.reject(`${fixture.path} needs query parameter ${name} (${fixture.cite})`)
    if (body !== undefined) {
      if (!isRecord(body)) this.reject(`${fixture.path} takes a JSON object body (${fixture.cite})`)
      const allowed = new Set([...(fixture.required ?? []), ...(fixture.optional ?? [])])
      for (const name of Object.keys(body)) if (!allowed.has(name)) this.reject(`${fixture.path} has no field ${name} (${fixture.cite})`)
      for (const name of fixture.required ?? []) if (body[name] === undefined) this.reject(`${fixture.path} needs ${name} (${fixture.cite})`)
    }
  }

  private tokenOf(body: Record<string, unknown>): string | undefined {
    const token = body.idempotency_token
    if (token === undefined) return undefined
    if (typeof token !== "string" || token.length === 0) this.reject("idempotency_token is a string")
    if ((token as string).length > IDEMPOTENCY_TOKEN_MAX) this.reject(`idempotency_token is longer than ${IDEMPOTENCY_TOKEN_MAX} characters (${RUN_NOW.cite})`)
    return token as string
  }

  private runIdFor(token: string | undefined, make: () => number): number {
    if (token === undefined) return make()
    const existing = this.idempotency.get(token)
    if (existing !== undefined) return existing
    const runId = make()
    this.idempotency.set(token, runId)
    return runId
  }

  /** `POST /api/2.2/jobs/run-now` */
  runNow(body: Record<string, unknown>): { run_id: number; number_in_job: number } {
    this.checkRoute(RUN_NOW, "POST", RUN_NOW.path, {}, body)
    if (!numberIn(body.job_id, 1)) this.reject("job_id is an int64 (run-now)")
    const token = this.tokenOf(body)
    const runId = this.runIdFor(token, () => this.nextRunId++)
    return { ...RUN_NOW_RESPONSE, run_id: runId, number_in_job: runId }
  }

  /** `POST /api/2.2/jobs/runs/submit` */
  submitRun(body: Record<string, unknown>): { run_id: number } {
    this.checkRoute(SUBMIT_RUN, "POST", SUBMIT_RUN.path, {}, body)
    const token = this.tokenOf(body)
    if (body.timeout_seconds !== undefined && !numberIn(body.timeout_seconds, 0)) this.reject("timeout_seconds is an int32 at or above 0 (submit-run)")
    if (body.tasks !== undefined) {
      if (!Array.isArray(body.tasks) || body.tasks.length > SUBMIT_RUN_TASKS_MAX) this.reject(`tasks is an array of at most ${SUBMIT_RUN_TASKS_MAX} items (submit-run)`)
      for (const task of body.tasks) {
        if (!isRecord(task)) this.reject("a task is a JSON object (submit-run)")
        for (const name of Object.keys(task)) if (!(SUBMIT_RUN_TASK_FIELDS as readonly string[]).includes(name)) this.reject(`a task has no field ${name} (submit-run)`)
        if (typeof task.task_key !== "string" || task.task_key.length === 0) this.reject("a task needs task_key (submit-run)")
        if (task.notebook_task !== undefined) {
          if (!isRecord(task.notebook_task)) this.reject("notebook_task is a JSON object (submit-run)")
          for (const name of Object.keys(task.notebook_task)) if (!(NOTEBOOK_TASK_FIELDS as readonly string[]).includes(name)) this.reject(`notebook_task has no field ${name} (submit-run)`)
          if (typeof task.notebook_task.notebook_path !== "string") this.reject("notebook_task needs notebook_path (submit-run)")
        }
      }
    }
    const runId = this.runIdFor(token, () => this.nextRunId++)
    return { ...SUBMIT_RUN_RESPONSE, run_id: runId }
  }

  /** `GET /api/2.2/jobs/runs/get` */
  getRun(runId: number): DocRun {
    this.checkRoute(GET_RUN, "GET", GET_RUN.path, { run_id: String(runId) })
    if (!numberIn(runId, 1)) this.reject("run_id is an int64 (get-run)")
    const run = this.state.runs.get(runId)
    if (!run) this.reject(`no run ${runId}`)
    return run
  }

  /** `POST /api/2.2/jobs/runs/cancel` */
  cancelRun(runId: number): Record<string, never> {
    this.checkRoute(CANCEL_RUN, "POST", CANCEL_RUN.path, {}, { run_id: runId })
    if (!numberIn(runId, 1)) this.reject("run_id is an int64 (cancel-run)")
    return CANCEL_RUN_RESPONSE
  }

  /** `GET /api/2.2/jobs/list` */
  listJobs(query: { readonly limit?: number; readonly page_token?: string }): { jobs: { job_id: number; creator_user_name?: string; settings: { name: string } }[]; next_page_token?: string } {
    const params: Record<string, string> = {}
    if (query.limit !== undefined) params.limit = String(query.limit)
    if (query.page_token !== undefined) params.page_token = query.page_token
    this.checkRoute(LIST_JOBS, "GET", LIST_JOBS.path, params)
    if (query.limit !== undefined && !numberIn(query.limit, 1, LIST_JOBS_LIMIT_MAX)) this.reject(`limit is 1 to ${LIST_JOBS_LIMIT_MAX} (list-jobs)`)
    const limit = query.limit ?? 20
    const all = [...this.state.jobs.entries()].map(([jobId, job]) => ({ job_id: jobId, ...(job.creator ? { creator_user_name: job.creator } : {}), settings: { name: job.name } }))
    const start = query.page_token ? Number(query.page_token) : 0
    return { jobs: all.slice(start, start + limit), ...(start + limit < all.length ? { next_page_token: String(start + limit) } : {}) }
  }

  /** `GET /api/2.2/jobs/runs/list` — "descending order by start time". */
  listRuns(query: { readonly job_id?: number; readonly limit?: number; readonly page_token?: string; readonly completed_only?: boolean }): { runs: DocRun[]; next_page_token?: string; has_more?: boolean } {
    const params: Record<string, string> = {}
    if (query.job_id !== undefined) params.job_id = String(query.job_id)
    if (query.limit !== undefined) params.limit = String(query.limit)
    if (query.page_token !== undefined) params.page_token = query.page_token
    if (query.completed_only !== undefined) params.completed_only = String(query.completed_only)
    this.checkRoute(LIST_RUNS, "GET", LIST_RUNS.path, params)
    if (query.limit !== undefined && !numberIn(query.limit, 1, LIST_RUNS_LIMIT_MAX)) this.reject(`limit is 1 to ${LIST_RUNS_LIMIT_MAX} (list-runs)`)
    const limit = query.limit ?? 20
    const all = [...this.state.runs.values()]
      .filter((run) => query.job_id === undefined || run.job_id === query.job_id)
      .sort((left, right) => right.start_time - left.start_time)
    const start = query.page_token ? Number(query.page_token) : 0
    const page = all.slice(start, start + limit)
    return { runs: page, ...(start + limit < all.length ? { next_page_token: String(start + limit), has_more: true } : { has_more: false }) }
  }

  /** `GET /api/2.2/jobs/runs/get-output` */
  getRunOutput(runId: number): typeof GET_RUN_OUTPUT_RESPONSE {
    this.checkRoute(GET_RUN_OUTPUT, "GET", GET_RUN_OUTPUT.path, { run_id: String(runId) })
    if (!this.state.runs.has(runId)) this.reject(`no run ${runId}`)
    return GET_RUN_OUTPUT_RESPONSE
  }

  /** `GET /api/2.0/workspace/list` */
  workspaceList(path: string): { objects: readonly { readonly path: string; readonly object_type: string; readonly object_id?: number; readonly language?: string }[] } {
    this.checkRoute(WORKSPACE_LIST, "GET", WORKSPACE_LIST.path, { path })
    const objects = this.state.workspace.get(path)
    if (objects) return { objects }
    // "Lists the contents of a directory, or the object if it is not a directory."
    if (this.state.notebooks.has(path)) return { objects: [{ path, object_type: "NOTEBOOK", object_id: 1 }] }
    this.reject(`no workspace folder ${path}`)
  }

  /** `GET /api/2.0/workspace/export` with `format=SOURCE` */
  workspaceExport(path: string, format: string): { content: string; file_type: string } {
    this.checkRoute(WORKSPACE_EXPORT, "GET", WORKSPACE_EXPORT.path, { path, format })
    if (!(WORKSPACE_EXPORT_FORMATS as readonly string[]).includes(format)) this.reject(`format is one of ${WORKSPACE_EXPORT_FORMATS.join(", ")} (export)`)
    const source = this.state.notebooks.get(path)
    if (source === undefined) this.reject(`no notebook ${path}`)
    return { content: Buffer.from(source!, "utf8").toString("base64"), file_type: "py" }
  }

  /** `GET /api/2.0/fs/directories{directory_path}` */
  filesList(path: string, query: { readonly page_size?: number; readonly page_token?: string } = {}): { contents: readonly { readonly path: string; readonly is_directory: boolean; readonly file_size?: number; readonly last_modified?: number }[]; next_page_token?: string } {
    const params: Record<string, string> = {}
    if (query.page_size !== undefined) params.page_size = String(query.page_size)
    if (query.page_token !== undefined) params.page_token = query.page_token
    this.checkRoute(FILES_LIST_DIRECTORY, "GET", `/api/2.0/fs/directories${path}`, params)
    const contents = this.state.directories.get(path)
    if (!contents) this.reject(`no volume directory ${path}`)
    return { contents: contents! }
  }

  /** `POST /api/2.0/sql/statements` */
  executeStatement(body: Record<string, unknown>): DocStatement {
    this.checkRoute(EXECUTE_STATEMENT, "POST", EXECUTE_STATEMENT.path, {}, body)
    if (typeof body.statement !== "string" || body.statement.length === 0) this.reject("statement is a non-empty string (execute-statement)")
    if (typeof body.warehouse_id !== "string") this.reject("warehouse_id is a string (execute-statement)")
    if (body.disposition !== undefined && !(DISPOSITIONS as readonly string[]).includes(String(body.disposition))) this.reject(`disposition is one of ${DISPOSITIONS.join(", ")} (execute-statement)`)
    if (body.format !== undefined && !["JSON_ARRAY", "ARROW_STREAM", "CSV"].includes(String(body.format))) this.reject("format is JSON_ARRAY, ARROW_STREAM or CSV (execute-statement)")
    if (body.wait_timeout !== undefined) {
      const match = /^(\d+)s$/u.exec(String(body.wait_timeout))
      if (!match) this.reject('wait_timeout is "Ns" (execute-statement)')
      const seconds = Number(match![1])
      if (!(WAIT_TIMEOUT.zeroAllowed && seconds === 0) && !(seconds >= WAIT_TIMEOUT.min && seconds <= WAIT_TIMEOUT.max)) this.reject(`wait_timeout is 0 or ${WAIT_TIMEOUT.min}..${WAIT_TIMEOUT.max} seconds (execute-statement)`)
    }
    if (body.on_wait_timeout !== undefined && !["CONTINUE", "CANCEL"].includes(String(body.on_wait_timeout))) this.reject("on_wait_timeout is CONTINUE or CANCEL (execute-statement)")
    if (body.parameters !== undefined) {
      if (!Array.isArray(body.parameters)) this.reject("parameters is an array (execute-statement)")
      for (const parameter of body.parameters) {
        if (!isRecord(parameter)) this.reject("a parameter is an object (execute-statement)")
        for (const name of Object.keys(parameter)) if (!["name", "value", "type"].includes(name)) this.reject(`a parameter has no field ${name} (execute-statement)`)
        if (typeof parameter.name !== "string") this.reject("a parameter needs name (execute-statement)")
      }
    }
    if (body.query_tags !== undefined) {
      if (!Array.isArray(body.query_tags) || body.query_tags.length > 20) this.reject("query_tags is an array of at most 20 tags (execute-statement)")
      for (const tag of body.query_tags) {
        if (!isRecord(tag) || typeof tag.key !== "string") this.reject("a query tag is { key, value? } (execute-statement)")
        for (const name of Object.keys(tag)) if (!["key", "value"].includes(name)) this.reject(`a query tag has no field ${name} (execute-statement)`)
      }
    }
    if (body.row_limit !== undefined && !numberIn(body.row_limit, 0)) this.reject("row_limit is an int64 (execute-statement)")
    if (body.byte_limit !== undefined && !numberIn(body.byte_limit, 0)) this.reject("byte_limit is an int64 (execute-statement)")
    const answer = this.state.statements.get(String(body.statement)) ?? [...this.state.statements.values()].find((value) => typeof value === "function")
    const body0 = typeof answer === "function" ? answer(String(body.statement)) : answer
    const statementId = String((body0 as { statement_id?: string }).statement_id ?? "")
    if (statementId) this.executed.push(statementId)
    return body0 as DocStatement
  }

  /** `POST /api/2.0/sql/statements/{id}/cancel`: Databricks accepts the id "of the statement" to cancel. */
  cancelStatement(statementId: string): void {
    this.checkRoute(CANCEL_STATEMENT, "POST", `/api/2.0/sql/statements/${statementId}/cancel`, {}, {})
  }

  /** `GET /api/2.0/sql/history/queries` */
  history(query: { readonly statementIds?: readonly string[]; readonly warehouseIds?: readonly string[]; readonly maxResults?: number; readonly includeMetrics?: boolean }): { res: readonly Record<string, unknown>[]; has_more: boolean } {
    const params: Record<string, string> = {}
    if (query.maxResults !== undefined) params.max_results = String(query.maxResults)
    if (query.includeMetrics !== undefined) params.include_metrics = String(query.includeMetrics)
    if (query.statementIds !== undefined) params.filter_by = `statement_ids=${query.statementIds.join(",")}`
    if (query.warehouseIds !== undefined) params.filter_by = `${params.filter_by ?? ""}warehouse_ids=${query.warehouseIds.join(",")}`
    this.checkRoute(QUERY_HISTORY, "GET", QUERY_HISTORY.path, params)
    if (query.maxResults !== undefined && !numberIn(query.maxResults, 1, QUERY_HISTORY_MAX_RESULTS)) this.reject(`max_results is 1 to ${QUERY_HISTORY_MAX_RESULTS} (list-queries)`)
    const records = this.state.history.filter((record) => {
      if (query.statementIds !== undefined && !query.statementIds.includes(String(record.query_id))) return false
      if (query.warehouseIds !== undefined && !query.warehouseIds.includes(String(record.warehouse_id))) return false
      return true
    })
    const limit = query.maxResults ?? 100
    return { res: records.slice(0, limit), has_more: records.length > limit }
  }
}

/** A history record in the documented `QueryInfo` shape, for a statement this fake ran. */
export function historyRecord(input: { readonly statementId: string; readonly statementType?: string; readonly userId?: number; readonly warehouseId?: string; readonly status?: string }): Record<string, unknown> {
  return {
    query_id: input.statementId,
    status: input.status ?? "FINISHED",
    statement_type: input.statementType ?? "DELETE",
    warehouse_id: input.warehouseId ?? "wh-small",
    user_id: input.userId ?? 42,
    query_start_time_ms: 1_763_400_000_000,
    query_end_time_ms: 1_763_400_001_400,
    duration: 1400,
    rows_produced: 3,
    is_final: true,
  }
}
