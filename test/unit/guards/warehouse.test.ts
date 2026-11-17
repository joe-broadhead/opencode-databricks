/**
 * Design §15.1, the must-prove item for package C — **the warehouse policy** (§6.2, D4):
 *
 * - every state × type × size × auto-stop combination: `RUNNING` is used, `STARTING` is waited for, `STOPPED` needs
 *   `start: true`, and `STOPPING`/`DELETING`/`DELETED` are refused;
 * - a start needs serverless, at most `maxStartSize`, and an auto-stop of 1 to `maxStartAutoStopMinutes` minutes; each
 *   failure is `START_REFUSED` with the price per hour and the least a start costs;
 * - the start asserts `databricks.start` on `<account>:warehouse:<id>`, after the table asserts and before
 *   `startWarehouse`;
 * - a failed start is `UNAVAILABLE`, not a silent `started: true`;
 * - a source read (`runningOnly`) never starts one;
 * - the budget: a `refuse` budget answers `BUDGET_REACHED` before a start, `warn` records and goes on; the ledger's lock
 *   makes "check, then charge" one step across two processes; the daily total resets at local midnight; a statement's
 *   charge is `max(duration, min(auto-stop, time since the previous statement)) × DBU/h × clusters` (review M5).
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import { chargeStatement, forgetStatementTimes } from "../../../src/guards/budget.js"
import { prepareRead } from "../../../src/guards/read.js"
import { dbuPerHour, minStartUsd, startVerdict, usdPerHour } from "../../../src/guards/warehouse.js"
import { createLedger, localDay } from "../../../src/ledger.js"
import { loadOptions } from "../../../src/options.js"
import type { LedgerPort, ReadRequest, Warehouse } from "../../../src/ports.js"
import { fakeClock, RecordingPermission } from "../../fake/ports.js"
import { harness, runningWarehouse, statementsSent, tableOf } from "../reads/harness.js"

const SIGNAL = new AbortController().signal
const request = (extra: Partial<ReadRequest> = {}): ReadRequest => ({ account: "work", sql: "select * from main.s.t", tool: "query", sessionID: "ses_test", messageID: "msg_test", callID: "call_1", ...extra })

const warehouse = (overrides: Partial<Warehouse>): Warehouse => runningWarehouse(overrides)

const answersFor = (house: Warehouse, after: Warehouse = runningWarehouse()) => {
  let calls = 0
  return {
    getTable: () => Promise.resolve(tableOf({ fullName: "main.s.t" })),
    getWarehouse: () => {
      calls++
      // The first answer is the state the test asks about; a later one is what a poll after the start sees.
      return calls === 1 ? house : after
    },
  }
}

async function code(options: Record<string, unknown>, house: Warehouse, extra: Partial<ReadRequest> = {}, after?: Warehouse) {
  const h = harness({ options, answers: answersFor(house, after) as never })
  try {
    const prepared = await prepareRead(h.deps, request(extra), SIGNAL)
    return { code: "OK", prepared, h }
  } catch (error) {
    if (error instanceof DatabricksError) return { code: error.code, error, h }
    throw error
  }
}

const base = { accounts: { work: { warehouse: "wh-small" } } }

describe("cost figures (design §6.1)", () => {
  it("prices a size at its DBU rate and the account's list price, and the least a start costs", () => {
    const options = loadOptions({})
    expect(dbuPerHour(warehouse({}))).toBe(12)
    expect(usdPerHour(warehouse({}), options)).toBeCloseTo(8.4)
    expect(usdPerHour(warehouse({ serverless: false, warehouseType: "CLASSIC" }), options)).toBeCloseTo(2.64)
    // A Small serverless warehouse for a 10-minute auto-stop: 12 DBU/h × 10 min = 2 DBU ≈ $1.40.
    expect(minStartUsd(warehouse({}), options)).toBeCloseTo(1.4)
    expect(dbuPerHour(warehouse({ clusterSize: "Huge" }))).toBe(0)
  })
})

describe("the start policy, without a call (design §6.2)", () => {
  it.each([
    ["a serverless Small with auto-stop 10", warehouse({}), true],
    ["a pro (not serverless) one", warehouse({ serverless: false }), false],
    ["a classic one", warehouse({ serverless: false, warehouseType: "CLASSIC" }), false],
    ["a Large one", warehouse({ clusterSize: "Large" }), false],
    ["one whose auto-stop is off", warehouse({ autoStopMins: 0 }), false],
    ["one whose auto-stop is 30 minutes", warehouse({ autoStopMins: 30 }), false],
    ["one whose size is not in the DBU table", warehouse({ clusterSize: "Huge" }), false],
  ])("%s → allowed: %s", (_what, house, allowed) => {
    expect(startVerdict(house, loadOptions({})).allowed).toBe(allowed)
  })

  it("widens with maxStartSize and maxStartAutoStopMinutes, and never with a non-serverless type", () => {
    expect(startVerdict(warehouse({ clusterSize: "Large" }), loadOptions({ maxStartSize: "Large" })).allowed).toBe(true)
    expect(startVerdict(warehouse({ autoStopMins: 30 }), loadOptions({ maxStartAutoStopMinutes: 30 })).allowed).toBe(true)
    expect(startVerdict(warehouse({ serverless: false }), loadOptions({ maxStartSize: "4X-Large" })).allowed).toBe(false)
  })
})

describe("the state machine", () => {
  it("uses a RUNNING warehouse without a start, a charge or a start assert", async () => {
    const result = await code(base, warehouse({}))
    expect(result.code).toBe("OK")
    expect(result.prepared?.started).toBe(false)
    expect(result.h.ledger.charges).toEqual([])
    expect(result.h.permission.requests.map((entry) => entry.action)).toEqual(["databricks.query"])
  })

  it("refuses a STOPPED warehouse without start: true, with the price and the least a start costs", async () => {
    const result = await code(base, warehouse({ state: "STOPPED" }))
    expect(result.code).toBe("WAREHOUSE_STOPPED")
    expect(result.error?.detail).toContain("$8.40/hour")
    expect(result.error?.detail).toContain("$1.40")
    expect(result.h.databricks.calls.map((entry) => entry.method)).not.toContain("startWarehouse")
    expect(result.h.ledger.charges).toEqual([])
  })

  it("starts a STOPPED serverless Small warehouse with start: true: the action, the charge, the wait, the warning", async () => {
    const result = await code(base, warehouse({ state: "STOPPED" }), { start: true })
    expect(result.code).toBe("OK")
    expect(result.prepared?.started).toBe(true)
    expect(result.prepared?.warnings.map((warning) => warning.code)).toContain("STARTED_WAREHOUSE")
    // The table assert comes before the start, so a person's rule on a table stops before anything bills.
    expect(result.h.permission.requests.map((entry) => `${entry.action} on ${entry.resource}`)).toEqual(["databricks.query on work:table:main.s.t", "databricks.start on work:warehouse:wh-small"])
    expect(result.h.databricks.calls.map((entry) => entry.method)).toContain("startWarehouse")
    // 12 DBU/h for a 10-minute auto-stop: 2 DBU-hours.
    expect(result.h.ledger.charges).toHaveLength(1)
    expect(result.h.ledger.charges[0]).toMatchObject({ kind: "start", warehouseId: "wh-small", dbuHours: 2 })
  })

  it.each([
    ["a classic warehouse", warehouse({ state: "STOPPED", serverless: false, warehouseType: "CLASSIC" })],
    ["a Large warehouse", warehouse({ state: "STOPPED", clusterSize: "Large" })],
    ["a warehouse that never auto-stops", warehouse({ state: "STOPPED", autoStopMins: 0 })],
    ["a warehouse with a 30-minute auto-stop", warehouse({ state: "STOPPED", autoStopMins: 30 })],
  ])("refuses to start %s (START_REFUSED), and starts nothing", async (_what, house) => {
    const result = await code(base, house, { start: true })
    expect(result.code).toBe("START_REFUSED")
    expect(result.h.databricks.calls.map((entry) => entry.method)).not.toContain("startWarehouse")
    expect(result.h.ledger.charges).toEqual([])
  })

  it.each(["STOPPING", "DELETING", "DELETED"] as const)("refuses a %s warehouse even with start: true", async (state) => {
    const result = await code(base, warehouse({ state }), { start: true })
    expect(result.code).toBe("WAREHOUSE_STOPPED")
    expect(result.h.databricks.calls.map((entry) => entry.method)).not.toContain("startWarehouse")
  })

  it("waits for a STARTING warehouse to become RUNNING, without starting it", async () => {
    const result = await code({ accounts: { work: { warehouse: "wh-small" } }, wait: 1 }, warehouse({ state: "STARTING" }), {}, warehouse({ state: "RUNNING" }))
    expect(result.code).toBe("OK")
    expect(result.prepared?.started).toBe(false)
    expect(result.h.databricks.calls.map((entry) => entry.method)).not.toContain("startWarehouse")
    expect(result.h.databricks.calls.filter((entry) => entry.method === "getWarehouse").length).toBeGreaterThan(1)
  })

  it("answers UNAVAILABLE when a STARTING warehouse does not reach RUNNING within the wait", async () => {
    const result = await code({ accounts: { work: { warehouse: "wh-small" } }, wait: 0 }, warehouse({ state: "STARTING" }))
    expect(result.code).toBe("UNAVAILABLE")
    expect(result.error?.detail).toContain("did not reach RUNNING")
  })

  it("a source read never starts one: runningOnly refuses a stopped warehouse even with start: true", async () => {
    const result = await code(base, warehouse({ state: "STOPPED" }), { start: true, runningOnly: true, tool: "saved_read" })
    expect(result.code).toBe("UNAVAILABLE")
    expect(result.error?.detail).toContain("never starts one")
    expect(result.h.databricks.calls.map((entry) => entry.method)).not.toContain("startWarehouse")
  })
})

describe("the start is the person's to allow (review LOW 1)", () => {
  it("a denied databricks.start neither starts the warehouse nor charges the ledger", async () => {
    const permission = new RecordingPermission((entry) => (entry.action === "databricks.start" ? "deny" : "allow"))
    const h = harness({ permission, answers: answersFor(warehouse({ state: "STOPPED" })) as never })
    await expect(prepareRead(h.deps, request({ start: true }), SIGNAL)).rejects.toThrow(/denied: databricks.start on work:warehouse:wh-small/)
    expect(h.databricks.calls.map((entry) => entry.method)).not.toContain("startWarehouse")
    // A `refuse` budget of N starts keeps its N: a denied start never used one up.
    expect(h.ledger.charges).toEqual([])
  })
})

describe("the call's own wait (review LOW 3)", () => {
  it("governs how long a STARTING warehouse is awaited, not the wait option", async () => {
    const h = harness({ options: { accounts: { work: { warehouse: "wh-small" } }, wait: 50 }, answers: answersFor(warehouse({ state: "STARTING" })) as never })
    // With the call's wait of 0, nothing is polled: the call fails at once instead of blocking for 50 seconds.
    await expect(prepareRead(h.deps, request(), SIGNAL, 0)).rejects.toThrow(/did not reach RUNNING within 0 seconds/)
    expect(h.databricks.calls.filter((entry) => entry.method === "getWarehouse")).toHaveLength(1)
  })
})

describe("the budget (design §6.2)", () => {
  const tempLedger = () => {
    const dir = mkdtempSync(join(tmpdir(), "dbx-budget-"))
    const clock = fakeClock(new Date(2026, 10, 17, 12, 0, 0).getTime())
    return {
      dir,
      clock,
      ledger: () => createLedger({ path: join(dir, "spend.jsonl"), now: () => new Date(clock.now()) }),
      done: () => rmSync(dir, { recursive: true, force: true }),
    }
  }

  it("a refuse budget answers BUDGET_REACHED before a start, and starts nothing", async () => {
    forgetStatementTimes()
    const temp = tempLedger()
    try {
      const ledger = temp.ledger()
      const h = harness({ options: { ...base, budget: { daily: { starts: 0 }, action: "refuse" } }, answers: answersFor(warehouse({ state: "STOPPED" })) as never })
      const deps = { ...h.deps, ledger }
      await expect(prepareRead(deps, request({ start: true }), SIGNAL)).rejects.toThrow(/BUDGET_REACHED/)
      expect(h.databricks.calls.map((entry) => entry.method)).not.toContain("startWarehouse")
      expect(await ledger.totals("work")).toMatchObject({ startsToday: 0, dbuHoursToday: 0 })
    } finally {
      temp.done()
    }
  })

  it("a warn budget records the start and goes on", async () => {
    forgetStatementTimes()
    const temp = tempLedger()
    try {
      const ledger = temp.ledger()
      const h = harness({ options: { ...base, budget: { daily: { starts: 0 }, action: "warn" } }, answers: answersFor(warehouse({ state: "STOPPED" })) as never })
      const deps = { ...h.deps, ledger }
      const prepared = await prepareRead(deps, request({ start: true }), SIGNAL)
      expect(prepared.started).toBe(true)
      expect(h.databricks.calls.map((entry) => entry.method)).toContain("startWarehouse")
      expect((await ledger.totals("work")).startsToday).toBe(1)
    } finally {
      temp.done()
    }
  })

  it("holds across two processes: two ledgers over one file, one start left, exactly one start", async () => {
    const temp = tempLedger()
    try {
      const first = temp.ledger()
      const second = temp.ledger()
      const budget = { daily: { starts: 1 }, action: "refuse" } as const
      const charge = (ledger: LedgerPort, warehouseId: string) => ledger.charge({ account: "work", warehouseId, kind: "start", dbuHours: 2 }, budget)
      const [left, right] = await Promise.all([charge(first, "wh-a"), charge(second, "wh-b")])
      expect([left.recorded, right.recorded].filter(Boolean)).toHaveLength(1)
      expect([left, right].flatMap((result) => (result.exceeded ? [result.exceeded] : []))).toEqual(["daily starts"])
      expect((await first.totals("work")).startsToday).toBe(1)
    } finally {
      temp.done()
    }
  })

  it("resets at local midnight, not at a UTC one", async () => {
    const temp = tempLedger()
    try {
      const ledger = temp.ledger()
      await ledger.charge({ account: "work", warehouseId: "wh-small", kind: "start", dbuHours: 2 })
      expect((await ledger.totals("work")).startsToday).toBe(1)
      const late = new Date(2026, 10, 17, 23, 59, 0)
      expect(localDay(late)).toBe("2026-11-17")
      temp.clock.advance(new Date(2026, 10, 18, 0, 1, 0).getTime() - temp.clock.now())
      expect((await ledger.totals("work")).startsToday).toBe(0)
      expect((await ledger.totals("work")).dbuHoursToday).toBe(0)
      expect((await ledger.totals("work")).dbuHoursSession).toBe(0)
    } finally {
      temp.done()
    }
  })

  it("charges a statement max(duration, min(auto-stop, time since the previous statement)) × DBU/h × clusters", async () => {
    forgetStatementTimes()
    const temp = tempLedger()
    try {
      const ledger = temp.ledger()
      const clock = temp.clock
      const options = loadOptions({})
      // A 2-second statement on an otherwise idle warehouse keeps it up for its 10-minute auto-stop: 2 DBU-hours.
      await chargeStatement(ledger, clock, options, { account: "work", warehouseId: "wh-small", size: "Small", autoStopMinutes: 10, durationMs: 2000 })
      let totals = await ledger.totals("work")
      expect(totals.dbuHoursToday).toBeCloseTo(2)
      // A second statement a minute later is covered by the idle time since the first, so it adds one minute: 0.2 DBU.
      clock.advance(60_000)
      await chargeStatement(ledger, clock, options, { account: "work", warehouseId: "wh-small", size: "Small", autoStopMinutes: 10, durationMs: 2000 })
      totals = await ledger.totals("work")
      expect(totals.dbuHoursToday).toBeCloseTo(2.2)
      // Two clusters double it (design §6.2: × clusters seen).
      forgetStatementTimes()
      await chargeStatement(ledger, clock, options, { account: "work", warehouseId: "wh-two", size: "Small", autoStopMinutes: 10, clusters: 2, durationMs: 0 })
      expect((await ledger.totals("work")).dbuHoursToday).toBeCloseTo(2.2 + 4)
    } finally {
      temp.done()
    }
  })
})

describe("what a read never does", () => {
  it("sends no statement when the warehouse policy refuses", async () => {
    const result = await code(base, warehouse({ state: "STOPPED" }))
    expect(result.code).toBe("WAREHOUSE_STOPPED")
    expect(statementsSent(result.h.databricks)).toEqual([])
  })

  it("does not start a warehouse the first answer said was running and a later one stopped (TOCTOU is documented, not hidden)", async () => {
    // The guard's own answer is stale by one round trip; Databricks restarts a stopped warehouse on submit [18]. The
    // test pins that the guard checked and did not start, so status can count such a start as ours.
    const result = await code(base, warehouse({ state: "RUNNING" }), {}, warehouse({ state: "STOPPED" }))
    expect(result.code).toBe("OK")
    expect(result.prepared?.started).toBe(false)
    expect(result.h.databricks.calls.map((entry) => entry.method)).not.toContain("startWarehouse")
  })
})
