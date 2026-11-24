/**
 * The fixed-context budget (the plugin standard's §0.2 rule 4): the namespace line is at most 400 characters, each skill
 * description at most 300, nothing is pinned, and there is no per-request hook. The kit's T0 gate measures the first two
 * on the installed plugin; these checks keep this repository inside them meanwhile.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { NAMESPACE_DESCRIPTION } from "../../src/plugin.js"
import { parseSkill, SKILL_IDS } from "../../src/skills.js"

const ROOT = fileURLToPath(new URL("../../", import.meta.url))

/** Every TypeScript source file, with the generated parser left out (it is Spark's grammar, not plugin code). */
function sources(dir = join(ROOT, "src")): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (path.endsWith(join("sql", "generated"))) continue
      out.push(...sources(path))
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push({ path, text: readFileSync(path, "utf8") })
    }
  }
  return out
}

describe("fixed context", () => {
  it("keeps the namespace line at or under 400 characters, and it names both skills", () => {
    expect(NAMESPACE_DESCRIPTION.length).toBeLessThanOrEqual(400)
    expect(NAMESPACE_DESCRIPTION).toContain("databricks skill")
    expect(NAMESPACE_DESCRIPTION).toContain("databricks-sql")
  })

  it("keeps every skill description at or under 300 characters", () => {
    for (const id of SKILL_IDS) {
      const text = readFileSync(join(ROOT, "skills", id, "SKILL.md"), "utf8")
      expect(parseSkill(id, text).description.length, id).toBeLessThanOrEqual(300)
    }
  })

  it("pins no method", () => {
    for (const file of sources()) expect(file.text, file.path).not.toMatch(/\bpinned\s*:/i)
  })

  it("registers no per-request hook", () => {
    for (const file of sources()) {
      expect(file.text, file.path).not.toMatch(/session\.hook\(/)
      expect(file.text, file.path).not.toMatch(/registerContextHook/)
    }
  })
})
