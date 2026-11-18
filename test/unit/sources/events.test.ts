// The two event sources' behaviour, page by page, and the three bugs every source review finds — the sliding gap, the
// jam, and a gap repeated within a read — plus ordering ties, pages that shift during a read, the probe record, the
// grants each read asserts, and the cursor's size. Strict REST fakes, no Databricks call; the loads are in load.test.ts.
import { encodeBoundCursor } from "@we-the-rebel-alliance/source-contract/cursor"
import { describe, expect, test, vi } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import { bindingOf, decodeState, encodeState, fits, packIds, unpackIds, Z_CHARS } from "../../../src/sources/cursor.js"
import { eventsPage, LAG_MS } from "../../../src/sources/events.js"
import { memoryRecords } from "../../../src/sources/records.js"
import { RecordingPermission } from "../../fake/ports.js"
import { fakeRest, historyQuery, jobRun } from "./fake-rest.js"
import { call, DAY, depsFor, NOW } from "./harness.js"
import { consume, missing, repeats } from "./simulate.js"
import { world } from "./world.js"

// These simulations run whole days of reads: an explicit timeout, so a loaded machine does not fail them (review R2-M3).
vi.setConfig({ testTimeout: 120_000 })

const iso = (ms: number) => new Date(ms).toISOString()
const HOUR = 3_600_000
const MINUTE = 60_000
const ids = (page: { events: readonly { external_id: string }[] }) => page.events.map((event) => event.external_id)
const secret = "deploy ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
const open = { assert: async () => undefined } as never

type Seed = NonNullable<Parameters<typeof fakeRest>[0]>
const queryDeps = (history: Seed["history"]) => depsFor(fakeRest({ history }), open)
const runDeps = (runs: Seed["runs"]) => depsFor(fakeRest({ runs }), open)
const cursorFor = (source: "queries" | "runs", state: Record<string, unknown>) => encodeBoundCursor(bindingOf(source, "work", undefined), state)

