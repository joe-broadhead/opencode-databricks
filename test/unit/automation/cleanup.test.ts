/**
 * `/databricks-cleanup` (design §7 layer 4): a command only a person types. At `read-only` it reports and takes no
 * action, no prompt and no changing call; at `ask-changes` each action is one `ctx.permission.assert` with no `source`
 * — the host's prompt, which only a person answers — and a denial changes nothing; at `all` the typed command is the
 * confirmation. It stops and cancels, and nothing else: no delete, no change statement.
 */
import { describe, expect, it } from "vitest"
import { planCleanup, registerCleanup } from "../../../src/automation/cleanup.js"
import type { HistoryQuery } from "../../../src/ports.js"
import { harness, runningWarehouse } from "../reads/harness.js"
import { recordStart } from "./support.js"

const NOW = 1_800_000_000_000
const history = (over: Partial<HistoryQuery> = {}): HistoryQuery => ({ queryId: "q-1", status: "RUNNING", warehouseId: "wh-small", queryStartTimeMs: NOW - 60_000, ...over })

function setup(access: "all" | "ask-changes" | "read-only", items: HistoryQuery[] = [], warehouses = [runningWarehouse(), { ...runningWarehouse(), id: "wh-stopped", name: "stopped", state: "STOPPED" as const }]) {
  const h = harness({
    options: { access },
    answers: {
      me: () => ({ id: "42", userName: "ada@example.com" }),
      listWarehouses: () => warehouses,
      history: () => ({ items }),
      cancelStatement: () => Promise.resolve(undefined),
      stopWarehouse: () => Promise.resolve(undefined),
    },
  })
  const commands: { name: string; execute: (input: { sessionID: string; delivery: unknown }) => Promise<void> }[] = []
  const messages: { sessionID: string; text: string }[] = []
  const asserts: { sessionID: string; action: string; resources: readonly string[]; source?: unknown }[] = []
  let allow = true
  const ctx = {
    command: {
      transform: async (callback: (editor: { add(command: unknown): void }) => void) => {
        callback({ add: (command) => commands.push(command as never) })
        return { dispose: async () => undefined }
      },
    },
    permission: {
      assert: async (input: { sessionID: string; action: string; resources: readonly string[]; source?: unknown }) => {
        asserts.push(input)
        if (!allow) throw new Error("denied")
      },
    },
    session: { synthetic: async (input: { sessionID: string; text: string }) => void messages.push(input) },
  }
  recordStart(h.ledger, "work", "wh-small", NOW - 60_000)
  return { h, ctx: ctx as never, commands, messages, asserts, deny: () => void (allow = false) }
}

const read = history({ queryId: "read-1", queryTags: { oc_plugin: "databricks", oc_tool: "query" } })
const change = history({ queryId: "change-1", queryTags: { oc_plugin: "databricks", oc_tool: "write" } })

