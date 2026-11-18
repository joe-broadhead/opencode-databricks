// A moving-clock fake of Query History and Jobs runs for the load simulations: statements and runs start, are visible
// while running (no end, not final), and become final at their end, as the documented APIs describe:
//
// - Query History (https://docs.databricks.com/api/workspace/queryhistory/list): filter by start time
//   (`query_start_time_range`, at most 30 days), user, warehouse and statement ids; "most recently started queries are
//   returned first"; `max_results` at most 1,000; `next_page_token`; running rows have no end and `is_final: false`.
// - Jobs `runs/list` (https://docs.databricks.com/api/workspace/jobs/listruns): `start_time_from`/`start_time_to`,
//   `job_id`; "in descending order by start time"; `limit` 1..25; `next_page_token`; active runs are listed too, with
//   `end_time` 0. `runs/get` answers one run, or NOT_FOUND.
//
// Rows show `visibleAfter` ms after they start, and final `finalAfter` ms after they end (the visibility lags, 0 by
// default). Page tokens are offsets bound to the filter that issued them. It never sleeps and never reaches the network.
import { DatabricksError } from "../../../src/domain/errors.js"
import type { HistoryQuery, RunInfo } from "../../../src/ports.js"
import { ME } from "./fake-rest.js"

const DAY = 86_400_000

export interface WorldItem {
  readonly id: string
  readonly start: number
  /** When it ends; undefined: still running at the end of the simulation. */
  end?: number
  readonly jobId?: number
  readonly warehouse?: string
}

export interface World {
  readonly answers: Record<string, (...args: unknown[]) => unknown>
  readonly calls: { method: string; args: unknown[] }[]
  add(item: WorldItem): void
  readonly items: WorldItem[]
  /** Calls per method since the last `resetCalls`. */
  count(method: string): number
}

export function world(now: () => number, options: { readonly visibleAfter?: number; readonly finalAfter?: number } = {}): World {
  const items: WorldItem[] = []
  const calls: { method: string; args: unknown[] }[] = []
  const visibleAfter = options.visibleAfter ?? 0
  const finalAfter = options.finalAfter ?? 0
  let tokens = 0
  const issued = new Map<string, { key: string; offset: number }>()
  const tokenFor = (key: string, offset: number) => {
    const token = `w${++tokens}`
    issued.set(token, { key, offset })
    return token
  }
  const offsetOf = (token: string | undefined, key: string) => {
    if (token === undefined) return 0
    const held = issued.get(token)
    if (held === undefined || held.key !== key) throw new DatabricksError("INPUT_INVALID", "The page token was not issued for this filter.")
    return held.offset
  }
  const visible = (item: WorldItem) => item.start + visibleAfter <= now()
  const isFinal = (item: WorldItem) => item.end !== undefined && item.end + finalAfter <= now()

  const asQuery = (item: WorldItem): HistoryQuery => {
    const final = isFinal(item)
    return {
      queryId: item.id,
      status: final ? "FINISHED" : "RUNNING",
      statementType: "SELECT",
      warehouseId: item.warehouse ?? "098765321fedcba",
      userId: Number(ME.id),
      queryStartTimeMs: item.start,
      ...(final ? { queryEndTimeMs: item.end!, durationMs: item.end! - item.start } : {}),
      rowsProduced: 1,
      isFinal: final,
    }
  }
  const asRun = (item: WorldItem): RunInfo => {
    const final = isFinal(item)
    return {
      runId: Number(item.id),
      jobId: item.jobId ?? 11223344,
      runName: "nightly-orders",
      state: final ? { lifeCycleState: "TERMINATED", resultState: "SUCCESS" } : { lifeCycleState: "RUNNING" },
      startTime: item.start,
      endTime: final ? item.end! : 0,
      creatorUserName: "sam.rivera@example.com",
      triggerType: "PERIODIC",
      runType: "JOB_RUN",
    }
  }
  const order = (left: WorldItem, right: WorldItem) => right.start - left.start || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0)

  const answers: Record<string, (...args: unknown[]) => unknown> = {
    me: () => ME,
    history: (_account: unknown, filter: unknown) => {
      calls.push({ method: "history", args: [filter] })
      const ask = filter as { userIds?: number[]; warehouseIds?: string[]; statementIds?: string[]; startMs?: number; endMs?: number; pageToken?: string; maxResults?: number }
      const from = ask.startMs ?? now() - 30 * DAY
      const to = ask.endMs ?? now()
      if (from > to) throw new DatabricksError("INPUT_INVALID", "The start of the range is after its end.")
      if (to - from > 30 * DAY) throw new DatabricksError("INPUT_INVALID", "The time range must be less than or equal to 30 days.")
      const max = ask.maxResults ?? 100
      if (max < 1 || max > 1000) throw new DatabricksError("INPUT_INVALID", "max_results must be 1 to 1,000.")
      const key = JSON.stringify({ ...ask, pageToken: undefined })
      const offset = offsetOf(ask.pageToken, key)
      const rows = items
        .filter((item) => item.jobId === undefined && visible(item) && item.start >= from && item.start <= to)
        .filter((item) => ask.userIds === undefined || ask.userIds.includes(Number(ME.id)))
        .filter((item) => ask.warehouseIds === undefined || ask.warehouseIds.includes(item.warehouse ?? "098765321fedcba"))
        .filter((item) => ask.statementIds === undefined || ask.statementIds.includes(item.id))
        .sort(order)
      const page = rows.slice(offset, offset + max).map(asQuery)
      return { items: page, ...(offset + max < rows.length ? { nextPageToken: tokenFor(key, offset + max) } : {}) }
    },
    listRuns: (_account: unknown, filter: unknown) => {
      calls.push({ method: "listRuns", args: [filter] })
      const ask = filter as { jobId?: number; startTimeFrom?: number; startTimeTo?: number; pageToken?: string; limit?: number }
      const limit = ask.limit ?? 20
      if (limit < 1 || limit > 25) throw new DatabricksError("INPUT_INVALID", "The limit must be 1 to 25.")
      const from = ask.startTimeFrom ?? 0
      const to = ask.startTimeTo ?? Number.MAX_SAFE_INTEGER
      if (from > to) throw new DatabricksError("INPUT_INVALID", "start_time_from is after start_time_to.")
      const key = JSON.stringify({ ...ask, pageToken: undefined })
      const offset = offsetOf(ask.pageToken, key)
      const rows = items
        .filter((item) => item.jobId !== undefined && visible(item) && item.start >= from && item.start <= to)
        .filter((item) => ask.jobId === undefined || item.jobId === ask.jobId)
        .sort(order)
      const page = rows.slice(offset, offset + limit).map(asRun)
      return { items: page, ...(offset + limit < rows.length ? { nextPageToken: tokenFor(key, offset + limit) } : {}) }
    },
    getRun: (_account: unknown, id: unknown) => {
      calls.push({ method: "getRun", args: [id] })
      const item = items.find((entry) => entry.jobId !== undefined && Number(entry.id) === Number(id) && visible(entry))
      if (item === undefined) throw new DatabricksError("NOT_FOUND")
      return { ...asRun(item), tasks: [] }
    },
  }
  return {
    answers,
    calls,
    items,
    add: (item) => void items.push(item),
    count: (method) => calls.filter((entry) => entry.method === method).length,
  }
}