describe("databricks.queries", () => {
  test("pages oldest first by end, then answers an empty page", async () => {
    const deps = queryDeps([historyQuery({ id: "q1", ago: 3 * HOUR }), historyQuery({ id: "q2", ago: 2 * HOUR }), historyQuery({ id: "q3", ago: HOUR })])
    const first = await eventsPage(deps, { account: "work", source: "queries", since: iso(NOW - 4 * HOUR), limit: 1, call: call("p1") })
    expect(first.more).toBe(true)
    const second = await eventsPage(deps, { account: "work", source: "queries", cursor: first.cursor, limit: 1, call: call("p2") })
    const third = await eventsPage(deps, { account: "work", source: "queries", cursor: second.cursor, limit: 1, call: call("p3") })
    expect(third.more).toBe(false)
    expect([...ids(first), ...ids(second), ...ids(third)].map((id) => id.split(":").pop())).toEqual(["q1", "q2", "q3"])
    const empty = await eventsPage(deps, { account: "work", source: "queries", cursor: third.cursor, call: call("p4") })
    expect(empty.events).toEqual([])
    expect(empty.more).toBe(false)
  })

  test("a window larger than a walk is read in slices: no gap, none lost, none twice (was the sliding gap)", async () => {
    const old = Array.from({ length: 10_004 }, (_, index) => historyQuery({ id: `q-old-${index}`, ago: 25 * HOUR + index * 1000 }))
    const result = await consume(queryDeps(old), { source: "queries", since: NOW - 48 * HOUR, reads: 1, every: HOUR, limit: 500 })
    expect(result.gaps).toEqual([])
    expect(repeats(result)).toEqual([])
    expect(result.listed.size).toBe(10_004)
  })

  test("the jam: 200 statements at one start and one end drain once each, at a limit of 50", async () => {
    const at = NOW - HOUR
    const burst = Array.from({ length: 200 }, (_, index) => historyQuery({ id: `q-burst-${String(index).padStart(3, "0")}`, ago: HOUR, start: at, end: at + 3000 }))
    const result = await consume(queryDeps(burst), { source: "queries", since: at - HOUR, reads: 1, every: HOUR, limit: 50 })
    expect(repeats(result)).toEqual([])
    expect(result.listed.size).toBe(200)
    expect(result.gaps).toEqual([])
  })

  test("ordering ties: 300 statements ending in one millisecond, at a limit of 7, are walked by id hash, once each, oldest first", async () => {
    const end = NOW - 30 * MINUTE
    const tied = Array.from({ length: 300 }, (_, index) => historyQuery({ id: `q-tie-${index}`, ago: 0, start: end - 1000 - index * 10, end }))
    const deps = queryDeps(tied)
    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      const answer = await eventsPage(deps, { account: "work", source: "queries", ...(cursor ? { cursor } : { since: iso(NOW - 2 * HOUR) }), limit: 7, call: call(`tie${page}`) })
      const times = answer.events.map((event) => event.occurred_at)
      expect(times).toEqual([...times].sort())
      seen.push(...ids(answer))
      cursor = answer.cursor
      if (!answer.more) break
    }
    expect(seen.length).toBe(300)
    expect(new Set(seen).size).toBe(300)
  })

  test("pages that shift: statements that start and finish while a read pages are listed by that read or the next, once", async () => {
    let now = () => NOW
    const fake = world(() => now())
    for (let index = 0; index < 900; index++) fake.add({ id: `q-${index}`, start: NOW - 3 * HOUR + index * 10_000, end: NOW - 3 * HOUR + index * 10_000 + 2000 })
    const deps = depsFor({ answers: fake.answers }, open)
    now = deps.clock.now
    const clock = deps.clock as unknown as { advance(ms: number): void }
    const listed = new Map<string, number>()
    let cursor: string | undefined
    let added = 0
    for (let read = 0; read < 3; read++) {
      for (let page = 0; page < 200; page++) {
        const answer = await eventsPage(deps, { account: "work", source: "queries", ...(cursor ? { cursor } : { since: iso(NOW - 4 * HOUR) }), limit: 25, call: call(`shift${read}-${page}`) })
        for (const id of ids(answer)) listed.set(id, (listed.get(id) ?? 0) + 1)
        expect(answer.gap).toBeUndefined()
        cursor = answer.cursor
        // A new statement starts and finishes between two pages of the read.
        const start = deps.clock.now() - 1000
        fake.add({ id: `q-new-${added++}`, start, end: start + 500 })
        clock.advance(2000)
        if (!answer.more) break
      }
      clock.advance(10 * MINUTE)
    }
    expect([...listed.values()].every((count) => count === 1)).toBe(true)
    const owed = fake.items.filter((item) => item.end! <= deps.clock.now() - LAG_MS - 10 * MINUTE)
    expect(owed.filter((item) => !listed.has(`fake-workspace.cloud.databricks.com:${item.id}`))).toEqual([])
  })

  test("a late row (shown 4 minutes after it started, inside LAG_MS) is still listed", async () => {
    let now = () => NOW
    const fake = world(() => now(), { visibleAfter: 4 * MINUTE })
    const items = Array.from({ length: 50 }, (_, index) => ({ id: `q-${index}`, start: NOW + index * MINUTE, end: NOW + index * MINUTE + 30_000 }))
    for (const item of items) fake.add({ ...item })
    const deps = depsFor({ answers: fake.answers }, open)
    now = deps.clock.now
    const result = await consume(deps, { source: "queries", since: NOW, reads: 30, every: 3 * MINUTE })
    expect(missing(result, items, NOW)).toEqual([])
    expect(repeats(result)).toEqual([])
  })

  test("a secret-shaped title is refused, with its reason, and never listed", async () => {
    const deps = queryDeps([historyQuery({ id: "q-ok", ago: HOUR }), historyQuery({ id: "q-secret", ago: 2 * HOUR, statementType: secret })])
    const page = await eventsPage(deps, { account: "work", source: "queries", since: iso(NOW - 4 * HOUR), call: call("secret") })
    expect(page.events).toHaveLength(1)
    expect(page.refused).toEqual([expect.objectContaining({ reason: "secret" })])
    const next = await eventsPage(deps, { account: "work", source: "queries", cursor: page.cursor, call: call("secret2") })
    expect(next.refused).toBeUndefined()
  })

  test("an expired cursor answers one gap from its own line, and a cursor that restarts", async () => {
    const deps = queryDeps([historyQuery({ id: "q1", ago: HOUR })])
    const expired = cursorFor("queries", { e: NOW - 31 * DAY, l: NOW - 31 * DAY - HOUR })
    const page = await eventsPage(deps, { account: "work", source: "queries", cursor: expired, call: call("old") })
    expect(page.gap).toEqual({ reason: "expired", since: iso(NOW - 31 * DAY) })
    expect(page.more).toBe(true)
    const restart = await eventsPage(deps, { account: "work", source: "queries", cursor: page.cursor, call: call("again") })
    expect(restart.gap).toBeUndefined()
    expect(ids(restart).map((id) => id.split(":").pop())).toEqual(["q1"])
  })

  test("the sliding gap: the same expired cursor read an hour later gives the same line, and the restart lists the edge", async () => {
    const edgeItem = historyQuery({ id: "q-edge", ago: 29 * DAY + 20 * HOUR })
    const rest = fakeRest({ history: [edgeItem] })
    const deps = depsFor(rest, open)
    const clock = deps.clock as unknown as { advance(ms: number): void }
    const expired = cursorFor("queries", { e: NOW - 40 * DAY, l: NOW - 40 * DAY })
    const first = await eventsPage(deps, { account: "work", source: "queries", cursor: expired, call: call("s1") })
    clock.advance(HOUR)
    const second = await eventsPage(deps, { account: "work", source: "queries", cursor: expired, call: call("s2") })
    expect(first.gap?.since).toBe(second.gap?.since)
    // Following the gap's cursor: the statement inside retention is listed, and no second gap is answered.
    const restart = await eventsPage(deps, { account: "work", source: "queries", cursor: second.cursor, call: call("s3") })
    expect(restart.gap).toBeUndefined()
    expect(ids(restart).map((id) => id.split(":").pop())).toEqual(["q-edge"])
  })

  test("gap once per read: a first read further back than retention answers one gap across many one-event pages", async () => {
    const items = Array.from({ length: 30 }, (_, index) => historyQuery({ id: `q-${index}`, ago: 29 * DAY - index * HOUR }))
    const deps = queryDeps(items)
    let cursor: string | undefined
    let gaps = 0
    let listed = 0
    for (let page = 0; page < 200; page++) {
      const answer = await eventsPage(deps, { account: "work", source: "queries", ...(cursor ? { cursor } : { since: iso(NOW - 45 * DAY) }), limit: 1, call: call(`once${page}`) })
      if (answer.gap) gaps += 1
      listed += answer.events.length
      cursor = answer.cursor
      if (!answer.more) break
    }
    expect(gaps).toBe(1)
    expect(listed).toBe(30)
  })

  test("a vendor error is the contract's RATE_LIMITED, with the retry, and the page fails whole", async () => {
    const rest = fakeRest({ history: [historyQuery({ id: "q1", ago: HOUR })] })
    rest.failHistoryOnce(new DatabricksError("RATE_LIMITED", undefined, undefined, undefined, { retryAfterSec: 7 }))
    const deps = depsFor(rest, open)
    await expect(eventsPage(deps, { account: "work", source: "queries", since: iso(NOW - HOUR), call: call("rate") })).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSec: 7 })
  })

  test("a scoped read asks Query History for the warehouses, and lists only theirs", async () => {
    const rest = fakeRest({ history: [historyQuery({ id: "q-a", ago: HOUR, warehouse: "wh-a" }), historyQuery({ id: "q-b", ago: HOUR, warehouse: "wh-b" })] })
    const page = await eventsPage(depsFor(rest, open), { account: "work", source: "queries", since: iso(NOW - 2 * HOUR), scope: { warehouses: ["wh-a"] }, call: call("scope") })
    expect(ids(page).map((id) => id.split(":").pop())).toEqual(["q-a"])
    expect(rest.calls.filter((entry) => entry.method === "history").every((entry) => JSON.stringify((entry.args[0] as { warehouseIds?: string[] }).warehouseIds) === '["wh-a"]')).toBe(true)
  })
})

