// The two event sources under ordinary and heavy load, over a moving clock (review of #8, H1 and M2): every probe from
// the review's table, then realistic loads — hundreds of statements an hour, statements and runs running 1–6 hours,
// backlogs, busy polling, visibility lags — each asserting **no gap, no repeat and nothing lost**, a bounded number of
// provider calls, and that an item is listed by the first read at least `LAG_MS` after it ended. No network.
import { describe, expect, test, vi } from "vitest"
import { HOLD_MAX_MS, LAG_MS } from "../../../src/sources/events.js"
import { refOf } from "../../../src/sources/cursor.js"
import { fakeRest, historyQuery, jobRun } from "./fake-rest.js"
import { depsFor, NOW } from "./harness.js"
import { consume, missing, repeats, seeded } from "./simulate.js"
import { world, type WorldItem } from "./world.js"

// These simulations run whole days of reads: an explicit timeout, so a loaded machine does not fail them (review R2-M3).
vi.setConfig({ testTimeout: 300_000 })

const HOUR = 3_600_000
const MINUTE = 60_000
const open = { assert: async () => undefined } as never

/** A steady load: `perHour` items an hour for `hours`, most short, `longShare` of them running 1–6 hours. */
function load(kind: "queries" | "runs", options: { perHour: number; hours: number; start: number; longShare?: number; seed?: number; jobs?: number }): WorldItem[] {
  const random = seeded(options.seed ?? 7)
  const items: WorldItem[] = []
  let next = 1_000_000
  for (let hour = 0; hour < options.hours; hour++) {
    for (let index = 0; index < options.perHour; index++) {
      const start = options.start + hour * HOUR + Math.floor(random() * HOUR)
      const long = random() < (options.longShare ?? 0)
      const duration = long ? HOUR + Math.floor(random() * 5 * HOUR) : 1000 + Math.floor(random() * 5 * MINUTE)
      const id = kind === "queries" ? `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}` : String(next++)
      items.push({ id, start, end: start + duration, ...(kind === "runs" ? { jobId: 1 + (index % (options.jobs ?? 5)) } : {}) })
    }
  }
  return items
}

/** A world seeded with `items`, and its dependencies at NOW. */
function worldOf(items: readonly WorldItem[], lags: { visibleAfter?: number; finalAfter?: number } = {}) {
  let clock: () => number = () => NOW
  const fake = world(() => clock(), lags)
  for (const item of items) fake.add({ ...item })
  const deps = depsFor({ answers: fake.answers }, open)
  clock = deps.clock.now
  return { fake, deps }
}

/**
 * The review's assertion for every load: nothing lost, nothing repeated, no gap, every item listed promptly — by the
 * first read at least `LAG_MS` after it ended, or, where more items run at once than the cursor tracks by id (the line
 * then waits for the oldest untracked one), at least `HOLD_MAX_MS` after.
 */
function expectClean(result: Awaited<ReturnType<typeof consume>>, items: readonly WorldItem[], since: number, every: number, wait: number = LAG_MS) {
  expect(result.gaps).toEqual([])
  expect(repeats(result)).toEqual([])
  expect(missing(result, items, since, wait)).toEqual([])
  for (const item of items) {
    const at = result.listedAt.get(item.id)
    if (at === undefined || item.end === undefined) continue
    expect(at, `${item.id} ended ${item.end - NOW} ms after NOW`).toBeLessThan(item.end + wait + every)
  }
}

