/**
 * The documented API as a `DatabricksPort` (design §16's port), for package D's tests: it translates each port call into
 * the REST request the reference documents, hands it to `DocumentedApi` (which refuses anything the API would not
 * accept), and parses the documented response back into the port's types.
 *
 * This is a test double for package B's client (`src/process/`), not package B: the mapping here is the one the port's
 * own comments and the reference's field names describe, so a change in the documented shape breaks this file before it
 * can silently pass a test. Every call is recorded twice — as a port call in the harness, and as an `ApiRequest` here —
 * so a test can assert exactly what was sent (`idempotency_token` equal to the plan id, `timeout_seconds`, no extra
 * field at all).
 */
import type { DatabricksPort, HistoryQuery, RunInfo, StatementAnswer, StatementRequest } from "../../../../src/ports.js"
import type { DocumentedApi, DocRun, DocStatement } from "./api.js"

/** The parameter list as the Statement Execution API takes it: `{ name, value?, type? }`. */
const parameters = (list: StatementRequest["parameters"]) =>
  list?.map((parameter) => ({ name: parameter.name, ...(parameter.value === null ? {} : { value: parameter.value }), ...(parameter.type ? { type: parameter.type } : {}) }))

/** Query tags as the API takes them: `[{ key, value? }]` ("a sequence in excess of 20 query tags will be coerced to 20"). */
const tags = (record: Readonly<Record<string, string>>) => Object.entries(record).map(([key, value]) => ({ key, value }))

const toRunInfo = (run: DocRun): RunInfo => ({
  runId: run.run_id,
  ...(run.job_id === undefined ? {} : { jobId: run.job_id }),
  ...(run.run_name === undefined ? {} : { runName: run.run_name }),
  state: { lifeCycleState: run.state.life_cycle_state, ...(run.state.result_state === undefined ? {} : { resultState: run.state.result_state }) },
  startTime: run.start_time,
  ...(run.end_time === undefined ? {} : { endTime: run.end_time }),
  ...(run.run_type === undefined ? {} : { runType: run.run_type }),
  ...(run.trigger === undefined ? {} : { triggerType: run.trigger }),
  ...(run.creator_user_name === undefined ? {} : { creatorUserName: run.creator_user_name }),
})

const toRun = (run: DocRun): RunInfo & { tasks: readonly { taskKey: string; state: string; durationMs?: number; error?: string }[] } => ({
  ...toRunInfo(run),
  tasks: run.tasks.map((task) => ({
    taskKey: task.task_key,
    state: task.state.result_state ?? task.state.life_cycle_state,
    ...(task.run_duration === undefined ? {} : { durationMs: task.run_duration }),
    ...(task.state.state_message === undefined ? {} : { error: task.state.state_message }),
  })),
})

/** A documented `StatementResponse` as the port's `StatementAnswer`. */
export function toStatementAnswer(body: DocStatement): StatementAnswer {
  const status = body.status as { state?: string; error?: { error_code?: string; message?: string } } | undefined
  const manifest = body.manifest as
    | { format?: string; schema?: { columns?: readonly { name: string; type_name: string; type_text: string; position: number }[] }; total_row_count?: number; total_chunk_count?: number; truncated?: boolean }
    | undefined
  const result = body.result as { data_array?: readonly (readonly (string | null)[])[]; row_count?: number; chunk_index?: number } | undefined
  return {
    statementId: String(body.statement_id ?? ""),
    state: (status?.state ?? "PENDING") as StatementAnswer["state"],
    ...(status?.error
      ? { error: { ...(status.error.error_code ? { errorCode: status.error.error_code } : {}), ...(status.error.message ? { message: status.error.message } : {}), trust: "untrusted" as const } }
      : {}),
    ...(manifest
      ? {
          manifest: {
            columns: (manifest.schema?.columns ?? []).map((column) => ({ name: column.name, typeName: column.type_name, typeText: column.type_text, position: column.position })),
            ...(manifest.total_row_count === undefined ? {} : { totalRowCount: manifest.total_row_count }),
            ...(manifest.total_chunk_count === undefined ? {} : { totalChunkCount: manifest.total_chunk_count }),
            ...(manifest.truncated === undefined ? {} : { truncated: manifest.truncated }),
          },
        }
      : {}),
    ...(result?.data_array === undefined ? {} : { rows: result.data_array }),
  }
}

const toHistory = (record: Record<string, unknown>): HistoryQuery => {
  const tags = (record.query_tags ?? []) as readonly { key: string; value?: string }[]
  const metrics = record.metrics as { result_from_cache?: boolean; read_bytes?: number } | undefined
  return {
    queryId: String(record.query_id ?? ""),
    status: (record.status ?? "RUNNING") as HistoryQuery["status"],
    ...(record.statement_type === undefined ? {} : { statementType: String(record.statement_type) }),
    ...(record.warehouse_id === undefined ? {} : { warehouseId: String(record.warehouse_id) }),
    ...(typeof record.user_id === "number" ? { userId: record.user_id } : {}),
    ...(typeof record.executed_as_user_id === "number" ? { executedAsUserId: record.executed_as_user_id } : {}),
    queryStartTimeMs: Number(record.query_start_time_ms ?? 0),
    ...(typeof record.query_end_time_ms === "number" ? { queryEndTimeMs: record.query_end_time_ms } : {}),
    ...(typeof record.duration === "number" ? { durationMs: record.duration } : {}),
    ...(typeof record.rows_produced === "number" ? { rowsProduced: record.rows_produced } : {}),
    ...(metrics?.read_bytes === undefined ? {} : { readBytes: metrics.read_bytes }),
    ...(tags.length === 0 ? {} : { queryTags: Object.fromEntries(tags.map((tag) => [tag.key, tag.value ?? ""])) }),
    ...(record.query_text === undefined ? {} : { queryText: String(record.query_text) }),
    ...(typeof record.is_final === "boolean" ? { isFinal: record.is_final } : {}),
    ...(metrics?.result_from_cache === undefined ? {} : { resultFromCache: metrics.result_from_cache }),
    ...(record.cache_query_id === undefined ? {} : { cacheQueryId: String(record.cache_query_id) }),
  }
}

