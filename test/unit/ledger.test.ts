// The spend ledger and its formulas (design §6.2), across processes.
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { DBU_PER_HOUR, startDbuHours, statementDbuHours } from "../../src/domain/cost.js"
import { createPlanStore } from "../../src/domain/plans.js"
import { createLedger, defaultLedgerPath, localDay } from "../../src/ledger.js"

const dirs: string[] = []
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "dbx-ledger-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("cost formulas", () => {
  it("charge a start its auto-stop period, and a statement at least one auto-stop period after idle", () => {
    expect(startDbuHours({ size: "Small", autoStopMinutes: 10 })).toBeCloseTo(2)
    expect(statementDbuHours({ size: "Small", durationMs: 2_000, autoStopMinutes: 10 })).toBeCloseTo(2)
    expect(statementDbuHours({ size: "Small", durationMs: 2_000, autoStopMinutes: 10, sincePreviousMs: 60_000 })).toBeCloseTo(0.2)
    expect(statementDbuHours({ size: "Small", durationMs: 30 * 60_000, autoStopMinutes: 10, sincePreviousMs: 1_000 })).toBeCloseTo(6)
    expect(statementDbuHours({ size: "Small", durationMs: 0, autoStopMinutes: 10, clusters: 2 })).toBeCloseTo(4)
    expect(DBU_PER_HOUR["2X-Small"]).toBe(4)
  })
})