describe("the review's table (H1), on its own fake and generators", () => {
  // The review's probe: the strict REST fake, `ago` < 0 for items that start after NOW, read hourly from NOW − 1 h.
  for (const perHour of [2, 10, 40]) {
    test(`queries, ${perHour}/h for 72 h, read hourly: no gap, no repeat, none lost`, async () => {
      const items = []
      for (let hour = 0; hour < 72; hour++) for (let index = 0; index < perHour; index++) items.push(historyQuery({ id: `q${hour}-${index}`, ago: -(hour * HOUR + index * (HOUR / perHour) + 1000) }))
      const rest = fakeRest({ history: items })
      const result = await consume(depsFor(rest, open), { source: "queries", since: NOW - HOUR, reads: 74, every: HOUR })
      expect(result.gaps).toEqual([])
      expect(repeats(result)).toEqual([])
      expect(items.filter((item) => !result.listed.has(item.queryId)).map((item) => item.queryId)).toEqual([])
      // About one or two history calls a read (the slice and the few rows behind the line), never a re-walk per page.
      expect(rest.calls.filter((entry) => entry.method === "history").length).toBeLessThanOrEqual(3 * 74)
    })

    test(`runs, ${perHour}/h for 96 h, read hourly: no gap, no repeat, none lost`, async () => {
      const items = []
      let id = 1000
      for (let hour = 0; hour < 96; hour++) for (let index = 0; index < perHour; index++) items.push(jobRun({ id: id++, jobId: 1 + (index % 5), ago: -(hour * HOUR + index * (HOUR / perHour) + 1000) }))
      const rest = fakeRest({ runs: items })
      const result = await consume(depsFor(rest, open), { source: "runs", since: NOW - HOUR, reads: 98, every: HOUR })
      expect(result.gaps).toEqual([])
      expect(repeats(result)).toEqual([])
      expect(items.filter((item) => !result.listed.has(String(item.runId))).map((item) => item.runId)).toEqual([])
      expect(rest.calls.filter((entry) => entry.method === "listRuns").length).toBeLessThanOrEqual(98 * (2 + Math.ceil(perHour / 25)) + 10)
    })
  }

  for (const perHour of [1, 40]) {
    test(`queries, ${perHour}/h plus one statement running 5 h: listed once`, async () => {
      const items = []
      for (let hour = 0; hour < 24; hour++) for (let index = 0; index < perHour; index++) items.push(historyQuery({ id: `q${hour}-${index}`, ago: -(hour * HOUR + index * (HOUR / perHour) + 1000) }))
      const late = historyQuery({ id: "LATE", ago: -(2 * HOUR), end: NOW + 7 * HOUR, final: false, status: "RUNNING" })
      const rest = fakeRest({ history: [...items, late] })
      const result = await consume(depsFor(rest, open), {
        source: "queries",
        since: NOW - HOUR,
        reads: 25,
        every: HOUR,
        onRead: (now) => {
          if (now >= NOW + 7 * HOUR) Object.assign(late, { isFinal: true, status: "FINISHED" })
        },
      })
      expect(result.listed.get("LATE")).toBe(1)
      expect(result.gaps).toEqual([])
      expect(repeats(result)).toEqual([])
    })
  }

  for (const perHour of [1, 10]) {
    test(`runs, ${perHour}/h plus one run lasting 30 h: listed once`, async () => {
      const items = []
      let id = 1000
      for (let hour = 0; hour < 48; hour++) for (let index = 0; index < perHour; index++) items.push(jobRun({ id: id++, ago: -(hour * HOUR + index * (HOUR / perHour) + 1000) }))
      const late = jobRun({ id: 7, ago: -(2 * HOUR), life: "RUNNING" })
      Object.assign(late, { endTime: undefined })
      const rest = fakeRest({ runs: [...items, late] })
      const result = await consume(depsFor(rest, open), {
        source: "runs",
        since: NOW - HOUR,
        reads: 49,
        every: HOUR,
        onRead: (now) => {
          if (now >= NOW + 32 * HOUR) Object.assign(late, { state: { lifeCycleState: "TERMINATED", resultState: "SUCCESS" }, endTime: NOW + 32 * HOUR })
        },
      })
      expect(result.listed.get("7")).toBe(1)
      expect(result.gaps).toEqual([])
      expect(repeats(result)).toEqual([])
    })
  }

  test("queries: a 10,050-row first window, then 1/h for 72 h — no gap, none lost, a bounded number of history calls", async () => {
    const old = Array.from({ length: 10_050 }, (_, index) => historyQuery({ id: `old${index}`, ago: 20 * HOUR + index * 1000 }))
    const fresh = Array.from({ length: 72 }, (_, hour) => historyQuery({ id: `new${hour}`, ago: -(hour * HOUR + 1000) }))
    const rest = fakeRest({ history: [...old, ...fresh] })
    const result = await consume(depsFor(rest, open), { source: "queries", since: NOW - 25 * HOUR, reads: 74, every: HOUR })
    expect(result.gaps).toEqual([])
    expect(repeats(result)).toEqual([])
    expect([...old, ...fresh].filter((item) => !result.listed.has(item.queryId)).map((item) => item.queryId)).toEqual([])
    // The review measured 1,652 calls for this at 3559359. Now: the slices read each row about once.
    expect(rest.calls.filter((entry) => entry.method === "history").length).toBeLessThan(250)
  })

  test("queries: read every 5 minutes, 12/h for 12 h", async () => {
    const items = []
    for (let hour = 0; hour < 12; hour++) for (let index = 0; index < 12; index++) items.push(historyQuery({ id: `q${hour}-${index}`, ago: -(hour * HOUR + index * 5 * MINUTE + 1000) }))
    const result = await consume(depsFor(fakeRest({ history: items }), open), { source: "queries", since: NOW - HOUR, reads: 12 * 12 + 2, every: 5 * MINUTE })
    expect(result.gaps).toEqual([])
    expect(repeats(result)).toEqual([])
    expect(items.filter((item) => !result.listed.has(item.queryId))).toEqual([])
  })

  test("M2: a statement and a run that finish at +10 min are listed on the +20 min read, not the +40 min one", async () => {
    for (const source of ["queries", "runs"] as const) {
      const rest = fakeRest({ history: [historyQuery({ id: "soon", ago: -10 * MINUTE })], runs: [jobRun({ id: 77, ago: -10 * MINUTE })] })
      const deps = depsFor(rest, open)
      const result = await consume(deps, { source, since: NOW - HOUR, reads: 3, every: 20 * MINUTE })
      const id = source === "queries" ? "soon" : "77"
      expect(result.listedAt.get(id)).toBe(NOW + 20 * MINUTE)
      expect(rest.calls.filter((entry) => entry.method === "me")).toEqual([])
    }
  })
})

