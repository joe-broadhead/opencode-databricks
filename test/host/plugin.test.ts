// The built plugin in an embedded OpenCode host. Nothing leaves the machine: close() fails the test if the host tried.
import { afterAll, describe, expect, test } from "bun:test"
import { defaultRules } from "../../src/permissions.js"
import { isStatus } from "../../src/rpc.js"
import { WRITE_DISCLOSURE } from "../../src/disclosures.js"
import { agentRules, cleanup, pluginState, startHost, status } from "./harness.js"

afterAll(cleanup)

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
      expect(answer).toMatchObject({ access: "all", writes: "without asking", disclosure: WRITE_DISCLOSURE, accounts: [{ alias: "work", mode: "interactive" }], tools: { declared: 0, built: 0 } })
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