describe("the probe record (H3's request 1: content reads never read the identity)", () => {
  test("a consumer's read without a probe record is UNAVAILABLE, and never calls Me", async () => {
    const rest = fakeRest({ history: [historyQuery({ id: "q1", ago: HOUR })] })
    const deps = depsFor(rest, open, {}, memoryRecords())
    await expect(eventsPage(deps, { account: "work", source: "queries", since: iso(NOW - 2 * HOUR), call: call("none") })).rejects.toMatchObject({ code: "UNAVAILABLE" })
    expect(rest.calls.filter((entry) => entry.method === "me")).toEqual([])
  })

  test("probe records the person, and the read filters Query History by that id", async () => {
    const records = memoryRecords()
    const rest = fakeRest({ history: [historyQuery({ id: "q-mine", ago: HOUR }), historyQuery({ id: "q-theirs", ago: HOUR, user: 42 })] })
    const deps = depsFor(rest, open, {}, records)
    const { probe } = await import("../../../src/sources/probe.js")
    await probe(deps, { source: "queries", account: "work" }, call("probe"))
    expect(records.get("work", "https://fake-workspace.cloud.databricks.com")?.userName).toBe("sam.rivera@example.com")
    const page = await eventsPage(deps, { account: "work", source: "queries", since: iso(NOW - 2 * HOUR), call: call("after") })
    expect(ids(page).map((id) => id.split(":").pop())).toEqual(["q-mine"])
    expect(page.owner.id).toBe("mailto:sam.rivera@example.com")
  })

  test("the model's own tool reads the identity itself when no probe has, asserting its action on scim.me.get", async () => {
    const records = memoryRecords()
    const permission = new RecordingPermission()
    const deps = depsFor(fakeRest({ history: [historyQuery({ id: "q1", ago: HOUR })] }), permission, {}, records)
    const page = await eventsPage(deps, { account: "work", source: "queries", since: iso(NOW - 2 * HOUR), call: call("model"), mode: "tool" })
    expect(page.events).toHaveLength(1)
    expect(permission.requests.map((request) => `${request.action} ${request.resource}`)).toEqual(["databricks.events_list work:sql.history.queries.list", "databricks.events_list work:scim.me.get"])
    expect(records.get("work", "https://fake-workspace.cloud.databricks.com")).toBeDefined()
  })
})

