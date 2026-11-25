import { describe, expect, it } from "vitest"
import packageJson from "../../package.json" with { type: "json" }
import { METHODS, METHOD_NAMES, methodOf } from "../../src/methods.js"

describe("the method table", () => {
  it("names every manifest method once, and no other", () => {
    const declared = Object.keys(packageJson.capabilities.methods).sort()
    expect([...METHOD_NAMES].sort()).toEqual(declared)
  })

  it("has 31 methods: 21 reads and one of each other class", () => {
    const entries = METHOD_NAMES.map(methodOf)
    const byClass = entries.reduce<Record<string, number>>((counts, method) => ({ ...counts, [method.class]: (counts[method.class] ?? 0) + 1 }), {})
    expect(entries.length).toBe(31)
    expect(byClass.read).toBe(21)
    expect(byClass.write).toBe(4)
    expect(byClass.delete).toBe(2)
    expect(byClass.share).toBe(1)
    expect(byClass.export).toBe(2)
    expect(byClass.admin).toBe(1)
    expect(byClass.send).toBeUndefined()
  })

  it("binds every plan to exactly one commit and every commit to one plan", () => {
    const entries = METHOD_NAMES.map(methodOf)
    const plans = entries.filter((method) => method.plans === true)
    expect(plans.map((plan) => plan.name).sort()).toEqual(["plan_admin", "plan_delete", "plan_export", "plan_run", "plan_share", "plan_write"])
    for (const plan of plans) {
      const commits = entries.filter((method) => method.commits === plan.name.slice("plan_".length) as never)
      expect(commits.length).toBe(1)
    }
    for (const method of entries.filter((entry) => entry.commits !== undefined)) {
      expect(method.plans).toBeUndefined()
      expect(method.class).not.toBe("read")
    }
  })

  it("keeps the manifest's class, operations and account on every method", () => {
    for (const method of METHOD_NAMES.map(methodOf)) {
      const item = (packageJson.capabilities.methods as Record<string, { class: string; accounts: string; operations: readonly string[] }>)[method.name]!
      expect(item.class).toBe(method.class)
      expect(item.accounts).toBe(method.accounts)
      expect(item.operations).toEqual(method.operations)
    }
  })

  it("keeps the namespace line under 400 characters", () => {
    expect(packageJson.capabilities.plugin.summary.length).toBeLessThanOrEqual(400)
  })
})