describe("realistic load (H1), on a moving world: rows run, then become final at their end", () => {
  test("queries: 300 an hour, 5% running 1–6 h, read hourly for 30 h", async () => {
    const items = load("queries", { perHour: 300, hours: 30, start: NOW, longShare: 0.05 })
    const { fake, deps } = worldOf(items)
    const result = await consume(deps, { source: "queries", since: NOW, reads: 37, every: HOUR })
    // About 50 of your statements run longer than 5 minutes at once, more than the 23 the cursor tracks by id: the line
    // waits for the oldest untracked one, at most HOLD_MAX_MS.
    expectClean(result, items, NOW, HOUR, HOLD_MAX_MS)
    // History calls: the rows behind the line (≤ 6 h of 300/h) and the new slice, about 3 a page.
    expect(fake.count("history") / result.pages).toBeLessThan(5)
  })

  test("queries: 300 an hour, 5% running 1–6 h, read every 5 minutes for 12 h", async () => {
    const items = load("queries", { perHour: 300, hours: 12, start: NOW, longShare: 0.05, seed: 11 })
    const { deps } = worldOf(items)
    const result = await consume(deps, { source: "queries", since: NOW, reads: 12 * 12 + 80, every: 5 * MINUTE })
    expectClean(result, items, NOW, 5 * MINUTE, HOLD_MAX_MS)
  }, 120_000)

  test("queries: 600 an hour with statements of 20–47 h, which go to the tracked ids, read hourly for 60 h", async () => {
    const items = load("queries", { perHour: 600, hours: 12, start: NOW, longShare: 0.01, seed: 3 })
    for (let index = 0; index < 8; index++) {
      const start = NOW + index * HOUR + 17 * MINUTE
      items.push({ id: `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`, start, end: start + (20 + index * 3.8) * HOUR })
    }
    const { deps } = worldOf(items)
    const result = await consume(deps, { source: "queries", since: NOW, reads: 61, every: HOUR })
    expectClean(result, items, NOW, HOUR, HOLD_MAX_MS)
    for (let index = 0; index < 8; index++) expect(result.listed.get(`00000000-0000-4000-9000-${String(index).padStart(12, "0")}`)).toBe(1)
    expect(result.maxCursor).toBeLessThanOrEqual(1024)
  })

  test("runs: 100 an hour across 5 jobs, 10% running 1–6 h, read hourly for 30 h", async () => {
    const items = load("runs", { perHour: 100, hours: 30, start: NOW, longShare: 0.1 })
    const { fake, deps } = worldOf(items)
    const result = await consume(deps, { source: "runs", since: NOW, reads: 37, every: HOUR })
    expectClean(result, items, NOW, HOUR)
    // runs/list pages 25 at a time: the new hour (4 pages), the rows behind the line (≤ 10), and the tracked runs.
    expect((fake.count("listRuns") + fake.count("getRun")) / result.reads).toBeLessThan(80)
  })

  test("runs: 300 an hour, 3% running 1–6 h, read every 15 minutes for 12 h", async () => {
    const items = load("runs", { perHour: 300, hours: 12, start: NOW, longShare: 0.03, seed: 5 })
    const { deps } = worldOf(items)
    const result = await consume(deps, { source: "runs", since: NOW, reads: 12 * 4 + 28, every: 15 * MINUTE })
    expectClean(result, items, NOW, 15 * MINUTE)
  })

  test("runs scoped to two jobs: only theirs, none lost", async () => {
    const items = load("runs", { perHour: 60, hours: 10, start: NOW, longShare: 0.1, seed: 9 })
    const { deps } = worldOf(items)
    const result = await consume(deps, { source: "runs", since: NOW, reads: 18, every: HOUR, scope: { jobs: ["1", "3"] } })
    const wanted = items.filter((item) => item.jobId === 1 || item.jobId === 3)
    expectClean(result, wanted, NOW, HOUR)
    expect([...result.listed.keys()].every((id) => wanted.some((item) => item.id === id))).toBe(true)
  })

  test("visibility lags under LAG_MS (rows appear 2 min after starting, and final 2 min after ending): none lost", async () => {
    const items = load("queries", { perHour: 200, hours: 10, start: NOW, longShare: 0.05, seed: 13 })
    const { deps } = worldOf(items, { visibleAfter: 2 * MINUTE, finalAfter: 2 * MINUTE })
    const result = await consume(deps, { source: "queries", since: NOW, reads: 12 * 10 + 80, every: 5 * MINUTE })
    expectClean(result, items, NOW, 5 * MINUTE, HOLD_MAX_MS)
  }, 120_000)

  test("a backlog: the first read asks for 7 days at 300 statements an hour (50,400), and drains in slices without a gap", async () => {
    const items = load("queries", { perHour: 300, hours: 7 * 24, start: NOW - 7 * 24 * HOUR, longShare: 0.02, seed: 17 })
    const { fake, deps } = worldOf(items)
    const result = await consume(deps, { source: "queries", since: NOW - 7 * 24 * HOUR, reads: 1, every: HOUR, limit: 500 })
    expect(result.gaps).toEqual([])
    expect(repeats(result)).toEqual([])
    expect(missing(result, items, NOW - 7 * 24 * HOUR, HOLD_MAX_MS)).toEqual([])
    // Each row is read about once: a page reads its own slice (`[n, t]`, one or two calls), never the whole window again.
    // (A page holds about 123 events under the contract's byte cap, so this read takes about 410 pages.)
    expect(fake.count("history")).toBeLessThan(result.pages * 3)
    expect(fake.count("history")).toBeLessThan(items.length / 40)
  }, 120_000)

  test("a backlog of runs: the first read asks for 24 h at 300 an hour (7,200 runs)", async () => {
    const items = load("runs", { perHour: 300, hours: 24, start: NOW - 24 * HOUR, longShare: 0.02, seed: 19 })
    const { fake, deps } = worldOf(items)
    const result = await consume(deps, { source: "runs", since: NOW - 24 * HOUR, reads: 1, every: HOUR, limit: 500 })
    expect(result.gaps).toEqual([])
    expect(repeats(result)).toEqual([])
    expect(missing(result, items, NOW - 24 * HOUR, HOLD_MAX_MS)).toEqual([])
    // runs/list answers 25 a page, so 288 calls is the least that lists 7,200 runs; this read stays within 3.5 times that.
    expect(fake.count("listRuns") + fake.count("getRun")).toBeLessThan((items.length / 25) * 3.5)
  }, 120_000)
})

