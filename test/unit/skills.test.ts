import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { readSkills } from "../../src/skills.js"

function read(frontmatter: string, directoryName = "demo"): ReturnType<typeof readSkills> {
  const directory = mkdtempSync(join(tmpdir(), "databricks-skill-"))
  try {
    mkdirSync(join(directory, directoryName))
    writeFileSync(join(directory, directoryName, "SKILL.md"), `---\nname: demo\n${frontmatter}\n---\n\n# Demo\n`)
    return readSkills(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe("the skill loader", () => {
  it("reads folded and literal block descriptions as their text", () => {
    expect(read("description: >-\n  A folded\n  description")[0]?.description).toBe("A folded description")
    expect(read("description: |-\n  A literal\n  description")[0]?.description).toBe("A literal\ndescription")
  })

  it("reads a quoted one-line description with a colon", () => {
    expect(read('description: "Use for reads: changes"')[0]?.description).toBe("Use for reads: changes")
  })

  it("refuses a bare block marker", () => {
    expect(() => read("description: >")).toThrow(/block marker|description/)
    expect(() => read('description: "|"')).toThrow(/block marker|description/)
  })

  it("refuses a plain description containing a YAML mapping colon", () => {
    expect(() => read("description: Use for reads: changes")).toThrow(/not valid YAML/)
  })

  it("refuses a name that is not its directory", () => {
    expect(() => read("description: A real description", "other")).toThrow(/names "demo", not its directory "other"/)
  })
})
