// The real OpenCode 2.4.1 host, after load: the new method table, both skills, and no removed command or agent.
import { afterAll, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import type { OpenCodeClient } from "@opencode/client"
import { createHost } from "@we-the-rebel-alliance/plugin-contract/kit"
import { METHOD_NAMES } from "../../src/methods.js"

const repo = realpathSync(fileURLToPath(new URL("../..", import.meta.url)))
const work = mkdtempSync(join(tmpdir(), "databricks-parity-"))
const skillIds = readdirSync(join(repo, "skills"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()

// The 4a tool table (`git show bd5a019:src/domain/actions.ts`) and the one method that splits. Every old tool must still
// have a new method; the three new methods are additions, not replacements. This is the table the PR body reports.
const OLD_TOOLS = [
  "status", "catalog", "table", "warehouses", "explain", "query", "statement", "history", "profile", "jobs", "workspace",
  "plan", "events_list", "saved_read", "save", "write", "delete", "share", "export", "run", "admin", "cancel", "stop",
] as const
const PLAN_METHODS = ["plan_write", "plan_delete", "plan_share", "plan_export", "plan_run", "plan_admin"] as const
const NEW_METHODS = ["start", "probe", "saved_list"] as const
const EXPECTED_TOOLS = [...OLD_TOOLS.filter((name) => name !== "plan"), ...PLAN_METHODS, ...NEW_METHODS].sort()

afterAll(() => rmSync(work, { recursive: true, force: true }))

describe("parity after load", () => {
  it("registers every method as a tool and as an RPC method on 2.4.1", async () => {
    const run = await createHost({ directory: repo, version: "2.4.1", pluginId: "databricks" })
    try {
      expect(run.failure).toBeUndefined()
      expect(run.refusal).toBeUndefined()
      expect(EXPECTED_TOOLS).toHaveLength(31)
      expect(run.tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOLS)
      expect([...(run.rpc?.methods ?? [])].sort()).toEqual(EXPECTED_TOOLS)
      expect([...METHOD_NAMES].sort()).toEqual(EXPECTED_TOOLS)
    } finally {
      await run.close()
    }
  }, 90_000)

  it("registers both skills and leaves the removed commands and agents absent", async () => {
    expect(existsSync(join(work, "skills"))).toBe(false)
    const { OpenCode } = (await import("@opencode/sdk")) as typeof import("@opencode/sdk")
    let ready = false
    const probe = Plugin.define({ id: "databricks-parity-probe", setup: () => { ready = true } })
    const client = (await OpenCode.create({
      plugins: [probe],
      app: { version: "2.4.1" },
      config: {
        content: JSON.stringify({
          plugins: [{ package: repo, options: {} }],
          providers: { lmstudio: { settings: { baseURL: "" } }, ollama: { settings: { baseURL: "" } }, vllm: { settings: { baseURL: "" } } },
        }),
        directory: work,
        project: false,
        claude: false,
      },
      database: { path: join(work, "opencode.db") },
      models: { fetch: false },
      fs: { filewatcher: false },
      log: { level: "error" },
    })) as OpenCodeClient & { close(): Promise<void> }
    try {
      const deadline = Date.now() + 60_000
      let skills: string[] = []
      let commands: string[] = []
      let agents: string[] = []
      while (Date.now() < deadline) {
        const skillAnswer = await client.skill.list({ location: { directory: work } })
        skills = skillAnswer.data.map((skill) => String(skill.id))
        const commandAnswer = await client.command.list({ location: { directory: work } })
        commands = commandAnswer.data.map((command) => String(command.name))
        const agentAnswer = await client.agent.list({ location: { directory: work } })
        agents = agentAnswer.data.map((agent) => String(agent.id))
        if (ready && skillIds.every((id) => skills.includes(id))) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(ready).toBe(true)
      for (const id of skillIds) expect(skills, id).toContain(id)
      expect(skills).not.toContain("example")
      // The four 4a commands (status, doctor, cleanup and the TUI view) are gone; status is the method/tool, and no
      // command or custom agent is registered.
      expect(commands.filter((name) => name.startsWith("databricks"))).toEqual([])
      expect(agents.filter((id) => id.includes("databricks"))).toEqual([])
    } finally {
      await client.close()
    }
  }, 90_000)
})