describe("the ledger", () => {
  it("sums today's and the session's charges, and refuses past a refuse budget without recording", async () => {
    const ledger = createLedger({ path: join(temp(), "spend.jsonl") })
    const budget = { daily: { starts: 1 }, action: "refuse" as const }
    const first = await ledger.charge({ account: "work", sessionId: "s1", warehouseId: "wh", kind: "start", dbuHours: 2 }, budget)
    expect(first).toMatchObject({ recorded: true, totals: { startsToday: 1, dbuHoursToday: 2, startsSession: 1 } })
    const second = await ledger.charge({ account: "work", sessionId: "s1", warehouseId: "wh", kind: "start", dbuHours: 2 }, budget)
    expect(second).toMatchObject({ recorded: false, exceeded: "daily starts", totals: { startsToday: 1 } })
    const warned = await ledger.charge({ account: "work", warehouseId: "wh", kind: "start", dbuHours: 2 }, { ...budget, action: "warn" })
    expect(warned).toMatchObject({ recorded: true, exceeded: "daily starts" })
    expect(await ledger.totals("other")).toMatchObject({ startsToday: 0, dbuHoursToday: 0 })
  })

  it("resets at local midnight and skips a torn line", async () => {
    const path = join(temp(), "spend.jsonl")
    let now = new Date(2026, 10, 17, 23, 59)
    const ledger = createLedger({ path, now: () => now })
    await ledger.charge({ account: "work", warehouseId: "wh", kind: "statement", dbuHours: 1 })
    writeFileSync(path, `${readFileSync(path, "utf8")}{"torn`, { flag: "w" })
    expect((await ledger.totals("work")).dbuHoursToday).toBe(1)
    now = new Date(2026, 10, 18, 0, 1)
    expect((await ledger.totals("work")).dbuHoursToday).toBe(0)
    expect(localDay(new Date(2026, 0, 2))).toBe("2026-01-02")
  })

  it("keeps a refuse budget across processes: 8 processes race for 3 starts", async () => {
    const path = join(temp(), "spend.jsonl")
    const ledgerModule = fileURLToPath(new URL("../../src/ledger.ts", import.meta.url))
    const script = `import { createLedger } from ${JSON.stringify(ledgerModule)}; const l = createLedger({ path: ${JSON.stringify(path)} }); const r = await l.charge({ account: "work", warehouseId: "wh", kind: "start", dbuHours: 1 }, { daily: { starts: 3 }, action: "refuse" }); console.log(r.recorded)`
    const runs = await Promise.all(
      Array.from({ length: 8 }, () =>
        new Promise<string>((resolve, reject) => {
          const child = spawn("bun", ["-e", script], { stdio: ["ignore", "pipe", "inherit"] })
          let out = ""
          child.stdout.on("data", (chunk) => void (out += chunk))
          child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}`))))
        }),
      ),
    )
    expect(runs.filter((value) => value === "true")).toHaveLength(3)
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(3)
  }, 60_000)

  it("lives under XDG_STATE_HOME", () => {
    expect(defaultLedgerPath({ XDG_STATE_HOME: "/state" })).toBe("/state/databricks/spend.jsonl")
  })
})

describe("the ledger's start record (review of #10, request 4)", () => {
  it("reads back this account's start lines since a time, oldest first, from what charge already writes", async () => {
    const path = join(temp(), "spend.jsonl")
    let now = Date.parse("2026-11-18T10:00:00Z")
    const ledger = createLedger({ path, now: () => new Date(now) })
    await ledger.charge({ account: "work", sessionId: "s1", warehouseId: "wh-a", kind: "start", dbuHours: 2 })
    now += 60_000
    await ledger.charge({ account: "work", sessionId: "s1", warehouseId: "wh-a", kind: "statement", dbuHours: 0.1, statementId: "st-1" })
    await ledger.charge({ account: "other", sessionId: "s1", warehouseId: "wh-x", kind: "start", dbuHours: 2 })
    now += 60_000
    await ledger.charge({ account: "work", warehouseId: "wh-b", kind: "start", dbuHours: 1 })
    const at = Date.parse("2026-11-18T10:00:00Z")
    expect(await ledger.starts("work", 0)).toEqual([
      { warehouseId: "wh-a", atMs: at, sessionId: "s1" },
      { warehouseId: "wh-b", atMs: at + 120_000, sessionId: "" },
    ])
    expect(await ledger.starts("work", at + 1)).toEqual([{ warehouseId: "wh-b", atMs: at + 120_000, sessionId: "" }])
    expect(await ledger.starts("nobody", 0)).toEqual([])
    // It reads the lines another process wrote too: the ledger is the shared file, not this object's memory.
    expect(await createLedger({ path }).starts("other", 0)).toEqual([{ warehouseId: "wh-x", atMs: at + 60_000, sessionId: "s1" }])
  })
})

describe("the plan store", () => {
  it("binds a plan to its caller, uses it once, expires it, and bounds memory", () => {
    let now = 0
    const store = createPlanStore({ ttlSeconds: 300, now: () => now, max: 2 })
    const make = () => store.create({ category: "delete", kind: "DropTableContext", account: "work", sessionId: "s", agentId: "a", payload: { kind: "sql", sql: "drop table t", warehouse: "wh" }, preview: {}, fingerprint: { targets: ["t"] } })
    const one = make()
    expect(() => store.take(one.id, "delete", { sessionId: "s", agentId: "other", account: "work" })).toThrow(/PLAN_CALLER_MISMATCH/)
    expect(() => store.take(one.id, "write", { sessionId: "s", agentId: "a", account: "work" })).toThrow(/CATEGORY_MISMATCH/)
    expect(store.take(one.id, "delete", { sessionId: "s", agentId: "a", account: "work" }).id).toBe(one.id)
    expect(() => store.take(one.id, "delete", { sessionId: "s", agentId: "a", account: "work" })).toThrow(/PLAN_ALREADY_USED/)
    const two = make()
    now = 300_000
    expect(() => store.take(two.id, "delete", { sessionId: "s", agentId: "a", account: "work" })).toThrow(/PLAN_EXPIRED/)
    make()
    make()
    expect(store.peek(one.id)).toBeUndefined()
    expect(() => store.take("pln_missing", "delete", { sessionId: "s", agentId: "a", account: "work" })).toThrow(/PLAN_NOT_FOUND/)
  })
})
