import { describe, expect, it } from "vitest"
import { eventsList } from "../../src/handlers/sources/index.js"
import type { EventsListResult } from "@we-the-rebel-alliance/plugin-contract/events"
import { memoryRecords, useRecords } from "../../src/handlers/sources/records.js"
import { loadOptions } from "../../src/options.js"
import type { Deps } from "../../src/handlers/deps.js"
import type { HistoryQuery, RunInfo } from "../../src/ports.js"
import { refOf } from "../../src/handlers/sources/cursor.js"

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0)
const END = NOW - 60 * 60_000
const BEFORE = NOW - 3 * 60 * 60_000
const HOST = "https://dbc-1.cloud.databricks.com"

const query = (id: string, end = END): HistoryQuery => ({
  queryId: id,
  status: "FINISHED",
  statementType: "SELECT",
  warehouseId: "wh-small",
  userId: 42,
  userName: "ana@example.com",
  queryStartTimeMs: end - 1_000,
  queryEndTimeMs: end,
  isFinal: true,
  rowsProduced: 1,
})

const run = (id: number, end = END): RunInfo => ({
  runId: id,
  jobId: 7,
  runName: "nightly",
  state: { lifeCycleState: "TERMINATED", resultState: "SUCCESS" },
  startTime: end - 1_000,
  endTime: end,
  creatorUserName: "ana@example.com",
})

const QUERIES = [query("q-a"), query("q-b")]
const RUNS = [run(101), run(102)]
const BEFORE_QUERY = query("q-before", BEFORE)
const BEFORE_RUN = run(100, BEFORE)

function deps(source: "queries" | "runs", includeBefore = false, queries: readonly HistoryQuery[] = QUERIES): Deps {
  const base = {
    options: loadOptions({}),
    auth: {
      account: () => ({ alias: "work", mode: "pat", host: HOST, cloud: "aws", features: [], enforcement: "identity" }),
      accounts: () => [],
      token: async () => ({ accessToken: "x", expiresAt: 0, scopes: [], host: HOST }),
    },
    databricks: {
      me: async () => ({ id: "42", userName: "ana@example.com", displayName: "Ana" }),
      history: async (_account: string, filter: { startMs?: number; endMs?: number }) => {
        const rows = includeBefore ? [BEFORE_QUERY, ...queries] : [...queries]
        return { items: rows.filter((item) => item.queryStartTimeMs >= (filter.startMs ?? 0) && item.queryStartTimeMs <= (filter.endMs ?? Number.MAX_SAFE_INTEGER)) }
      },
      listRuns: async (_account: string, filter: { startTimeFrom?: number; startTimeTo?: number }) => {
        const rows = includeBefore ? [BEFORE_RUN, ...RUNS] : RUNS
        return { items: rows.filter((item) => item.startTime >= (filter.startTimeFrom ?? 0) && item.startTime <= (filter.startTimeTo ?? Number.MAX_SAFE_INTEGER)) }
      },
      getRun: async (_account: string, id: number) => (includeBefore ? [BEFORE_RUN, ...RUNS] : RUNS).find((item) => item.runId === id)!,
    },
    reads: { prepare: async () => { throw new Error("not used") } },
    ledger: { totals: async () => ({ startsToday: 0, dbuHoursToday: 0, startsSession: 0, dbuHoursSession: 0, estimate: true }), charge: async () => ({ recorded: true, totals: { startsToday: 0, dbuHoursToday: 0, startsSession: 0, dbuHoursSession: 0, estimate: true } }), starts: async () => [] },
    clock: { now: () => NOW, uuid: () => "id" },
    permission: { assert: async () => {} },
  }
  useRecords(base, memoryRecords([{ account: "work", host: HOST, record: { userId: "42", userName: "ana@example.com", at: NOW } }]))
  void source
  return base as unknown as Deps
}

const call = { sessionID: "s", agent: "a", messageID: "m", id: "c", signal: new AbortController().signal, account: "work" }
const external = (source: "queries" | "runs", id: string | number) => `${HOST.replace(/^https:\/\//u, "")}:${id}`

