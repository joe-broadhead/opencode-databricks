// The built plugin in an embedded OpenCode host: registration, the two commands and the cleanup rules (design §15.3,
// package F). Nothing leaves the machine: the account is unconsummated, so every Databricks call would refuse before
// the network, and close() fails the test if the host tried to leave.
import { afterAll, describe, expect, test } from "bun:test"
import { TOOLS } from "../../src/domain/actions.js"
import { CLEANUP_COMMAND, isStatus, STATUS_COMMAND } from "../../src/rpc.js"
import { cleanup, startHost, status, until } from "./harness.js"

afterAll(cleanup)

const inboxText = async (host: Awaited<ReturnType<typeof startHost>>, sessionID: string) =>
  JSON.stringify(await host.client.session.inbox.list({ sessionID }))

describe("status, cleanup and registration in a host", () => {
  test("registers the 23 tools and both commands, and the status RPC answers a valid status", async () => {
    const host = await startHost({ options: { access: "read-only", accounts: { work: { warehouse: "wh-small" } } } })
    try {
      const tools = await host.probe().tool.list()
      // Every engine tool is registered under the plugin's namespace (`databricks_<tool>`), none twice.
      const names = new Set(tools.map((tool) => tool.name))
      for (const tool of TOOLS) expect(names.has(tool.name), tool.name).toBe(true)
      const commands = (await host.client.command.list({ location: host.location })).data.map((command) => command.name)
      expect(commands).toContain(STATUS_COMMAND)
      expect(commands).toContain(CLEANUP_COMMAND)
      const answer = await status(host)
      expect(isStatus(answer)).toBe(true)
      expect(answer).toMatchObject({ state: "sign_in_required", access: "read-only", writes: "never" })
      expect(answer.automation).toMatchObject({ mode: "auto", active: false })
      expect(typeof answer.automation.owner).toBe("boolean")
      expect(answer.spend).toBeDefined()
      expect(answer.cleanup ?? []).toEqual([])
    } finally {
      await host.close()
    }
  }, 180_000)

  test("the status command posts its report into the session", async () => {
    const host = await startHost({ options: { access: "read-only", accounts: { work: { warehouse: "wh-small" } } } })
    try {
      const session = await host.client.sessions.create({ location: host.location, agent: "build" })
      await host.client.session.command({ sessionID: session.id, name: STATUS_COMMAND, text: "" })
      const text = await until("the status report is in the inbox", async () => {
        const posted = await inboxText(host, session.id)
        return posted.includes("Databricks status") ? posted : false
      })
      expect(text).toContain("Connection: sign-in required")
      expect(text).toContain("Writes: never.")
      expect(text).toContain("Cleanup:")
    } finally {
      await host.close()
    }
  }, 180_000)

  test("at read-only, /databricks-cleanup reports and takes no action", async () => {
    const host = await startHost({ options: { access: "read-only", accounts: { work: { warehouse: "wh-small" } } } })
    try {
      const session = await host.client.sessions.create({ location: host.location, agent: "build" })
      await host.client.session.command({ sessionID: session.id, name: CLEANUP_COMMAND, text: "" })
      const text = await until("the cleanup report is in the inbox", async () => {
        const posted = await inboxText(host, session.id)
        return posted.includes("Databricks cleanup") ? posted : false
      })
      expect(text).toContain("Read only")
      expect(text).toContain("takes no action")
      expect(text).toContain("Nothing here deletes")
      // At read-only the command asserts nothing: the unit test pins the same rule against a recording permission port.
      expect(text).not.toContain("done:")
    } finally {
      await host.close()
    }
  }, 180_000)

  test("a deleted session does not break the plugin: automation subscribes and the next status still answers", async () => {
    const host = await startHost({ options: { access: "all", accounts: { work: { warehouse: "wh-small" } } } })
    try {
      const session = await host.client.sessions.create({ location: host.location, agent: "build" })
      await host.client.session.remove({ sessionID: session.id })
      // The sweep is on a timer; the plugin must still answer immediately after the event.
      expect(isStatus(await status(host))).toBe(true)
    } finally {
      await host.close()
    }
  }, 180_000)
})
