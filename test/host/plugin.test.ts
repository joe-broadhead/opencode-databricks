// The built plugin in an embedded OpenCode host. Nothing leaves the machine: close() fails the test if the host tried.
import { afterAll, describe, expect, test } from "bun:test"
import { Rpc } from "@opencode/plugin/rpc"
import { RPC_METHODS } from "../../src/domain/actions.js"
import { WRITE_DISCLOSURE } from "../../src/domain/contract.js"
import { defaultRules } from "../../src/permissions.js"
import { isStatus } from "../../src/rpc.js"
import { TOOLS_RPC_ID } from "../../src/tools-rpc.js"
import { agentRules, cleanup, pluginState, startHost, status } from "./harness.js"

afterAll(cleanup)

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
      expect(answer).toMatchObject({ access: "all", writes: "without asking", disclosure: WRITE_DISCLOSURE, accounts: [{ alias: "work", mode: "interactive" }], tools: { declared: 23, built: 1 } })
    } finally {
      await host.close()
    }
  }, 120_000)

  test("at ask-changes, the block asks for changes and starts", async () => {
    const host = await startHost({ options: { access: "ask-changes" } })
    try {
      const rules = (await agentRules(host)).get("build") ?? []
      const base = rules.findIndex((rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow")
      expect(rules.slice(base + 1, base + 1 + defaultRules("ask-changes").length)).toEqual(defaultRules("ask-changes"))
      expect(await status(host)).toMatchObject({ access: "ask-changes", writes: "ask", state: "not_configured" })
    } finally {
      await host.close()
    }
  }, 120_000)

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
  }, 120_000)

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
  }, 240_000)
})
