// The built plugin in the real embedded OpenCode 2.4.1 host: every packaged skill must be registered after load.
import { afterAll, describe, expect, it } from "vitest"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import type { OpenCodeClient } from "@opencode/client"

const repo = realpathSync(fileURLToPath(new URL("../..", import.meta.url)))
const work = mkdtempSync(join(tmpdir(), "databricks-skills-"))
const expected = readdirSync(join(repo, "skills"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()

afterAll(() => rmSync(work, { recursive: true, force: true }))

describe("the packaged skills", () => {
  it("are all registered on the real OpenCode 2.4.1 host", async () => {
    const { OpenCode } = (await import("@opencode/sdk")) as typeof import("@opencode/sdk")
    let ready = false
    const probe = Plugin.define({ id: "databricks-skills-probe", setup: () => { ready = true } })
    const client = (await OpenCode.create({
      plugins: [probe],
      app: { version: "2.4.1" },
      config: {
        content: JSON.stringify({
          plugins: [{ package: repo, options: {} }],
          providers: { lmstudio: { settings: { baseURL: "" } }, ollama: { settings: { baseURL: "" } }, vllm: { settings: { baseURL: "" } } },
        }),
        directory: join(work, "config"),
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
      let ids: string[] = []
      while (Date.now() < deadline) {
        const answer = await client.skill.list({ location: { directory: work } })
        ids = answer.data.map((skill) => String(skill.id))
        if (ready && expected.every((id) => ids.includes(id))) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(ready).toBe(true)
      expect(expected.length).toBeGreaterThan(0)
      for (const id of expected) expect(ids, id).toContain(id)
    } finally {
      await client.close()
    }
  }, 90_000)
})