/** The methods of the port this fake answers from the documented API. Everything else comes from Day 0's port fake. */
export type DocumentedMethods = Pick<
  DatabricksPort,
  "listJobs" | "listRuns" | "getRun" | "getRunOutput" | "runNow" | "submitRun" | "cancelRun" | "listWorkspace" | "exportNotebook" | "listDirectory" | "submit" | "history" | "cancelStatement"
>

export function documentedMethods(api: DocumentedApi): DocumentedMethods {
  return {
    async listJobs(_account, page) {
      const answer = api.listJobs({ ...(page.limit === undefined ? {} : { limit: page.limit }), ...(page.pageToken === undefined ? {} : { page_token: page.pageToken }) })
      return { items: answer.jobs.map((job) => ({ jobId: job.job_id, name: job.settings.name, ...(job.creator_user_name ? { creatorUserName: job.creator_user_name } : {}) })), ...(answer.next_page_token ? { nextPageToken: answer.next_page_token } : {}) }
    },
    async listRuns(_account, filter) {
      const answer = api.listRuns({
        ...(filter.jobId === undefined ? {} : { job_id: filter.jobId }),
        ...(filter.limit === undefined ? {} : { limit: filter.limit }),
        ...(filter.pageToken === undefined ? {} : { page_token: filter.pageToken }),
        ...(filter.completedOnly === undefined ? {} : { completed_only: filter.completedOnly }),
      })
      return { items: answer.runs.map(toRunInfo), ...(answer.next_page_token ? { nextPageToken: answer.next_page_token } : {}) }
    },
    async getRun(_account, runId) {
      return toRun(api.getRun(runId))
    },
    async getRunOutput(_account, runId) {
      const answer = api.getRunOutput(runId)
      return { ...(answer.output === undefined ? {} : { output: answer.output }), ...(answer.logs_truncated ? { truncated: true } : {}) }
    },
    async runNow(_account, input) {
      const answer = api.runNow({ job_id: input.jobId, ...(input.params ? { job_parameters: input.params } : {}), idempotency_token: input.idempotencyToken })
      return { runId: answer.run_id }
    },
    async submitRun(_account, input) {
      const answer = api.submitRun({
        run_name: input.notebookPath.split("/").at(-1) ?? "notebook",
        idempotency_token: input.idempotencyToken,
        timeout_seconds: input.timeoutSeconds,
        tasks: [{ task_key: "notebook", notebook_task: { notebook_path: input.notebookPath, ...(input.params ? { base_parameters: input.params } : {}) } }],
      })
      return { runId: answer.run_id }
    },
    async cancelRun(_account, runId) {
      api.cancelRun(runId)
    },
    async listWorkspace(_account, path) {
      return api.workspaceList(path).objects.map((object) => ({ path: object.path, objectType: object.object_type }))
    },
    async exportNotebook(_account, path) {
      const answer = api.workspaceExport(path, "SOURCE")
      return { source: Buffer.from(answer.content, "base64").toString("utf8") }
    },
    async listDirectory(_account, path) {
      return api.filesList(path).contents.map((entry) => ({ path: entry.path, isDirectory: entry.is_directory, ...(entry.file_size === undefined ? {} : { size: entry.file_size }), ...(entry.last_modified === undefined ? {} : { modifiedAt: entry.last_modified }) }))
    },
    async submit(request, _signal) {
      const answer = api.executeStatement({
        statement: request.statement,
        warehouse_id: request.warehouseId,
        ...(request.catalog ? { catalog: request.catalog } : {}),
        ...(request.schema ? { schema: request.schema } : {}),
        ...(request.rowLimit === undefined ? {} : { row_limit: request.rowLimit }),
        ...(request.byteLimit === undefined ? {} : { byte_limit: request.byteLimit }),
        format: request.format,
        disposition: request.disposition,
        wait_timeout: `${request.waitTimeout}s`,
        on_wait_timeout: request.onWaitTimeout,
        ...(request.parameters ? { parameters: parameters(request.parameters) } : {}),
        query_tags: tags(request.queryTags),
      })
      return toStatementAnswer(answer)
    },
    async history(_account, filter) {
      const answer = api.history({
        ...(filter.statementIds ? { statementIds: filter.statementIds } : {}),
        ...(filter.warehouseIds ? { warehouseIds: filter.warehouseIds } : {}),
        ...(filter.maxResults === undefined ? {} : { maxResults: filter.maxResults }),
        ...(filter.includeMetrics === undefined ? {} : { includeMetrics: filter.includeMetrics }),
      })
      return { items: answer.res.map(toHistory), ...(answer.has_more ? { nextPageToken: "more" } : {}) }
    },
    async cancelStatement(_account, statementId) {
      api.cancelStatement(statementId)
    },
  }
}
