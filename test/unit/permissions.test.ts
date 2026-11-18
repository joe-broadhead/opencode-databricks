import { describe, expect, it } from "vitest"
import { ACCESS_VALUES } from "../../src/constants.js"
import { actionOf, DECLARED_ACTIONS, TOOLS } from "../../src/domain/actions.js"
import { changeEffect, defaultRules, effectOf, insertDefaults, registerPermissionDefaults, type Rule, unguardedAgents } from "../../src/permissions.js"

const BASE: Rule = { action: "*", resource: "*", effect: "allow" }

describe("default rules", () => {
  it("give a change the access effect: allow, ask, deny", () => {
    expect(ACCESS_VALUES.map(changeEffect)).toEqual(["allow", "ask", "deny"])
  })

  it("treat an action the plugin does not know like a change, at every access", () => {
    for (const access of ACCESS_VALUES) expect(effectOf([BASE, ...defaultRules(access)], "databricks.never_seen"), access).toBe(changeEffect(access))
  })

  it("allow every read, the probe and a source's read; start is allow / ask / allow; changes follow the access", () => {
    const start = { all: "allow", "ask-changes": "ask", "read-only": "allow" } as const
    for (const access of ACCESS_VALUES) {
      const rules = [BASE, ...defaultRules(access)]
      for (const tool of TOOLS) expect(effectOf(rules, actionOf(tool.name)), `${access} ${tool.name}`).toBe(tool.readOnly ? "allow" : changeEffect(access))
      expect(effectOf(rules, "databricks.probe")).toBe("allow")
      expect(effectOf(rules, "databricks.read")).toBe("allow")
      expect(effectOf(rules, "databricks.start")).toBe(start[access])
    }
  })

  it("name only dotted databricks actions, every declared one once", () => {
    const actions = defaultRules("all").map((rule) => rule.action)
    expect(actions[0]).toBe("databricks.*")
    expect(actions.slice(1).sort()).toEqual([...DECLARED_ACTIONS].sort())
    expect(actions.some((action) => action.startsWith("databricks_"))).toBe(false)
  })

  it("let a person's table rule win after the block", () => {
    const rules = [BASE, ...defaultRules("all"), { action: "databricks.query", resource: "work:table:*.hr.*", effect: "deny" as const }]
    expect(effectOf(rules, "databricks.query", "work:table:main.hr.salaries")).toBe("deny")
    expect(effectOf(rules, "databricks.query", "work:table:main.sales.orders")).toBe("allow")
  })
})

describe("insertion", () => {
  const rules = defaultRules("ask-changes")

  it("goes right after the agent's base * * allow, once", () => {
    const before: Rule[] = [{ action: "bash", resource: "*", effect: "ask" }, BASE, { action: "edit", resource: "*", effect: "deny" }]
    const after = insertDefaults(before, rules)
    expect(after.slice(2, 2 + rules.length)).toEqual(rules)
    expect(insertDefaults(after, rules)).toEqual(after)
    const strict: Rule[] = [{ action: "*", resource: "*", effect: "ask" }]
    expect(insertDefaults(strict, rules)).toEqual(strict)
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