describe("/databricks-cleanup", () => {
  it("plans a report with a cancel for the read, a stop for the running warehouse, and no action for the change", async () => {
    const { h } = setup("ask-changes", [read, change])
    const plan = await planCleanup(h.deps, "ses_test", new AbortController().signal)
    expect(plan.text).toContain("Databricks cleanup")
    expect(plan.text).toContain("Statements this plugin started")
    expect(plan.text).toContain("Running warehouses")
    expect(plan.text).toContain("Nothing here deletes a table, file, job, warehouse or result.")
    expect(plan.actions.filter((action) => action.kind === "cancel").map((action) => (action.kind === "cancel" ? action.statementId : ""))).toEqual(["read-1"])
    expect(plan.actions.filter((action) => action.kind === "stop").map((action) => (action.kind === "stop" ? action.warehouseId : ""))).toEqual(["wh-small"])
    // Planning asserts nothing and changes nothing.
    expect(h.permission.requests).toEqual([])
    expect(h.databricks.calls.filter((entry) => entry.method === "stopWarehouse" || entry.method === "cancelStatement")).toEqual([])
  })

  it("at read-only, reports and takes no action, with no prompt", async () => {
    const { h, ctx, commands, messages, asserts } = setup("read-only", [read])
    await registerCleanup(ctx, h.deps)
    await commands[0]!.execute({ sessionID: "ses_test", delivery: "immediate" })
    expect(asserts).toEqual([])
    expect(h.databricks.calls.filter((entry) => entry.method === "stopWarehouse" || entry.method === "cancelStatement")).toEqual([])
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toContain("Read only")
    expect(messages[0]!.text).toContain("takes no action")
  })

  it("at ask-changes, asserts each action's own dotted action without a source, then acts", async () => {
    const { h, ctx, commands, messages, asserts } = setup("ask-changes", [read])
    await registerCleanup(ctx, h.deps)
    await commands[0]!.execute({ sessionID: "ses_test", delivery: "immediate" })
    expect(asserts).toEqual([
      { sessionID: "ses_test", action: "databricks.cancel", resources: ["work:sql.statements.cancel"], metadata: { what: expect.stringContaining("cancel the query statement") } },
      { sessionID: "ses_test", action: "databricks.stop", resources: ["work:warehouse:wh-small"], metadata: { what: expect.stringContaining("stop warehouse") } },
    ])
    expect(asserts.every((input) => input.source === undefined)).toBe(true)
    const cancelled = h.databricks.calls.filter((entry) => entry.method === "cancelStatement")
    expect(cancelled.map((entry) => entry.args[1])).toEqual(["read-1"])
    const stopped = h.databricks.calls.filter((entry) => entry.method === "stopWarehouse")
    expect(stopped.map((entry) => entry.args[1])).toEqual(["wh-small"])
    expect(messages).toHaveLength(2)
    expect(messages[1]!.text).toContain("done: cancel the query statement")
    expect(messages[1]!.text).toContain("Nothing was deleted.")
  })

  it("keeps going after a denial, changing nothing for that action", async () => {
    const { h, ctx, commands, messages, deny } = setup("ask-changes", [read])
    deny()
    await registerCleanup(ctx, h.deps)
    await commands[0]!.execute({ sessionID: "ses_test", delivery: "immediate" })
    expect(h.databricks.calls.filter((entry) => entry.method === "stopWarehouse" || entry.method === "cancelStatement")).toEqual([])
    expect(messages[1]!.text).toContain("not done: cancel the query statement")
    expect(messages[1]!.text).toContain("not done: stop warehouse")
  })

  it("at Allowed, the typed command is the confirmation, and every action still asserts so a person's rule wins", async () => {
    const { h, ctx, commands, messages, asserts } = setup("all", [read])
    await registerCleanup(ctx, h.deps)
    await commands[0]!.execute({ sessionID: "ses_test", delivery: "immediate" })
    expect(asserts.map((input) => input.action)).toEqual(["databricks.cancel", "databricks.stop"])
    expect(h.databricks.calls.some((entry) => entry.method === "cancelStatement")).toBe(true)
    expect(h.databricks.calls.some((entry) => entry.method === "stopWarehouse")).toBe(true)
    expect(messages[1]!.text).toContain("done:")
  })

  it("M3: at Allowed a person's deny rule stops the action, even though the command is the confirmation", async () => {
    const { h, ctx, commands, messages, asserts, deny } = setup("all", [read])
    deny()
    await registerCleanup(ctx, h.deps)
    await commands[0]!.execute({ sessionID: "ses_test", delivery: "immediate" })
    expect(asserts.map((input) => input.action)).toEqual(["databricks.cancel", "databricks.stop"])
    expect(h.databricks.calls.filter((entry) => entry.method === "cancelStatement" || entry.method === "stopWarehouse")).toEqual([])
    expect(messages[1]!.text).toContain("not done")
  })

  it("M5: offers a stop only for a warehouse this plugin started", async () => {
    const other = { ...runningWarehouse(), id: "wh-other", name: "someone-elses" }
    const { h, ctx, commands, messages } = setup("all", [read], [runningWarehouse(), other])
    await registerCleanup(ctx, h.deps)
    await commands[0]!.execute({ sessionID: "ses_test", delivery: "immediate" })
    expect(h.databricks.calls.filter((entry) => entry.method === "stopWarehouse").map((entry) => entry.args[1])).toEqual(["wh-small"])
    expect(messages[0]!.text).toContain("not started by this plugin, so no stop is offered here")
  })

  it("acts on nothing but stops and cancels: it cannot delete, and it never cancels a change", async () => {
    const { h, ctx, commands } = setup("all", [read, change])
    await registerCleanup(ctx, h.deps)
    await commands[0]!.execute({ sessionID: "ses_test", delivery: "immediate" })
    const methods = h.databricks.calls.map((entry) => entry.method)
    expect(methods.filter((method) => !["me", "listWarehouses", "history", "cancelStatement", "stopWarehouse"].includes(method))).toEqual([])
    expect(h.databricks.calls.filter((entry) => entry.method === "cancelStatement").map((entry) => entry.args[1])).toEqual(["read-1"])
  })
})
