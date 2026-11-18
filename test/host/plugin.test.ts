// The built plugin in an embedded OpenCode host. Nothing leaves the machine: close() fails the test if the host tried.
import { afterAll, describe, expect, test } from "bun:test"
import { Rpc } from "@opencode/plugin/rpc"
import { RPC_METHODS } from "../../src/domain/actions.js"
import { WRITE_DISCLOSURE } from "../../src/domain/contract.js"
import { defaultRules } from "../../src/permissions.js"
import { isStatus } from "../../src/rpc.js"
import { TOOLS_RPC_ID } from "../../src/tools-rpc.js"
import { agentRules, CLOSE_MS, cleanup, pluginState, SDK_VERSION, settleAbandoned, START_HOOK_MS, startHost, status, TEARDOWN_HOOK_MS } from "./harness.js"

afterAll(cleanup, TEARDOWN_HOOK_MS)

/** The client side only names the methods: the plugin checks each input against the tool's own contract. */
const open = {}
const Tools = Rpc.define({
  id: TOOLS_RPC_ID,
  methods: Object.fromEntries(["describe", ...RPC_METHODS].map((name) => [name, { input: open, output: open, errors: { failed: open } }])),
  events: {},
})

describe("the plugin in a host", () => {
  test("loads, inserts the default rules and answers status with no request off the machine", async () => {
    const host = await startHost({ options: { accounts: { work: { warehouse: "wh-small" } } } })
    try {
      expect(await pluginState(host)).toEqual({ status: "active" })
      const rules = (await agentRules(host)).get("build") ?? []
      const base = rules.findIndex((rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow")
      expect(rules.slice(base + 1, base + 1 + defaultRules("all").length)).toEqual(defaultRules("all"))
      const answer = await status(host)
      expect(isStatus(answer)).toBe(true)
      expect(answer).toMatchObject({ access: "all", writes: "without asking", disclosure: WRITE_DISCLOSURE, accounts: [{ alias: "work", mode: "interactive" }] })
    } finally {
      await host.close()
    }
  }, START_HOOK_MS)

  test("at ask-changes, the block asks for changes and starts", async () => {
    const host = await startHost({ options: { access: "ask-changes" } })
    try {
      const rules = (await agentRules(host)).get("build") ?? []
      const base = rules.findIndex((rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow")
      expect(rules.slice(base + 1, base + 1 + defaultRules("ask-changes").length)).toEqual(defaultRules("ask-changes"))
      expect(await status(host)).toMatchObject({ access: "ask-changes", writes: "ask", state: "sign_in_required" })
    } finally {
      await host.close()
    }
  }, START_HOOK_MS)

  test("serves the tools RPC: describe lists the reads, probe and saved_list; plan classifies SQL and sends nothing", async () => {
    const host = await startHost({ options: { accounts: { work: { warehouse: "wh-small" } } } })
    try {
      const sessionID = (await (host.client.sessions as unknown as { create(input: unknown): Promise<{ id: string }> }).create({ location: host.location, agent: "build" })).id
      const tools = host.probe().rpc(Tools) as unknown as Record<string, (input: unknown, options?: unknown) => Promise<unknown>>
      const described = (await tools.describe!({ sessionID })) as { methods: { name: string }[] }
      expect(described.methods.map((method) => method.name).sort()).toEqual([...RPC_METHODS].sort())
      const planned = (await tools.plan!({ sessionID, input: { sql: "DROP TABLE main.sales.orders" } })) as Record<string, unknown>
      expect(planned).toMatchObject({ state: "planned", category: "delete", commitWith: "databricks_delete" })
      const read = (await tools.query!({ sessionID, input: { sql: "select 1" } })) as Record<string, unknown>
      // A read with no usable credential refuses before anything is sent: package C's tools are real, and the auth seam
      // is package A's; a tool no package has built yet still says NOT_IMPLEMENTED.
      expect(read).toMatchObject({ state: "refused", error: "AUTH_REQUIRED" })
      const unbuilt = (await tools.jobs!({ sessionID, input: {} })) as Record<string, unknown>
      expect(unbuilt).toMatchObject({ state: "refused", error: "NOT_IMPLEMENTED" })
    } finally {
      await host.close()
    }
  }, START_HOOK_MS)

  test("refuses an unknown option, and a host outside the range", async () => {
    const typo = await startHost({ options: { acess: "all" } })
    try {
      expect(await pluginState(typo)).toMatchObject({ status: "failed", error: expect.stringContaining("OPTIONS_INVALID") })
    } finally {
      await typo.close()
    }
    const old = await startHost({ version: "2.1.0" })
    try {
      expect(await pluginState(old)).toMatchObject({ status: "failed", error: expect.stringContaining("HOST_UNTESTED") })
    } finally {
      await old.close()
    }
  }, 2 * START_HOOK_MS)

  test("a host that misses its start bound fails with the harness's error, naming its OpenCode version", async () => {
    // A bound no host can meet: the harness's own deadline fires, not the runner's, and says which host and phase.
    await expect(startHost({ startWithinMs: 1 })).rejects.toThrow(new RegExp(`^the OpenCode ${SDK_VERSION.replaceAll(".", "\\.")} host did not (import its SDK|start|answer its plugin list|settle) within 0\\.001 s of starting`))
    // The host that started late is closed before the next test.
    await settleAbandoned()
  }, START_HOOK_MS)

  test("a host whose plugin list and close both hang still fails with the harness's error, within its bound", async () => {
    // Review of #14, F1: a stand-in SDK whose host never answers its plugin list and never closes. The failed start's
    // close is bounded, so the harness's message arrives at the deadline plus CLOSE_MS, never the runner's timeout.
    const never = () => new Promise<never>(() => undefined)
    const sdk = { OpenCode: { create: async () => ({ plugin: { list: never }, close: never }) } }
    const started = Date.now()
    await expect(startHost({ sdk, startWithinMs: 200 })).rejects.toThrow(new RegExp(`^the OpenCode ${SDK_VERSION.replaceAll(".", "\\.")} host did not answer its plugin list within 0\\.2 s of starting`))
    expect(Date.now() - started).toBeLessThan(200 + CLOSE_MS + 2_000)
    // The hung close is abandoned; settling it is bounded too, and drops it.
    const settling = Date.now()
    await settleAbandoned(100)
    expect(Date.now() - settling).toBeLessThan(2_000)
  }, START_HOOK_MS)
})
