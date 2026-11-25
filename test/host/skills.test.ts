// The built plugin in the real embedded OpenCode 2.4.1 host: every packaged skill must be registered after load.
import { afterAll, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import type { OpenCodeClient } from "@opencode/client"
import { expectedSkills } from "./frontmatter.js"

const repo = realpathSync(fileURLToPath(new URL("../..", import.meta.url)))
const work = mkdtempSync(join(tmpdir(), "databricks-skills-"))
const expected = expectedSkills(repo)

afterAll(() => rmSync(work, { recursive: true, force: true }))

describe("the packaged skills", () => {
  it("are all registered on the real OpenCode 2.4.1 host", async () => {
    expect(existsSync(join(work, "skills"))).toBe(false)
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
      let registered: { id: string; description: string | undefined }[] = []
      while (Date.now() < deadline) {
        const answer = await client.skill.list({ location: { directory: work } })
        registered = answer.data.map((skill) => ({ id: String(skill.id), description: typeof skill.description === "string" ? skill.description : undefined }))
        if (ready && expected.every((skill) => registered.some((item) => item.id === skill.id && item.description === skill.description))) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(ready).toBe(true)
      expect(expected.length).toBeGreaterThan(0)
      for (const skill of expected) {
        const actual = registered.find((item) => item.id === skill.id)
        expect(actual, skill.id).toBeDefined()
        expect(actual?.description, skill.id).toBe(skill.description)
        expect(skill.description.trim(), skill.id).not.toBe("")
        expect(skill.description, skill.id).not.toBe(">")
        expect(skill.description, skill.id).not.toBe("|")
      }
    } finally {
      await client.close()
    }
  }, 90_000)
})