describe("the grants each read asserts (H2)", () => {
  test("events_list asserts its method on *, then databricks.read on each operation, before any call; never the identity", async () => {
    for (const source of ["queries", "runs"] as const) {
      const permission = new RecordingPermission()
      const rest = fakeRest({ history: [historyQuery({ id: "q1", ago: HOUR })], runs: [jobRun({ id: 1, ago: HOUR })] })
      await eventsPage(depsFor(rest, permission), { account: "work", source, since: iso(NOW - 2 * HOUR), call: call("grants") })
      const asserted = permission.requests.map((request) => `${request.action} ${request.resource}`)
      expect(asserted).toEqual(
        source === "queries"
          ? ["databricks.events_list *", "databricks.read work:sql.history.queries.list"]
          : ["databricks.events_list *", "databricks.read work:jobs.runs.list", "databricks.read work:jobs.runs.get"],
      )
    }
  })

  test("the model's own tool keeps the family's rule: its action on <account>:<operation>, the primary operation first", async () => {
    const permission = new RecordingPermission()
    const rest = fakeRest({ runs: [jobRun({ id: 1, ago: HOUR })] })
    await eventsPage(depsFor(rest, permission), { account: "work", source: "runs", since: iso(NOW - 2 * HOUR), call: call("tool"), mode: "tool" })
    expect(permission.requests.map((request) => `${request.action} ${request.resource}`)).toEqual(["databricks.events_list work:jobs.runs.list", "databricks.events_list work:jobs.runs.get"])
  })

  test("a person's off switch for one operation is consulted: denying databricks.read on it refuses the read", async () => {
    const permission = new RecordingPermission((request) => (request.action === "databricks.read" && request.resource === "work:jobs.runs.get" ? "deny" : "allow"))
    const rest = fakeRest({ runs: [jobRun({ id: 1, ago: HOUR })] })
    await expect(eventsPage(depsFor(rest, permission), { account: "work", source: "runs", since: iso(NOW - 2 * HOUR), call: call("denied") })).rejects.toThrow(/denied/u)
    expect(rest.calls).toEqual([])
  })
})

