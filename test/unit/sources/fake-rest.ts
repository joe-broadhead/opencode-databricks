/**
 * A strict fake of the three Databricks REST answers the sources read, at the port (no HTTP): Query History
 * `GET /api/2.0/sql/history/queries`, Jobs `GET /api/2.2/jobs/runs/list` and `GET /api/2.2/jobs/runs/get`, the Queries
 * API, SCIM `Me` and Statement Execution.
 *
 * The fixtures are the documented response objects' fields and the documentation's own example values, sanitised, plus
 * invented ids:
 *
 * - https://docs.databricks.com/api/workspace/queryhistory/list — `query_id`, `status`, `query_text`,
 *   `query_start_time_ms`, `query_end_time_ms`, `user_id`, `rows_produced`, `is_final`, `statement_type`,
 *   `warehouse_id`, `query_tags`, `duration`; newest started first; `max_results` at most 1,000; the start-time range at
 *   most 30 days; several statuses "is not recommended"; `filter_by.statement_ids` and `filter_by.warehouse_ids`.
 * - https://docs.databricks.com/api/jobs/v2/list-runs.md — `runs[]` `run_id`, `job_id`, `run_name`, `creator_user_name`,
 *   `state.life_cycle_state`, `state.result_state`, `start_time`, `end_time`, `trigger`, `run_type`; descending start;
 *   `limit` 1..25; `start_time_from`/`start_time_to`; `page_token`.
 * - https://docs.databricks.com/api/jobs/v2/get-run.md and /aws/en/jobs/monitor — run history kept 60 days.
 * - https://docs.databricks.com/api/queries/v1/list-queries.md — `id`, `name`, `query_text`, `warehouse_id`, `owner`.
 * - https://docs.databricks.com/api/scim/v1/me.md — `id`, `userName`, `displayName`.
 *
 * The fake **refuses what the real API would**: a range over 30 days, `max_results` over 1,000, a limit over 25, a job
 * that does not exist, a page token from another filter, an account the plugin is not signed in to. It never sleeps and
 * never reaches the network.
 */
import { DatabricksError } from "../../../src/domain/errors.js"
import type { HistoryQuery, RunInfo } from "../../../src/ports.js"

export const FAKE_HOST = "https://fake-workspace.cloud.databricks.com"
export const ME = { id: "6123456789012345", userName: "sam.rivera@example.com", displayName: "Sam Rivera" }

const DAY = 86_400_000

/** A documented Query History row: the fields of the list-queries example, with invented ids and a start `ago` ms back. */
export function historyQuery(input: { id: string; ago: number; start?: number; end?: number; status?: HistoryQuery["status"]; statementType?: string; warehouse?: string; user?: number; tags?: Record<string, string>; final?: boolean; rows?: number }): HistoryQuery {
  const start = input.start ?? 1_800_000_000_000 - input.ago
  const end = input.end ?? start + 3150
  return {
    queryId: input.id,
    status: input.status ?? "FINISHED",
    statementType: input.statementType ?? "SELECT",
    warehouseId: input.warehouse ?? "098765321fedcba",
    userId: input.user ?? Number(ME.id),
    queryStartTimeMs: start,
    queryEndTimeMs: end,
    durationMs: end - start,
    rowsProduced: input.rows ?? 12,
    isFinal: input.final ?? true,
    ...(input.tags ? { queryTags: input.tags } : {}),
    queryText: "SELECT region, SUM(amount) AS revenue FROM main.sales.orders GROUP BY region",
  }
}

/** A documented `runs/list` row: the documented object's fields, with invented ids and a start `ago` ms back. */
export function jobRun(input: { id: number; jobId?: number; ago: number; start?: number; end?: number; life?: string; result?: string; name?: string; creator?: string; trigger?: string; runType?: string }): RunInfo {
  const start = input.start ?? 1_800_000_000_000 - input.ago
  const end = input.end ?? start + 60_000
  return {
    runId: input.id,
    jobId: input.jobId ?? 11223344,
    runName: input.name ?? "nightly-orders",
    state: { lifeCycleState: input.life ?? "TERMINATED", ...(input.result === undefined ? {} : { resultState: input.result }) },
    startTime: start,
    endTime: end,
    creatorUserName: input.creator ?? "sam.rivera@example.com",
    triggerType: input.trigger ?? "PERIODIC",
    runType: input.runType ?? "JOB_RUN",
  }
}

export interface FakeRest {
  readonly answers: Record<string, (...args: unknown[]) => unknown>
  readonly calls: { method: string; args: unknown[] }[]
  /** Answer the next history call with a 429, as the API does under load. */
  failHistoryOnce(error: DatabricksError): void
  satisfyFilters: boolean
}

/**
 * The fake's answers. `history` and `runs` follow the documented ordering (newest first) and paging; everything else is
 * the one answer a source reads.
 */
