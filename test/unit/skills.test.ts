import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parseSkill, SKILL_IDS } from "../../src/skills.js"
import { WRITE_DISCLOSURE } from "../../src/disclosures.js"

const text = (id: string) => readFileSync(new URL(`../../skills/${id}/SKILL.md`, import.meta.url), "utf8")

describe("skills", () => {
  it("are the working skill and the SQL dialect skill", () => {
    expect([...SKILL_IDS]).toEqual(["opencode-databricks", "opencode-databricks-sql"])
  })

  for (const id of SKILL_IDS) {
    it(`${id} has exactly a name and a one-line description, and opens with the family's /connect line`, () => {
      const skill = parseSkill(id, text(id))
      expect(skill.name).toBe(id)
      expect(skill.description.length).toBeGreaterThan(40)
      expect(skill.content.split("\n")[0]).toMatch(/^If Databricks' tools are absent, run `\/connect` .*, or on Jelly call jelly_connection_request\.$/)
    })

    it(`${id} names no tool yet`, () => {
      expect(parseSkill(id, text(id)).content.match(/\bdatabricks_[a-z][a-z0-9_]*/g) ?? []).toEqual([])
    })
  }

  it("the working skill carries the write disclosure verbatim", () => {
    expect(parseSkill("opencode-databricks", text("opencode-databricks")).content.replace(/\n> /g, " ").replace(/\n/g, " ")).toContain(WRITE_DISCLOSURE)
  })

  it("refuses a skill with an unknown frontmatter key", () => {
    expect(() => parseSkill("opencode-databricks", "---\nname: opencode-databricks\ndescription: x\nextra: y\n---\nbody")).toThrow(/^SKILLS_INVALID: /)
  })
})
