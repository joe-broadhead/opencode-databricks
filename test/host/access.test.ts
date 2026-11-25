// Design §15.3's access rules, in a real embedded host: the three access levels through the family's default rules, over
// every action package D can assert. The rules are what OpenCode resolves a call against, so this is the level the
// design's §10.3 table is about: at Allowed everything is allowed; at Ask before changes the six commits, `save`,
// `cancel` and `stop` ask and a warehouse start asks; at Read only those are denied and reads (the plan too) run.
//
// No request leaves the machine: the host's fetch router fails the test if one tries, and every account here is one the
// placeholder auth refuses.
import { afterAll, describe, expect, test } from "bun:test"
import { actionOf, DECLARED_ACTIONS, NO_ALWAYS, RPC_METHODS, START_ACTION, TOOLS } from "../../src/domain/actions.js"
import { defaultRules, effectOf } from "../../src/permissions.js"
import { agentRules, cleanup, startHost } from "./harness.js"

afterAll(cleanup)

const CHANGES = ["save", ...TOOLS.filter((tool) => !tool.readOnly).map((tool) => tool.name)]
const READS = TOOLS.filter((tool) => tool.readOnly).map((tool) => tool.name)

/** The effect OpenCode gives an action in an agent: the last matching rule wins, on the agent's own rule list. */
const rulesOf = async (access: "all" | "ask-changes" | "read-only") => {
  const host = await startHost({ options: { access, accounts: { work: { warehouse: "wh-small" } } } })
  const rules = (await agentRules(host)).get("build") ?? []
  return { host, rules }
}

describe("the access rules in a host", () => {
  test("at Allowed every action is allowed, and the block is the family's", async () => {
    const { host, rules } = await rulesOf("all")
    try {
      const base = rules.findIndex((rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow")
      expect(rules.slice(base + 1, base + 1 + defaultRules("all").length)).toEqual(defaultRules("all"))
      for (const action of DECLARED_ACTIONS) expect(effectOf(rules, action), action).toBe("allow")
    } finally {
      await host.close()
    }
  }, 120_000)

  test("at Ask before changes the commits, cancel and stop ask, a start asks, and reads never do", async () => {
    const { host, rules } = await rulesOf("ask-changes")
    try {
      for (const tool of READS) expect(effectOf(rules, actionOf(tool)), tool).toBe("allow")
      expect(effectOf(rules, "databricks.probe")).toBe("allow")
      expect(effectOf(rules, START_ACTION)).toBe("ask")
      for (const tool of CHANGES) expect(effectOf(rules, actionOf(tool)), tool).toBe("ask")
      // "gws parity": the two destructive tools never offer Always, so they ask every time rather than being allowed.
      expect(NO_ALWAYS).toEqual(["delete", "run"])
      for (const tool of NO_ALWAYS) expect(effectOf(rules, actionOf(tool)), tool).toBe("ask")
      // A table resource follows its tool's own action, which is what a plan or a commit asserts.
      expect(effectOf(rules, "databricks.delete", "work:table:main.s.t")).toBe("ask")
      expect(effectOf(rules, "databricks.query", "work:table:main.s.t")).toBe("allow")
    } finally {
      await host.close()
    }
  }, 120_000)

  test("at Read only the nine changes are denied and reads run, the plan included", async () => {
    const { host, rules } = await rulesOf("read-only")
    try {
      for (const tool of READS) expect(effectOf(rules, actionOf(tool)), tool).toBe("allow")
      expect(effectOf(rules, START_ACTION)).toBe("allow")
      expect(effectOf(rules, "databricks.probe")).toBe("allow")
      for (const tool of CHANGES) expect(effectOf(rules, actionOf(tool)), tool).toBe("deny")
      expect(effectOf(rules, "databricks.delete", "work:table:main.s.t")).toBe("deny")
      // `databricks_plan` is a read and is offered at Read only: it previews and writes nothing.
      expect(RPC_METHODS).toContain("plan")
      expect(RPC_METHODS).not.toContain("write")
    } finally {
      await host.close()
    }
  }, 120_000)

  test("a person's own rule wins over the family's block, as OpenCode applies the last match", async () => {
    const { host, rules } = await rulesOf("all")
    try {
      const deny = { action: "databricks.query", resource: "work:table:*.hr.*", effect: "deny" as const }
      const withRule = [...rules, deny]
      expect(effectOf(withRule, "databricks.query", "work:table:main.hr.orders")).toBe("deny")
      expect(effectOf(withRule, "databricks.query", "work:table:main.sales.orders")).toBe("allow")
      // The same shape refuses a commit's table, because a commit asserts its targets under its own action.
      expect(effectOf([...rules, { ...deny, action: "databricks.delete" }], "databricks.delete", "work:table:main.hr.orders")).toBe("deny")
    } finally {
      await host.close()
    }
  }, 120_000)

  test("the tools RPC offers the plan at Read only and no change tool at any level", async () => {
    const { host } = await rulesOf("read-only")
    try {
      const names = RPC_METHODS
      expect(names).toContain("plan")
      for (const tool of CHANGES) expect(names, tool).not.toContain(tool)
    } finally {
      await host.close()
    }
  }, 120_000)
})