export function fakeRest(seed: { readonly history?: readonly HistoryQuery[]; readonly runs?: readonly RunInfo[]; readonly saved?: readonly { id: string; name: string; queryText: string; warehouseId?: string; owner?: string }[] } = {}): FakeRest {
  const calls: { method: string; args: unknown[] }[] = []
  const history = [...(seed.history ?? [])]
  const runs = [...(seed.runs ?? [])]
  const saved = [...(seed.saved ?? [])]
  let historyFailure: DatabricksError | undefined
  const tokens = new Map<string, { kind: string; at: number }>()
  let token = 0
  const nextToken = (kind: string, at: number) => {
    const value = `pt-${++token}`
    tokens.set(value, { kind, at })
    return value
  }
  const takeToken = (value: string | undefined, kind: string): number => {
    if (value === undefined) return 0
    const held = tokens.get(value)
    if (held === undefined || held.kind !== kind) throw new DatabricksError("INPUT_INVALID", "The page token was not issued for this call.")
    return held.at
  }

  const answers = {
    me: () => ME,
    history: (_account: unknown, filter: unknown) => {
      calls.push({ method: "history", args: [filter] })
      if (historyFailure) {
        const failure = historyFailure
        historyFailure = undefined
        throw failure
      }
      const ask = filter as { userIds?: number[]; warehouseIds?: string[]; statementIds?: string[]; startMs?: number; endMs?: number; pageToken?: string; maxResults?: number }
      const startMs = ask.startMs ?? 0
      const endMs = ask.endMs ?? Number.MAX_SAFE_INTEGER
      if (startMs > endMs) throw new DatabricksError("INPUT_INVALID", "The start of the range is after its end.")
      if (endMs - startMs > 30 * DAY) throw new DatabricksError("INPUT_INVALID", "The time range must be less than or equal to 30 days.")
      const max = ask.maxResults ?? 100
      if (max < 1 || max > 1000) throw new DatabricksError("INPUT_INVALID", "max_results must be 1 to 1,000.")
      const offset = takeToken(ask.pageToken, "history")
      const mine = history
        .filter((query) => query.queryStartTimeMs >= startMs && query.queryStartTimeMs <= endMs)
        .filter((query) => ask.userIds === undefined || (query.userId !== undefined && ask.userIds.includes(query.userId)))
        .filter((query) => ask.warehouseIds === undefined || (query.warehouseId !== undefined && ask.warehouseIds.includes(query.warehouseId)))
        .filter((query) => ask.statementIds === undefined || ask.statementIds.includes(query.queryId))
        .sort((left, right) => right.queryStartTimeMs - left.queryStartTimeMs || (left.queryId < right.queryId ? 1 : -1))
      const page = mine.slice(offset, offset + max)
      const more = offset + max < mine.length
      return { items: page, ...(more ? { nextPageToken: nextToken("history", offset + max) } : {}) }
    },
    listRuns: (_account: unknown, filter: unknown) => {
      calls.push({ method: "listRuns", args: [filter] })
      const ask = filter as { jobId?: number; startTimeFrom?: number; startTimeTo?: number; pageToken?: string; limit?: number }
      if (ask.limit !== undefined && (ask.limit < 1 || ask.limit > 25)) throw new DatabricksError("INPUT_INVALID", "The limit must be 1 to 25.")
      const from = ask.startTimeFrom ?? 0
      const to = ask.startTimeTo ?? Number.MAX_SAFE_INTEGER
      if (from > to) throw new DatabricksError("INPUT_INVALID", "start_time_from is after start_time_to.")
      const offset = takeToken(ask.pageToken, `runs:${ask.jobId ?? "any"}`)
      const mine = runs
        .filter((run) => ask.jobId === undefined || run.jobId === ask.jobId)
        .filter((run) => run.startTime >= from && run.startTime <= to)
        .sort((left, right) => right.startTime - left.startTime || right.runId - left.runId)
      const page = mine.slice(offset, offset + (ask.limit ?? 20))
      const more = offset + (ask.limit ?? 20) < mine.length
      return { items: page, ...(more ? { nextPageToken: nextToken(`runs:${ask.jobId ?? "any"}`, offset + (ask.limit ?? 20)) } : {}) }
    },
    getRun: (_account: unknown, id: unknown) => {
      calls.push({ method: "getRun", args: [id] })
      const run = runs.find((item) => item.runId === Number(id))
      if (run === undefined) throw new DatabricksError("NOT_FOUND")
      return { ...run, tasks: [] }
    },
    getQuery: (_account: unknown, id: unknown) => {
      calls.push({ method: "getQuery", args: [id] })
      const query = saved.find((item) => item.id === id)
      if (query === undefined) throw new DatabricksError("NOT_FOUND")
      return query
    },
    listQueries: (_account: unknown) => {
      calls.push({ method: "listQueries", args: [] })
      return { items: saved }
    },
    getWarehouse: (_account: unknown, id: unknown) => {
      calls.push({ method: "getWarehouse", args: [id] })
      return { id, name: "small", state: "RUNNING", warehouseType: "PRO", serverless: true, clusterSize: "Small", autoStopMins: 10, minNumClusters: 1, maxNumClusters: 1 }
    },
    submit: () => {
      calls.push({ method: "submit", args: [] })
      return {
        statementId: "st-saved",
        state: "SUCCEEDED",
        manifest: { columns: [{ name: "region", typeName: "STRING", typeText: "STRING", position: 0 }, { name: "revenue", typeName: "DECIMAL", typeText: "DECIMAL(18,2)", position: 1 }], totalRowCount: 2 },
        rows: [
          ["North", "120.50"],
          ["South", "98.25"],
        ],
      }
    },
    getChunk: () => {
      calls.push({ method: "getChunk", args: [] })
      return { chunkIndex: 1, rows: [] }
    },
    getStatement: () => ({ statementId: "st-saved", state: "SUCCEEDED" }),
    fetchLink: () => Promise.reject(new DatabricksError("UNAVAILABLE")),
  } as Record<string, (...args: unknown[]) => unknown>

  return {
    answers,
    calls,
    satisfyFilters: true,
    failHistoryOnce(error: DatabricksError) {
      historyFailure = error
    },
  }
}
