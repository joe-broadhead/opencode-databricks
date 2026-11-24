import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { engineName, TOOL_NAMES } from "../../src/domain/actions.js"
import { POLICY_DISCLOSURE, WRITE_DISCLOSURE } from "../../src/domain/contract.js"
import { parseSkill, SKILL_IDS } from "../../src/skills.js"

const text = (id: string) => readFileSync(new URL(`../../skills/${id}/SKILL.md`, import.meta.url), "utf8")

describe("skills", () => {
  it("are the working skill and the SQL dialect skill", () => {
    expect([...SKILL_IDS]).toEqual(["databricks", "databricks-sql"])
  })

  for (const id of SKILL_IDS) {
    it(`${id} has exactly a name and a one-line description, and opens with the family's /connect line`, () => {
      const skill = parseSkill(id, text(id))
      expect(skill.name).toBe(id)
      expect(skill.description.length).toBeGreaterThan(40)
      expect(skill.content.split("\n")[0]).toBe("If Databricks' tools are absent, run `/connect` and choose Databricks.")
    })

    it(`${id} names only tools that exist`, () => {
      const named = parseSkill(id, text(id)).content.match(/\bdatabricks_[a-z][a-z0-9_]*/g) ?? []
      const real = new Set(TOOL_NAMES.map(engineName))
      expect(named.filter((name) => !real.has(name))).toEqual([])
    })
  }

  it("the working skill carries both disclosures verbatim", () => {
    const body = parseSkill("databricks", text("databricks")).content.replace(/\n> /g, " ").replace(/\n/g, " ")
    expect(body).toContain(WRITE_DISCLOSURE)
    expect(body).toContain(POLICY_DISCLOSURE)
  })

  it("refuses a skill with an unknown frontmatter key", () => {
    expect(() => parseSkill("databricks", "---\nname: databricks\ndescription: x\nextra: y\n---\nbody")).toThrow(/^SKILLS_INVALID: /)
  })
})
