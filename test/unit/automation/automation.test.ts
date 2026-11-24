/**
 * The automation sweep (design §7 layer 2), after the review of F:
 *
 * - M1: orphaned-read cancels do not depend on the owner lock (each process cancels its own sessions' reads), and the
 *   lock is a real token lock whose holder keeps it. P1 is a test.
 * - M2: a session that ended with nothing running is dropped silently on its first complete history window; only a
 *   cancel that was tried and failed is a problem. P3 is a test.
 * - M4: Query History is scoped to the identity (`user_ids` from `Me`), so another user's tagged statement is never
 *   treated as this plugin's.
 * - It never cancels a change statement or a job run, never stops a warehouse, and never deletes anything.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Automation, consentOf, LOCK_STALE_MS } from "../../../src/automation/index.js"
import { sessionToken } from "../../../src/guards/path.js"
import type { HistoryQuery } from "../../../src/ports.js"
import { loadOptions } from "../../../src/options.js"
import { harness } from "../reads/harness.js"

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

function setup(input: { items?: HistoryQuery[]; cancelFails?: boolean; options?: Record<string, unknown> } = {}) {
  const h = harness({
    ...(input.options ? { options: input.options } : {}),
    answers: {
      me: () => ({ id: "1", userName: "ada@example.com" }),
      history: () => ({ items: input.items ?? [] }),
      cancelStatement: () => (input.cancelFails ? Promise.reject(new Error("refused")) : Promise.resolve(undefined)),
    },
  })
  const automation = new Automation(h.deps, lockIn())
  return { h, automation }
}

const cancels = (h: ReturnType<typeof setup>["h"]) => h.databricks.calls.filter((entry) => entry.method === "cancelStatement")

describe("the automation sweep", () => {
  it("P1: the owner keeps its lock on the next sweep, and a session that ends cancels at once", async () => {
    const { h, automation } = setup({ items: [history({ queryId: "read-mine", queryTags: { oc_plugin: "databricks", oc_tool: "query", oc_session: hash } })] })
    automation.start()
    const ownerAtStart = automation.state().owner
    h.clock.advance(60_000)
    automation.sessionEnded("ses_dead")
    await new Promise((resolve) => setTimeout(resolve, 30))
    const ownerAfterSweep = automation.state().owner
    automation.stop()
    expect(ownerAtStart).toBe(true)
    expect(ownerAfterSweep).toBe(true)
    expect(cancels(h).map((entry) => entry.args[1])).toEqual(["read-mine"])
  })

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
    expect(await automation.cancelOrphans("ses_dead", new AbortController().signal)).toEqual({ found: true, failed: false })
    expect(cancels(h).map((entry) => entry.args[1])).toEqual(["read-mine"])
    expect(cancels(h).every((entry) => entry.args[0] === "work")).toBe(true)
  })

  it("M4: only the identity's own statements are this plugin's, never another user's", async () => {
    const { h, automation } = setup({
      items: [
        history({ queryId: "mine", userId: 1, queryTags: { oc_plugin: "databricks", oc_tool: "query", oc_session: hash } }),
        history({ queryId: "someone-else", userId: 2, queryTags: { oc_plugin: "databricks", oc_tool: "query", oc_session: hash } }),
      ],
    })
    expect(await automation.cancelOrphans("ses_dead", new AbortController().signal)).toEqual({ found: true, failed: false })
    expect(cancels(h).map((entry) => entry.args[1])).toEqual(["mine"])
    // Query History was asked for this identity only.
    const asked = h.databricks.calls.find((entry) => entry.method === "history")!.args[1] as { userIds?: readonly number[] }
    expect(asked.userIds).toEqual([1])
  })

  it("M2 / P3: a session that ended with nothing running is not a problem", async () => {
    const { h, automation } = setup({ items: [] })
    automation.sessionEnded("ses_dead")
    await new Promise((resolve) => setTimeout(resolve, 30))
    h.clock.advance(20 * 60_000)
    await automation.sweep()
    expect(automation.lastProblem()).toBeUndefined()
    expect(cancels(h)).toEqual([])
  })

  it("reports only a cancel that was tried and failed", async () => {
    const { h, automation } = setup({
      cancelFails: true,
      items: [history({ queryId: "read-mine", queryTags: { oc_plugin: "databricks", oc_tool: "query", oc_session: hash } })],
    })
    automation.sessionEnded("ses_dead")
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(automation.lastProblem()).toContain("could not cancel")
    h.clock.advance(11 * 60_000)
    await automation.sweep()
    // Reported and dropped, not retried for ever.
    expect(automation.lastProblem()).toContain("could not cancel")
  })

  it("does not own the lock while another process holds it, and takes over a stale one", async () => {
    const lock = lockIn()
    const { h } = setup()
    const automation = new Automation(h.deps, lock)
    writeFileSync(lock, `another-process\n${NOW}`)
    await automation.sweep()
    expect(automation.state().owner).toBe(false)
    writeFileSync(lock, `dead-process\n${NOW - LOCK_STALE_MS - 1}`)
    h.clock.advance(1_000)
    await automation.sweep()
    expect(automation.state().owner).toBe(true)
  })

  it("never calls anything that could delete or stop: history, Me and cancel only", async () => {
    const { automation, h } = setup({ items: [history({ queryTags: { oc_plugin: "databricks", oc_tool: "query", oc_session: hash } })] })
    await automation.cancelOrphans("ses_dead", new AbortController().signal)
    const methods = new Set(h.databricks.calls.map((entry) => entry.method))
    expect([...methods].sort()).toEqual(["cancelStatement", "history", "me"])
  })

  it("is on at Allowed only, unless the person says on", () => {
    expect(consentOf(loadOptions({}))).toEqual({ mode: "auto", active: true })
    expect(consentOf(loadOptions({ access: "read-only" }))).toEqual({ mode: "auto", active: false })
    expect(consentOf(loadOptions({ access: "read-only", automation: "on" }))).toEqual({ mode: "on", active: true })
    expect(consentOf(loadOptions({ automation: "off" }))).toEqual({ mode: "off", active: false })
  })

  it("keeps its own token in the lock file, and only releases its own", async () => {
    const lock = lockIn()
    const { h } = setup()
    const owned = new Automation(h.deps, lock)
    owned.start()
    expect(owned.state().owner).toBe(true)
    expect(readFileSync(lock, "utf8").split("\n")[0]).toMatch(/^[0-9a-f-]{36}$/u)
    owned.stop()
    expect(() => readFileSync(lock, "utf8")).toThrow()
  })
})