/** Reads page 1 with `limit: 1`, then follows every cursor until `more: false`. */
async function pages(source: "queries" | "runs", options: { since?: string; includeBefore?: boolean } = {}) {
  const d = deps(source, options.includeBefore === true)
  const found: EventsListResult[] = []
  let cursor: string | undefined
  let more = true
  while (more) {
    const page = (await eventsList({ source, account: "work", ...(options.since === undefined ? {} : { since: options.since }), ...(cursor === undefined ? {} : { cursor }), limit: 1 }, call, d)) as EventsListResult
    found.push(page)
    cursor = page.cursor
    more = page.more
    expect(page.gap).toBeUndefined()
  }
  return found
}

describe("a same-timestamp page boundary", () => {
  it("queries: both statements with one occurred_at are listed once across the pages", async () => {
    const found = await pages("queries")
    const ids = found.flatMap((page) => page.events.map((event) => event.external_id))
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(ids).toEqual([external("queries", "q-a"), external("queries", "q-b")])
    expect(found.at(-1)?.more).toBe(false)
  })

  it("runs: both runs with one occurred_at are listed once across the pages", async () => {
    const found = await pages("runs")
    const ids = found.flatMap((page) => page.events.map((event) => event.external_id))
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(ids).toEqual([external("runs", 101), external("runs", 102)])
    expect(found.at(-1)?.more).toBe(false)
  })
})

describe("the published events_list input", () => {
  it("defaults a missing source and accepts a date-only since", async () => {
    const page = (await eventsList({ account: "work", since: "2026-11-25" }, call, deps("queries"))) as EventsListResult
    expect(page.source).toBe("queries")
    expect(page.trust).toBe("untrusted")
    expect(page.events.length).toBeGreaterThan(0)
  })
})

describe("a since filter across cursor pages", () => {
  it("queries: since survives cursor paging and drops the earlier statement", async () => {
    const found = await pages("queries", { since: new Date(NOW - 2 * 60 * 60_000).toISOString(), includeBefore: true })
    const ids = found.flatMap((page) => page.events.map((event) => event.external_id))
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(ids).toEqual([external("queries", "q-a"), external("queries", "q-b")])
    expect(ids).not.toContain(external("queries", "q-before"))
    expect(found.at(-1)?.more).toBe(false)
  })

  it("runs: since survives cursor paging and drops the earlier run", async () => {
    const found = await pages("runs", { since: new Date(NOW - 2 * 60 * 60_000).toISOString(), includeBefore: true })
    const ids = found.flatMap((page) => page.events.map((event) => event.external_id))
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(ids).toEqual([external("runs", 101), external("runs", 102)])
    expect(ids).not.toContain(external("runs", 100))
    expect(found.at(-1)?.more).toBe(false)
  })
})

describe("the cursor's total order and collision bound", () => {
  it("returns an empty third page after the last item", async () => {
    const found = await pages("queries")
    const last = found.at(-1)!
    const page = (await eventsList({ source: "queries", account: "work", cursor: last.cursor, limit: 1 }, call, deps("queries"))) as EventsListResult
    expect(page.events).toEqual([])
    expect(page.more).toBe(false)
  })

  it("lists two same-second statements with the same 12-bit reference exactly once", async () => {
    const seen = new Map<string, string>()
    let ids: [string, string] | undefined
    for (let index = 0; index < 100_000 && ids === undefined; index++) {
      const id = `collision-${index}`
      const ref = refOf(id, END - 1_000)
      const previous = seen.get(ref)
      if (previous !== undefined) ids = [previous, id]
      else seen.set(ref, id)
    }
    expect(ids).toBeDefined()
    const [first, second] = ids!
    expect(refOf(first, END - 1_000)).toBe(refOf(second, END - 1_000))

    const d = deps("queries", false, [query(first), query(second)])
    const firstPage = (await eventsList({ source: "queries", account: "work", limit: 1 }, call, d)) as EventsListResult
    const secondPage = (await eventsList({ source: "queries", account: "work", cursor: firstPage.cursor, limit: 1 }, call, d)) as EventsListResult
    const listed = [...firstPage.events, ...secondPage.events].map((event) => event.external_id)
    expect(listed).toEqual([external("queries", first), external("queries", second)])
  })
})
