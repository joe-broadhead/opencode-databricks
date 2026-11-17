import { describe, expect, it } from "vitest"
import { ACCESS_VALUES } from "../../src/constants.js"
import { changeEffect, defaultRules, effectOf, insertDefaults, registerPermissionDefaults, type Rule, unguardedAgents } from "../../src/permissions.js"

const BASE: Rule = { action: "*", resource: "*", effect: "allow" }

describe("default rules", () => {
  it("give a change the access effect: allow, ask, deny", () => {
    expect(ACCESS_VALUES.map(changeEffect)).toEqual(["allow", "ask", "deny"])
  })

  it("treat every action of the plugin like a change until the tools exist", () => {
    for (const access of ACCESS_VALUES) {
      expect(defaultRules(access)).toEqual([{ action: "databricks.*", resource: "*", effect: changeEffect(access) }])
      expect(effectOf([BASE, ...defaultRules(access)], "databricks.never_seen"), access).toBe(changeEffect(access))
    }
  })
})

describe("insertion", () => {
  const rules = defaultRules("ask-changes")

  it("goes right after the agent's base * * allow, once", () => {
    const before: Rule[] = [{ action: "bash", resource: "*", effect: "ask" }, BASE, { action: "edit", resource: "*", effect: "deny" }]
    const after = insertDefaults(before, rules)
    expect(after.slice(2, 2 + rules.length)).toEqual(rules)
    expect(insertDefaults(after, rules)).toEqual(after)
  })

  it("names the agents that miss the block and would run a new action unasked", () => {
    const agents = [
      { id: "build", permissions: insertDefaults([BASE], defaultRules("all")) },
      { id: "mine", permissions: [BASE] },
      { id: "careful", permissions: [BASE, { action: "databricks.*", resource: "*", effect: "deny" } as Rule] },
    ]
    expect(unguardedAgents(agents, "all")).toEqual(["mine"])
  })

  it("never throws from the transform; a failure is reported", async () => {
    const reports: (string | undefined)[] = []
    const ctx = {
      agent: {
        transform: async (callback: (editor: unknown) => void) => {
          callback({ list: () => { throw new Error("broken host") }, update: () => undefined })
          return { dispose: async () => undefined }
        },
      },
    }
    await registerPermissionDefaults(ctx as never, "all", (problem) => reports.push(problem))
    expect(reports[0]).toMatch(/^RULES_NOT_ADDED: .* Next step: Restart OpenCode\.$/)
  })
})
