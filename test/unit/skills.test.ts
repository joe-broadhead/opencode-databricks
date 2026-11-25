import { describe, expect, it } from "vitest"
import { parseSkill } from "../../src/skills.js"

const skill = (description: string) => `---\nname: demo\ndescription: ${description}\n---\n\n# Demo\n`

describe("the skill frontmatter", () => {
  it("accepts a real one-line description", () => {
    expect(parseSkill("demo", skill("A real one-line description.")).description).toBe("A real one-line description.")
  })

  it.each([">", "|", ">-", "|+", "", "   "])("refuses a placeholder description %j", (description) => {
    expect(() => parseSkill("demo", skill(description))).toThrow(/one-line description/)
  })
})