describe("databricks.runs", () => {
  test("pages runs, carries the workspace owner, and never calls Me", async () => {
    const rest = fakeRest({ runs: [jobRun({ id: 1, ago: 2 * HOUR, result: "SUCCESS" }), jobRun({ id: 2, ago: HOUR, result: "FAILED" })] })
    const page = await eventsPage(depsFor(rest, open), { account: "work", source: "runs", since: iso(NOW - 4 * HOUR), call: call("runs") })
    expect(page.owner.id).toBe("databricks:fake-workspace.cloud.databricks.com:account:work")
    expect(page.events).toHaveLength(2)
    expect(page.events[0]!.title).toContain("run:")
    expect(rest.calls.filter((entry) => entry.method === "me")).toEqual([])
  })

  test("the jam: 1,500 runs started in one millisecond drain once each, with no gap", async () => {
    const at = NOW - HOUR
    const burst = Array.from({ length: 1_500 }, (_, index) => jobRun({ id: 500_000 + index, ago: HOUR, start: at, end: at + 5000, result: "SUCCESS" }))
    const result = await consume(runDeps(burst), { source: "runs", since: at - HOUR, reads: 1, every: HOUR, limit: 100 })
    expect(repeats(result)).toEqual([])
    expect(result.listed.size).toBe(1_500)
    expect(result.gaps).toEqual([])
  }, 60_000)

  test("a jam past the jam cap (10,001 runs in one millisecond) answers one gap and moves on", async () => {
    const at = NOW - HOUR
    const burst = Array.from({ length: 10_001 }, (_, index) => jobRun({ id: 600_000 + index, ago: HOUR, start: at, end: at, result: "SUCCESS" }))
    const later = jobRun({ id: 700_000, ago: 30 * MINUTE, result: "SUCCESS" })
    const result = await consume(runDeps([...burst, later]), { source: "runs", since: at - HOUR, reads: 2, every: HOUR, limit: 500 })
    expect(result.gaps).toHaveLength(1)
    expect(result.listed.get("700000")).toBe(1)
    expect(repeats(result)).toEqual([])
  }, 120_000)

  test("60 long runs and 2,000 short ones: the long ones are tracked by id and listed when they end, with no gap", async () => {
    const long = Array.from({ length: 60 }, (_, index) => ({ id: String(800_000 + index), jobId: 1, start: NOW - 6 * HOUR + index * 1000, end: NOW + 2 * HOUR + index * 1000 }))
    const short = Array.from({ length: 2000 }, (_, index) => ({ id: String(900_000 + index), jobId: 2, start: NOW - 5 * HOUR + index * 9000, end: NOW - 5 * HOUR + index * 9000 + 1000 }))
    let now = () => NOW
    const fake = world(() => now())
    for (const item of [...long, ...short]) fake.add({ ...item })
    const deps = depsFor({ answers: fake.answers }, open)
    now = deps.clock.now
    const result = await consume(deps, { source: "runs", since: NOW - 7 * HOUR, reads: 5, every: HOUR })
    expect(result.gaps).toEqual([])
    expect(repeats(result)).toEqual([])
    expect([...long, ...short].filter((item) => !result.listed.has(item.id))).toEqual([])
    expect(result.maxCursor).toBeLessThanOrEqual(1024)
  })

  test("more long runs than the cursor can track, and too many rows behind them to re-walk: one gap, once, never silent", async () => {
    // 300 long runs with sparse ids (each about 8 characters to track) started 7 h back, then 6,000 short runs: the
    // tracked set fills, and re-walking back to the rest would take more than a behind-walk reaches.
    const long = Array.from({ length: 300 }, (_, index) => ({ id: String(1_000_000_000_000 + index * 1_000_000_007), jobId: 1, start: NOW - 7 * HOUR + index * 1000, end: NOW + 3 * HOUR + index * 1000 }))
    const short = Array.from({ length: 6000 }, (_, index) => ({ id: String(5_000_000_000_000 + index), jobId: 2, start: NOW - 6 * HOUR + index * 3000, end: NOW - 6 * HOUR + index * 3000 + 1000 }))
    let now = () => NOW
    const fake = world(() => now())
    for (const item of [...long, ...short]) fake.add({ ...item })
    const deps = depsFor({ answers: fake.answers }, open)
    now = deps.clock.now
    const result = await consume(deps, { source: "runs", since: NOW - 8 * HOUR, reads: 6, every: HOUR, limit: 500 })
    expect(result.gaps).toHaveLength(1)
    expect(repeats(result)).toEqual([])
    expect(short.filter((item) => !result.listed.has(item.id))).toEqual([])
    // Every long run is either listed or behind that one gap.
    expect(long.filter((item) => result.listed.has(item.id)).length).toBeGreaterThan(0)
    expect(result.maxCursor).toBeLessThanOrEqual(1024)
  })

  test("a tracked run that is gone is dropped; a failing runs/get fails the page whole (no failed[])", async () => {
    const deps = runDeps([jobRun({ id: 1, ago: HOUR })])
    const gone = cursorFor("runs", { e: NOW - 2 * HOUR, l: NOW - 2 * HOUR + 1, z: (9_999_999).toString(36) })
    const page = await eventsPage(deps, { account: "work", source: "runs", cursor: gone, call: call("gone") })
    expect(page.failed).toBeUndefined()
    expect(decodeState(bindingOf("runs", "work", undefined), page.cursor)).toMatchObject({ ok: true, state: { e: expect.any(Number) } })
    expect((decodeState(bindingOf("runs", "work", undefined), page.cursor) as { state: { z?: string } }).state.z).toBeUndefined()
    const failing = depsFor({ answers: { ...fakeRest({ runs: [] }).answers, getRun: () => Promise.reject(new DatabricksError("UNAVAILABLE")) } }, open)
    await expect(eventsPage(failing, { account: "work", source: "runs", cursor: gone, call: call("fail") })).rejects.toMatchObject({ code: "UNAVAILABLE" })
  })

  test("a secret-shaped run name is refused", async () => {
    const page = await eventsPage(runDeps([jobRun({ id: 1, ago: HOUR, name: secret })]), { account: "work", source: "runs", since: iso(NOW - 2 * HOUR), call: call("rsecret") })
    expect(page.events).toEqual([])
    expect(page.refused).toEqual([expect.objectContaining({ reason: "secret" })])
  })

  test("another account's or plugin's cursor is CURSOR_INVALID; an unknown source is SOURCE_UNKNOWN", async () => {
    const deps = runDeps([jobRun({ id: 1, ago: HOUR })])
    const other = encodeBoundCursor({ plugin: "other", source: "runs", account: "work" }, { e: NOW, l: NOW })
    await expect(eventsPage(deps, { account: "work", source: "runs", cursor: other, call: call("foreign") })).rejects.toMatchObject({ code: "CURSOR_INVALID" })
    await expect(eventsPage(deps, { account: "work", source: "nope" as never, call: call("unknown") })).rejects.toMatchObject({ code: "SOURCE_UNKNOWN" })
  })
})

