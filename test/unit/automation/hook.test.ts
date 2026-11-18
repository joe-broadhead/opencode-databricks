/**
 * The context hook (design §7 layer 3, boxd C.4): one line, at most 200 characters, on the request's tail only, only
 * from a fresh snapshot, only for a session that has used a Databricks tool, and only when its fingerprint changed.
 * `system` is never touched.
 */
import { describe, expect, it } from "vitest"
import { Automation } from "../../../src/automation/index.js"
import { appendTail, fingerprintOf, registerContextHook } from "../../../src/hooks/context.js"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { harness } from "../reads/harness.js"
import { startOf, withStarts } from "./support.js"

const NOW = 1_800_000_000_000

async function setup(idleMinutes = 14) {
  const h = harness({
    answers: {
      listWarehouses: () => [h_warehouse()],
      history: () => ({ items: [{ queryId: "q", status: "FINISHED", warehouseId: "wh-small", queryStartTimeMs: NOW - idleMinutes * 60_000, queryEndTimeMs: NOW - idleMinutes * 60_000 }] }),
    },
  })
  const dir = mkdtempSync(join(tmpdir(), "dbx-hook-"))
  withStarts(h.ledger, [startOf("wh-small", NOW - 60_000)])
  const automation = new Automation(h.deps, join(dir, "automation.lock"))
  await automation.refreshIdle(new AbortController().signal)
  let callback: ((event: unknown) => void) | undefined
  const ctx = { session: { hook: async (_name: string, cb: (event: unknown) => void) => { callback = cb; return { dispose: async () => undefined } } } }
  await registerContextHook(ctx as never, automation, h.clock, "all")
  return { h, automation, fire: (event: unknown) => callback!(event), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function h_warehouse() {
  return { id: "wh-small", name: "bi-small", state: "RUNNING" as const, warehouseType: "PRO" as const, serverless: true, clusterSize: "Small", autoStopMins: 10, minNumClusters: 1, maxNumClusters: 1 }
}

const request = () => ({ sessionID: "ses_test", system: [{ type: "text", text: "built by OpenCode" }], messages: [{ role: "user", content: [{ type: "text", text: "run databricks_query for me" }] }], tools: {} })

describe("the context hook", () => {
  it("appends one part to a final user message, and one user message after a tool message", () => {
    const user = { role: "user", content: [{ type: "text", text: "hi" }] }
    appendTail([user], "line")
    expect(user.content).toHaveLength(2)
    const tool = { role: "tool", content: [{ type: "tool-result", text: "x" }] }
    const messages = [tool]
    appendTail(messages, "line")
    expect(messages).toHaveLength(2)
    expect(messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "line" }] })
  })

  it("adds the line once per fingerprint, on the tail, and never to system", async () => {
    const { h, automation, fire, cleanup } = await setup()
    try {
      const event = request()
      const system = JSON.stringify(event.system)
      fire(event)
      expect(event.messages).toHaveLength(1)
      expect(event.messages[0]!.content).toHaveLength(2)
      expect(JSON.stringify(event.system)).toBe(system)
      const line = (event.messages[0]!.content as { text: string }[])[1]!.text
      expect(line.length).toBeLessThanOrEqual(200)
      expect(line).toContain("databricks_stop")
      // The same state adds nothing on the next request.
      const again = request()
      fire(again)
      expect(again.messages[0]!.content).toHaveLength(1)
      // 30 idle minutes later, with a fresh snapshot, is a new bucket: one new line.
      h.clock.advance(30 * 60_000)
      await automation.refreshIdle(new AbortController().signal)
      const later = request()
      fire(later)
      expect(later.messages[0]!.content).toHaveLength(2)
    } finally {
      cleanup()
    }
  })

  it("adds nothing to a session that has not used a Databricks tool", async () => {
    const { fire, cleanup } = await setup()
    try {
      const event = { ...request(), messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }
      fire(event)
      expect(event.messages[0]!.content).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  it("adds nothing from a stale snapshot", async () => {
    const { h, fire, cleanup } = await setup()
    try {
      h.clock.advance(10 * 60_000)
      const event = request()
      fire(event)
      expect(event.messages[0]!.content).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  it("fingerprints the warehouse set and an idle time in 30-minute buckets", () => {
    const item = { account: "work", warehouse: h_warehouse(), idleMinutes: 14, usdPerHour: 8.4 }
    expect(fingerprintOf([item], "all")).toBe(fingerprintOf([{ ...item, idleMinutes: 20 }], "all"))
    expect(fingerprintOf([item], "all")).not.toBe(fingerprintOf([{ ...item, idleMinutes: 46 }], "all"))
    expect(fingerprintOf([item], "all")).not.toBe(fingerprintOf([{ ...item, warehouse: { ...item.warehouse, id: "wh-2" } }], "all"))
  })

  it("never throws into the model request", async () => {
    const { fire, cleanup } = await setup()
    try {
      const bad = { sessionID: "ses_test", messages: null, system: [], tools: {} }
      expect(() => fire(bad)).not.toThrow()
    } finally {
      cleanup()
    }
  })
})
