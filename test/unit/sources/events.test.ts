// The two event sources (design §11.1, §11.2), and the three bugs every source review finds: the sliding gap, the jam,
// and a gap repeated once per read. Each is a test for each source, against the strict REST fake — no Databricks call.
import { describe, expect, test } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import { eventsPage } from "../../../src/sources/events.js"
import { depsFor, call, DAY, NOW } from "./harness.js"
import { fakeRest, historyQuery, jobRun } from "./fake-rest.js"

const iso = (ms: number) => new Date(ms).toISOString()
const HOUR = 3_600_000
const kinds = (page: { events: readonly { external_id: string }[] }) => page.events.map((event) => event.external_id)
const secret = "deploy ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

type Seed = NonNullable<Parameters<typeof fakeRest>[0]>
const queryDeps = (history: Seed["history"]) => depsFor(fakeRest({ history }), { assert: async () => undefined } as never)
const runDeps = (runs: Seed["runs"]) => depsFor(fakeRest({ runs }), { assert: async () => undefined } as never)

describe("databricks.queries", () => {
  test("pages oldest first, then answers an empty page", async () => {
    const deps = queryDeps([historyQuery({ id: "q1", ago: 3 * HOUR }), historyQuery({ id: "q2", ago: 2 * HOUR }), historyQuery({ id: "q3", ago: HOUR })])
    const first = await eventsPage(deps, { account: "work", source: "queries", since: iso(NOW - 4 * HOUR), limit: 1, call: call("p1") })
    expect(first.more).toBe(true)
    expect(first.events.map((event) => event.occurred_at)).toEqual([...first.events.map((event) => event.occurred_at)].sort())
    const second = await eventsPage(deps, { account: "work", source: "queries", cursor: first.cursor, limit: 1, call: call("p2") })
    expect(second.more).toBe(true)
    const third = await eventsPage(deps, { account: "work", source: "queries", cursor: second.cursor, limit: 1, call: call("p3") })
    expect(third.more).toBe(false)
    const empty = await eventsPage(deps, { account: "work", source: "queries", cursor: third.cursor, call: call("p4") })
    expect(empty.events).toEqual([])
    expect(empty.more).toBe(false)
    const ids = [...kinds(first), ...kinds(second), ...kinds(third)]
    expect(new Set(ids).size).toBe(3)
  })

  test("the sliding gap: the gap line is carried in the cursor, and the older part is read next, not skipped", async () => {
    // 10,004 statements in the window and a 10,000-statement walk: the page caps. The four oldest are behind the gap.
    const old = Array.from({ length: 10_004 }, (_, index) => historyQuery({ id: `q-old-${index}`, ago: 25 * HOUR + index * 1000 }))
    const deps = queryDeps(old)
    const since = NOW - 48 * HOUR
    const page = await eventsPage(deps, { account: "work", source: "queries", since: iso(since), call: call("gap1") })
    expect(page.more).toBe(true)
    expect(page.gap).toEqual({ reason: "window-truncated", since: iso(since) })
    const next = await eventsPage(deps, { account: "work", source: "queries", cursor: page.cursor, call: call("gap2") })
    expect(next.gap).toBeUndefined()
    // The four oldest statements (the part the capped walk did not fetch) are delivered on the continuation, and none
    // is recomputed from "now": the window's start is the carried gap line.
    expect(next.events.length).toBeGreaterThan(0)
    expect(next.events.every((event) => Date.parse(event.occurred_at) < Date.parse(page.events[0]!.occurred_at))).toBe(true)
  })

  test("the jam: a same-timestamp burst larger than a page drains once each", async () => {
    const at = NOW - HOUR
    const burst = Array.from({ length: 200 }, (_, index) => historyQuery({ id: `q-burst-${String(index).padStart(3, "0")}`, ago: HOUR, start: at, end: at + 3000 }))
    const deps = queryDeps(burst)
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let round = 0; round < 20; round++) {
      const page: Awaited<ReturnType<typeof eventsPage>> = await eventsPage(deps, { account: "work", source: "queries", ...(cursor === undefined ? { since: iso(at - 3600_000) } : { cursor }), limit: 50, call: call(`jam-${round}`) })
      for (const id of kinds(page)) {
        expect(seen.has(id), `duplicate ${id}`).toBe(false)
        seen.add(id)
      }
      cursor = page.cursor
      if (!page.more) break
    }
    expect(seen.size).toBe(200)
  })

  test("a gap is announced once per shortening, not once per read", async () => {
    const old = Array.from({ length: 10_001 }, (_, index) => historyQuery({ id: `q-gap-${index}`, ago: 25 * HOUR + index * 1000 }))
    const deps = queryDeps(old)
    let page = await eventsPage(deps, { account: "work", source: "queries", since: iso(NOW - 48 * HOUR), call: call("g1") })
    expect(page.gap).toBeDefined()
    let gaps = 1
    for (let round = 0; round < 2; round++) {
      page = await eventsPage(deps, { account: "work", source: "queries", cursor: page.cursor, call: call(`g${round + 2}`) })
      if (page.gap) gaps += 1
    }
    expect(gaps).toBe(1)
  })

  test("a secret-shaped title is refused, with its reason, and never listed", async () => {
    const deps = queryDeps([historyQuery({ id: "q-ok", ago: HOUR }), historyQuery({ id: "q-secret", ago: 2 * HOUR, statementType: secret })])
    const page = await eventsPage(deps, { account: "work", source: "queries", since: iso(NOW - 4 * HOUR), call: call("secret") })
    expect(page.events).toHaveLength(1)
    expect(page.refused).toEqual([expect.objectContaining({ reason: "secret" })])
  })

  test("an expired cursor answers a gap and a cursor that restarts", async () => {
    const deps = queryDeps([historyQuery({ id: "q1", ago: HOUR })])
    const expired = (await import("@we-the-rebel-alliance/source-contract/cursor")).encodeBoundCursor(
      (await import("../../../src/sources/cursor.js")).bindingOf("queries", "work", undefined),
      { w: NOW - 31 * DAY, f: NOW - 31 * DAY - 49 * HOUR, h: "" },
    )
    const page = await eventsPage(deps, { account: "work", source: "queries", cursor: expired, call: call("old") })
    expect(page.gap?.reason).toBe("expired")
    const restart = await eventsPage(deps, { account: "work", source: "queries", cursor: page.cursor, call: call("again") })
    expect(restart.gap).toBeUndefined()
  })

  test("a vendor error is the contract's RATE_LIMITED, with the retry", async () => {
    const rest = fakeRest({ history: [historyQuery({ id: "q1", ago: HOUR })] })
    rest.failHistoryOnce(new DatabricksError("RATE_LIMITED", undefined, undefined, undefined, { retryAfterSec: 7 }))
    const deps = depsFor(rest, { assert: async () => undefined } as never)
    await expect(eventsPage(deps, { account: "work", source: "queries", since: iso(NOW - HOUR), call: call("rate") })).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSec: 7 })
  })
})

