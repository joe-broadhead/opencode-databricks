import { describe, expect, it } from "vitest"
import { eventsList } from "../../src/handlers/sources/index.js"
import type { EventsListResult } from "@we-the-rebel-alliance/plugin-contract/events"
import { memoryRecords, useRecords } from "../../src/handlers/sources/records.js"
import { loadOptions } from "../../src/options.js"
import type { Deps } from "../../src/handlers/deps.js"
import type { HistoryQuery, RunInfo } from "../../src/ports.js"

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0)
const END = NOW - 60 * 60_000
const HOST = "https://dbc-1.cloud.databricks.com"

const query = (id: string): HistoryQuery => ({
  queryId: id,
  status: "FINISHED",
  statementType: "SELECT",
  warehouseId: "wh-small",
  userId: 42,
  userName: "ana@example.com",
  queryStartTimeMs: END - 1_000,
  queryEndTimeMs: END,
  isFinal: true,
  rowsProduced: 1,
})

const run = (id: number): RunInfo => ({
  runId: id,
  jobId: 7,
  runName: "nightly",
  state: { lifeCycleState: "TERMINATED", resultState: "SUCCESS" },
  startTime: END - 1_000,
  endTime: END,
  creatorUserName: "ana@example.com",
})

const QUERIES = [query("q-a"), query("q-b")]
const RUNS = [run(101), run(102)]

function deps(source: "queries" | "runs"): Deps {
  const base = {
    options: loadOptions({}),
    auth: {
      account: () => ({ alias: "work", mode: "pat", host: HOST, cloud: "aws", features: [], enforcement: "identity" }),
      accounts: () => [],
      token: async () => ({ accessToken: "x", expiresAt: 0, scopes: [], host: HOST }),
    },
    databricks: {
      me: async () => ({ id: "42", userName: "ana@example.com", displayName: "Ana" }),
      history: async (_account: string, filter: { startMs?: number; endMs?: number }) => ({
        items: QUERIES.filter((item) => item.queryStartTimeMs >= (filter.startMs ?? 0) && item.queryStartTimeMs <= (filter.endMs ?? Number.MAX_SAFE_INTEGER)),
      }),
      listRuns: async (_account: string, filter: { startTimeFrom?: number; startTimeTo?: number }) => ({
        items: RUNS.filter((item) => item.startTime >= (filter.startTimeFrom ?? 0) && item.startTime <= (filter.startTimeTo ?? Number.MAX_SAFE_INTEGER)),
      }),
      getRun: async (_account: string, id: number) => RUNS.find((item) => item.runId === id)!,
    },
    reads: { prepare: async () => { throw new Error("not used") } },
    ledger: { totals: async () => ({ startsToday: 0, dbuHoursToday: 0, startsSession: 0, dbuHoursSession: 0, estimate: true }), charge: async () => ({ recorded: true, totals: { startsToday: 0, dbuHoursToday: 0, startsSession: 0, dbuHoursSession: 0, estimate: true } }), starts: async () => [] },
    clock: { now: () => NOW, uuid: () => "id" },
  }
  useRecords(base, memoryRecords([{ account: "work", host: HOST, record: { userId: "42", userName: "ana@example.com", at: NOW } }]))
  void source
  return base as unknown as Deps
}

const call = { sessionID: "s", agent: "a", messageID: "m", id: "c", signal: new AbortController().signal, account: "work" }

async function both(source: "queries" | "runs", expected: readonly string[]) {
  const d = deps(source)
  const first = (await eventsList({ source, account: "work", since: new Date(NOW - 2 * 60 * 60_000).toISOString(), limit: 1 }, call, d)) as EventsListResult
  const second = (await eventsList({ source, account: "work", cursor: first.cursor, limit: 1 }, call, d)) as EventsListResult
  const ids = [...first.events, ...second.events].map((event) => event.external_id)
  expect(ids).toHaveLength(expected.length)
  expect(new Set(ids).size).toBe(expected.length)
  expect([...ids].sort()).toEqual([...expected].sort())
  expect(first.gap).toBeUndefined()
  expect(second.gap).toBeUndefined()
}

describe("a same-timestamp page boundary", () => {
  it("queries: both statements with one occurred_at are listed once across the pages", async () => {
    await both("queries", QUERIES.map((item) => `${HOST.replace(/^https:\/\//u, "")}:${item.queryId}`))
  })

  it("runs: both runs with one occurred_at are listed once across the pages", async () => {
    await both("runs", RUNS.map((item) => `${HOST.replace(/^https:\/\//u, "")}:${item.runId}`))
  })
})