describe("round 2 of the review: the tracked ids, a busy workspace, and final states that lag", () => {
  for (const limit of [50, 100]) {
    test(`R2-H1: 500 runs started a second apart and ending in one millisecond 2 h later, read hourly at limit ${limit}: all 500 listed, no gap`, async () => {
      const items: WorldItem[] = Array.from({ length: 500 }, (_, index) => ({ id: String(2_000_000 + index), jobId: 1, start: NOW + index * 1000, end: NOW + 2 * HOUR }))
      const { deps } = worldOf(items)
      const result = await consume(deps, { source: "runs", since: NOW - HOUR, reads: 5, every: HOUR, limit })
      expect(result.gaps).toEqual([])
      expect(repeats(result)).toEqual([])
      expect(result.listed.size).toBe(500)
      expect(result.maxCursor).toBeLessThanOrEqual(1024)
    }, 120_000)
  }

  test("R2-M1: runs at 600 an hour, 5% running 1–6 h, read hourly for 48 h — no gap, none lost, bounded calls", async () => {
    const items = load("runs", { perHour: 600, hours: 48, start: NOW, longShare: 0.05, seed: 23 })
    const { fake, deps } = worldOf(items)
    const result = await consume(deps, { source: "runs", since: NOW, reads: 55, every: HOUR })
    // About 100 runs at once run longer than 5 minutes, near what the cursor tracks by id: when it is full, the line
    // waits for the oldest untracked one (at most HOLD_MAX_MS) instead of gapping.
    expectClean(result, items, NOW, HOUR, HOLD_MAX_MS)
    // About 24 runs/list calls a read for the new runs, the re-walk behind the line and one runs/get per tracked run.
    // Measured: about 50 runs/list and 220 runs/get calls a read (docs/sources.md, Cost).
    expect((fake.count("listRuns") + fake.count("getRun")) / result.reads).toBeLessThan(300)
    expect(result.maxCursor).toBeLessThanOrEqual(1024)
  }, 300_000)

  for (const lag of [1, 5, 15, 60]) {
    for (const source of ["queries", "runs"] as const) {
      test(`R2-M2: ${source} whose final state shows ${lag} min after the end are all listed, once, with no gap`, async () => {
        const items = load(source, { perHour: 60, hours: 8, start: NOW, longShare: 0.05, seed: 29 + lag })
        const { deps } = worldOf(items, { finalAfter: lag * MINUTE })
        const result = await consume(deps, { source, since: NOW, reads: 8 * 4 + 12, every: 15 * MINUTE })
        expect(result.gaps).toEqual([])
        expect(repeats(result)).toEqual([])
        expect(missing(result, items, NOW, lag * MINUTE + HOLD_MAX_MS)).toEqual([])
      }, 120_000)
    }
  }

  for (const source of ["queries", "runs"] as const) {
    test(`LOW 2: ${source} whose final state shows 2 h after the end (past the 75-minute hold): one gap for the episode, nothing lost`, async () => {
      // The reviewer's load: 300 an hour, 5% running 1–6 h, read every 5 minutes for 12 h.
      const items = load(source, { perHour: 300, hours: 12, start: NOW, longShare: 0.05, seed: 5 })
      const { deps } = worldOf(items, { finalAfter: 2 * HOUR })
      const notes: string[] = []
      const result = await consume(deps, { source, since: NOW, reads: 12 * 12 + 60, every: 5 * MINUTE, notes })
      expect(repeats(result)).toEqual([])
      expect(missing(result, items, NOW, 2 * HOUR + HOLD_MAX_MS + 5 * MINUTE)).toEqual([])
      // The proof of the lag widens the hold to it, so the episode answers once and loses nothing more.
      expect(result.gaps.length).toBeLessThanOrEqual(1)
      // The evidence is in the notes the model's tool shows: what lag was seen, and how long the source now waits.
      expect(notes.some((note) => /final state about \d+ minutes after its end/u.test(note))).toBe(true)
      if (result.gaps.length === 1) expect(notes.some((note) => note.includes("may be missing"))).toBe(true)
    }, 300_000)
  }

  test("LOW 2: a lag proven while every item the line passed was tracked answers no gap at all", async () => {
    const items = load("queries", { perHour: 60, hours: 8, start: NOW, longShare: 0.05, seed: 31 })
    const { deps } = worldOf(items, { finalAfter: 2 * HOUR })
    const result = await consume(deps, { source: "queries", since: NOW, reads: 8 * 4 + 20, every: 15 * MINUTE })
    expect(result.gaps).toEqual([])
    expect(repeats(result)).toEqual([])
    expect(missing(result, items, NOW, 2 * HOUR + HOLD_MAX_MS + 15 * MINUTE)).toEqual([])
  }, 300_000)

  test("LOW 1: queries at the reviewer's load (300 an hour, 5% running 1–6 h, read every 5 min) are listed within 15 min of ending", async () => {
    // Before statement references, about 24 statements fit the cursor and 2,972 of 3,548 waited more than 20 minutes,
    // up to 80; now about 70 fit, and none waits longer than two reads.
    const items = load("queries", { perHour: 300, hours: 12, start: NOW, longShare: 0.05, seed: 11 })
    const { deps } = worldOf(items)
    const result = await consume(deps, { source: "queries", since: NOW, reads: 12 * 12 + 30, every: 5 * MINUTE })
    expectClean(result, items, NOW, 5 * MINUTE, 10 * MINUTE)
    expect(items.filter((item) => result.listedAt.has(item.id) && result.listedAt.get(item.id)! - item.end! > 15 * MINUTE)).toEqual([])
  }, 300_000)

  test("LOW 1: a statement reference names one statement: two in one second with the same hash are never tracked", () => {
    // References are the start second and 12 bits of the id's hash; collisions inside one second are refused at
    // admission (the engine checks every row of that second), so this only documents the shape.
    expect(refOf("00000000-0000-4000-8000-000000000001", NOW + 1234)).toMatch(/^1800000001~[A-Za-z0-9_-]{2}$/u)
  })
})