describe("the cursor", () => {
  test("the plugin never refuses its own cursor: odd optional fields are dropped, not refused", () => {
    const binding = bindingOf("runs", "work", undefined)
    const odd = encodeBoundCursor(binding, { e: NOW, l: NOW + 5000, k: "XYZ", z: 42, d: -1, g: 2, n: "x", m: null })
    expect(decodeState(binding, odd)).toEqual({ ok: true, state: { e: NOW, l: NOW + 1 } })
  })

  test("the worst case fits the contract's 1,024 characters: the tracked ids at their budget, every field at its widest", () => {
    // Query ids are UUIDs (22 characters packed); run ids up to int64's 13 base36 digits, spread so their deltas are
    // wide; every end a 13-digit time. Admission keeps the set within budget with every entry finished; ends are kept
    // only where they fit, and never an id is dropped.
    const uuids = Array.from({ length: 40 }, (_, index) => ({ id: `ffffffff-ffff-4fff-bfff-${String(index).padStart(12, "f")}`, done: true, end: 9_999_999_999_999 }))
    const runs = Array.from({ length: 200 }, (_, index) => ({ id: String(1_000_000_000_000_000_000n + BigInt(index) * 40_000_000_000_000_000n), done: true, end: 9_999_999_999_999 }))
    for (const [source, entries] of [["queries", uuids], ["runs", runs]] as const) {
      const admitted: { id: string; done: boolean; end: number }[] = []
      for (const entry of entries) if (fits([...admitted, entry])) admitted.push(entry)
      const z = packIds(admitted)!
      expect(z.length).toBeLessThanOrEqual(Z_CHARS)
      expect(unpackIds(z).map((entry) => entry.id).sort()).toEqual(admitted.map((entry) => entry.id).sort())
      expect(unpackIds(z).every((entry) => entry.done === true && (entry.end === undefined || entry.end === 9_999_999_999_999))).toBe(true)
      const binding = bindingOf(source, "a".repeat(320), { warehouses: ["x".repeat(200)], jobs: ["9".repeat(19)] })
      const cursor = encodeState(binding, { e: 9_999_999_999_999, k: "ffffffffffff", l: 9_999_999_999_998, n: 9_999_999_999_997, m: 9_999_999_999_999, d: 9_999_999_999, t: 9_999_999_999_999, z, g: 1 })
      expect(cursor.length).toBeLessThanOrEqual(1024)
    }
  })

  test("run ids are delta-encoded: 100 runs created close together fit, and every id comes back", () => {
    const runs = Array.from({ length: 100 }, (_, index) => ({ id: String(1_093_491_742_912_345 + index * 37) }))
    expect(fits(runs)).toBe(true)
    expect(unpackIds(packIds(runs)).map((entry) => entry.id)).toEqual(runs.map((entry) => entry.id))
  })
})