describe("databricks.runs", () => {
  test("pages runs, carries the workspace owner, and never calls Me", async () => {
    const deps = runDeps([jobRun({ id: 1, ago: 2 * HOUR, result: "SUCCESS" }), jobRun({ id: 2, ago: HOUR, result: "FAILED" })])
    const page = await eventsPage(deps, { account: "work", source: "runs", since: iso(NOW - 4 * HOUR), call: call("runs") })
    expect(page.owner.id).toBe("databricks:fake-workspace.cloud.databricks.com:account:work")
    expect(page.events).toHaveLength(2)
    expect(page.events[0]!.title).toContain("run:")
  })

  test("the sliding gap: a capped run walk keeps its place and reads the older runs next, never from now", async () => {
    const old = Array.from({ length: 1_001 }, (_, measure) => jobRun({ id: 1000 + measure, ago: 25 * HOUR + measure * 1000, result: "SUCCESS" }))
    const deps = runDeps(old)
    const since = NOW - 48 * HOUR
    const first = await eventsPage(deps, { account: "work", source: "runs", since: iso(since), limit: 100, call: call("rgap1") })
    expect(first.more).toBe(true)
    // The page token continues the same window: nothing was lost, so no gap is claimed.
    expect(first.gap).toBeUndefined()
    const seen = new Set(kinds(first))
    let page = first
    for (let round = 0; round < 20 && page.more; round++) {
      page = await eventsPage(deps, { account: "work", source: "runs", cursor: page.cursor, limit: 100, call: call(`rgap-${round}`) })
      for (const id of kinds(page)) {
        expect(seen.has(id), `duplicate ${id}`).toBe(false)
        seen.add(id)
      }
    }
    expect(seen.size).toBe(1_001)
  })

  test("the jam: the design's 1,500-run burst at one timestamp drains once each", async () => {
    const at = NOW - HOUR
    const burst = Array.from({ length: 1_500 }, (_, index) => jobRun({ id: 500_000 + index, ago: HOUR, start: at, end: at + 5000, result: "SUCCESS" }))
    const deps = runDeps(burst)
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let round = 0; round < 40; round++) {
      const page = await eventsPage(deps, { account: "work", source: "runs", ...(cursor === undefined ? { since: iso(at - HOUR) } : { cursor }), limit: 100, call: call(`rjam-${round}`) })
      for (const id of kinds(page)) {
        expect(seen.has(id), `duplicate ${id}`).toBe(false)
        seen.add(id)
      }
      cursor = page.cursor
      if (!page.more) break
    }
    expect(seen.size).toBe(1_500)
  })

  test("a gap is announced once, and a failing pending run holds the cursor", async () => {
    // More active runs than the cursor can hold: the ones beyond the cap cannot be tracked, and the gap says so once.
    const busy = Array.from({ length: 60 }, (_, index) => jobRun({ id: 800_000 + index, ago: 2 * HOUR + index * 1000, life: "RUNNING", result: undefined }))
    const deps = runDeps(busy)
    const page = await eventsPage(deps, { account: "work", source: "runs", since: iso(NOW - 4 * HOUR), call: call("r1") })
    expect(page.gap).toBeDefined()
    const next = await eventsPage(deps, { account: "work", source: "runs", cursor: page.cursor, call: call("r2") })
    expect(next.gap).toBeUndefined()
    const { encodeBoundCursor } = await import("@we-the-rebel-alliance/source-contract/cursor")
    const { bindingOf } = await import("../../../src/sources/cursor.js")
    const held = encodeBoundCursor(bindingOf("runs", "work", undefined), { w: NOW, f: NOW - HOUR, h: "", z: (9_999_999).toString(36) })
    const failed = await eventsPage(deps, { account: "work", source: "runs", cursor: held, call: call("r3") })
    expect(failed.failed).toHaveLength(1)
    expect(failed.cursor).toBe(held)
  })

  test("a secret-shaped run name is refused", async () => {
    const deps = runDeps([jobRun({ id: 1, ago: HOUR, name: secret })])
    const page = await eventsPage(deps, { account: "work", source: "runs", since: iso(NOW - 2 * HOUR), call: call("rsecret") })
    expect(page.events).toEqual([])
    expect(page.refused).toEqual([expect.objectContaining({ reason: "secret" })])
  })

  test("another account's or plugin's cursor is CURSOR_INVALID", async () => {
    const deps = runDeps([jobRun({ id: 1, ago: HOUR })])
    const { encodeBoundCursor } = await import("@we-the-rebel-alliance/source-contract/cursor")
    const other = encodeBoundCursor({ plugin: "other", source: "runs", account: "work" }, { w: NOW, f: NOW - HOUR, h: "" })
    await expect(eventsPage(deps, { account: "work", source: "runs", cursor: other, call: call("foreign") })).rejects.toMatchObject({ code: "CURSOR_INVALID" })
    await expect(eventsPage(deps, { account: "work", source: "nope" as never, call: call("unknown") })).rejects.toMatchObject({ code: "SOURCE_UNKNOWN" })
  })
})
