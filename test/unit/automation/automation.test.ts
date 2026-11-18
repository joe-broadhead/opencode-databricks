/**
 * The automation sweep (design §7 layer 2): it cancels this plugin's own orphaned **reads**, at every access level, and
 * only those. It never cancels a change statement or a job run, never stops a warehouse, and never deletes anything.
 * It also keeps the idle-warehouse snapshot the context hook and status read, and one owner per state folder.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Automation, burningLine, consentOf, LOCK_STALE_MS } from "../../../src/automation/index.js"
import { sessionToken } from "../../../src/guards/path.js"
import type { HistoryQuery, Warehouse } from "../../../src/ports.js"
import { loadOptions } from "../../../src/options.js"
import { harness, runningWarehouse } from "../reads/harness.js"

const NOW = 1_800_000_000_000
const hash = sessionToken("ses_dead")
const history = (over: Partial<HistoryQuery> = {}): HistoryQuery => ({ queryId: "q-1", status: "RUNNING", warehouseId: "wh-small", queryStartTimeMs: NOW - 60_000, ...over })

const dirs: string[] = []
const lockIn = () => {
  const dir = mkdtempSync(join(tmpdir(), "dbx-automation-"))
  dirs.push(dir)
  return join(dir, "automation.lock")
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup(input: { items?: HistoryQuery[]; warehouses?: Warehouse[]; options?: Record<string, unknown> } = {}) {
  const h = harness({
    ...(input.options ? { options: input.options } : {}),
    answers: {
      listWarehouses: () => input.warehouses ?? [runningWarehouse()],
      history: () => ({ items: input.items ?? [] }),
      cancelStatement: () => Promise.resolve(undefined),
      stopWarehouse: () => Promise.resolve(undefined),
    },
  })
  const automation = new Automation(h.deps, lockIn())
  return { h, automation }
}

describe("the automation sweep", () => {
  it("cancels the read statements of the session that ended, and no others", async () => {
    const { h, automation } = setup({
      items: [
        history({ queryId: "read-mine", queryTags: { oc_plugin: "databricks", oc_tool: "query", oc_session: hash } }),
        history({ queryId: "change-mine", queryTags: { oc_plugin: "databricks", oc_tool: "write", oc_session: hash } }),
        history({ queryId: "read-other", queryTags: { oc_plugin: "databricks", oc_tool: "query", oc_session: sessionToken("ses_alive") } }),
        history({ queryId: "not-ours", queryTags: { oc_plugin: "other", oc_tool: "query", oc_session: hash } }),
        history({ queryId: "done-mine", status: "FINISHED", queryTags: { oc_plugin: "databricks", oc_tool: "query", oc_session: hash } }),
      ],
    })
    expect(await automation.cancelOrphans("ses_dead", new AbortController().signal)).toBe(true)
    const cancelled = h.databricks.calls.filter((entry) => entry.method === "cancelStatement")
    expect(cancelled.map((entry) => entry.args[1])).toEqual(["read-mine"])
    // A change statement is never cancelled, and no other plugin's statement is touched.
    expect(cancelled.every((entry) => entry.args[0] === "work")).toBe(true)
  })

  it("queues a session that ended and cancels on the sweep", async () => {
    const { h, automation } = setup({ items: [history({ queryId: "read-mine", queryTags: { oc_plugin: "databricks", oc_tool: "query", oc_session: hash } })] })
    automation.sessionEnded("ses_dead")
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(h.databricks.calls.filter((entry) => entry.method === "cancelStatement").map((entry) => entry.args[1])).toEqual(["read-mine"])
  })

  it("does not sweep when another process owns the lock, and takes over a stale one", async () => {
    const lock = lockIn()
    const { h } = setup({ items: [history({ queryId: "read-mine", queryTags: { oc_plugin: "databricks", oc_tool: "query", oc_session: hash } })] })
    const owned = new Automation(h.deps, lock)
    writeFileSync(lock, String(NOW))
    await owned.sweep()
    expect(owned.state().owner).toBe(false)
    expect(h.databricks.calls.filter((entry) => entry.method === "cancelStatement")).toEqual([])
    // The owner died LOCK_STALE_MS ago: the next sweep takes the lock and acts.
    writeFileSync(lock, String(NOW - LOCK_STALE_MS - 1))
    h.clock.advance(1_000)
    await owned.sweep()
    expect(owned.state().owner).toBe(true)
  })

  it("keeps the idle snapshot: a running warehouse with nothing visible for autoStopIdleMinutes, biggest first", async () => {
    const busy: Warehouse = { ...runningWarehouse(), id: "wh-busy", name: "busy", clusterSize: "Large" }
    const { h, automation } = setup({
      warehouses: [runningWarehouse(), busy, { ...runningWarehouse(), id: "wh-stopped", state: "STOPPED" }],
      items: [
        history({ queryId: "old", status: "FINISHED", warehouseId: "wh-small", queryEndTimeMs: NOW - 42 * 60_000 }),
        history({ queryId: "fresh", status: "FINISHED", warehouseId: "wh-busy", queryEndTimeMs: NOW - 2 * 60_000 }),
      ],
    })
    const burning = await automation.refreshIdle(new AbortController().signal)
    expect(burning.map((item) => item.warehouse.id)).toEqual(["wh-small"])
    expect(burning[0]).toMatchObject({ account: "work", idleMinutes: 42, usdPerHour: 8.399999999999999 })
    expect(h.databricks.calls.filter((entry) => entry.method === "stopWarehouse")).toEqual([])
    // The snapshot expires after SNAPSHOT_TTL_MS: a stale estimate is no line.
    h.clock.advance(6 * 60_000)
    expect(automation.burning(h.clock.now())).toEqual([])
  })

  it("says one line, at most 200 characters, with the warehouse and the call", async () => {
    const { automation, h } = setup({ items: [history({ status: "FINISHED", queryEndTimeMs: NOW - 14 * 60_000 })] })
    const burning = await automation.refreshIdle(new AbortController().signal)
    const line = burningLine(burning)!
    expect(line.length).toBeLessThanOrEqual(200)
    expect(line).toContain('warehouse "bi-small"')
    expect(line).toContain("~$8.40/h")
    expect(line).toContain("idle 14 min")
    expect(line).toContain("databricks_stop")
    expect(line).toContain('warehouse: "wh-small"')
    expect(burningLine([])).toBeUndefined()
    expect(h.databricks.calls.some((entry) => entry.method === "stopWarehouse")).toBe(false)
  })

  it("never calls anything that could delete or stop: history and the warehouse list only", async () => {
    const { automation, h } = setup({ items: [history({ queryTags: { oc_plugin: "databricks", oc_tool: "query", oc_session: hash } })] })
    await automation.cancelOrphans("ses_dead", new AbortController().signal)
    await automation.refreshIdle(new AbortController().signal)
    const methods = new Set(h.databricks.calls.map((entry) => entry.method))
    expect([...methods].sort()).toEqual(["cancelStatement", "history", "listWarehouses"])
  })

  it("is on at Allowed only, unless the person says on", () => {
    expect(consentOf(loadOptions({}))).toEqual({ mode: "auto", active: true })
    expect(consentOf(loadOptions({ access: "read-only" }))).toEqual({ mode: "auto", active: false })
    expect(consentOf(loadOptions({ access: "read-only", automation: "on" }))).toEqual({ mode: "on", active: true })
    expect(consentOf(loadOptions({ automation: "off" }))).toEqual({ mode: "off", active: false })
  })
})
