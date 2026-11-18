// Design §15.3's unit half for package D: every change tool asserts its own dotted action first, before any Databricks
// call and before any feature check; a denied action sends nothing; a denied `databricks.start` neither charges nor
// starts; and a user's table rule reaches a change's target (the second assert).
import { describe, expect, it } from "vitest"
import { actionOf } from "../../../src/domain/actions.js"
import { HANDLERS } from "../../../src/registry.js"
import { runTool } from "../../../src/tool-spec.js"
import { RecordingPermission } from "../../fake/ports.js"
import { changeHarness, NOTEBOOK_PATH, RUNNING_WAREHOUSE, type ChangeHarness } from "./harness.js"

/** One valid input per package D tool, as the registry's own test builds them. */
const INPUTS = {
  jobs: {},
  workspace: { path: "/Shared" },
  plan: { sql: "DELETE FROM main.s.t WHERE id = 1" },
  write: { planId: "pln_none" },
  delete: { planId: "pln_none" },
  share: { planId: "pln_none" },
  export: { planId: "pln_none" },
  run: { planId: "pln_none" },
  admin: { planId: "pln_none" },
  cancel: { statementId: "st-1" },
  stop: { warehouse: "wh-small" },
} as const

const planned = async (harness: ChangeHarness, sql: string, tool: "write" | "delete" | "run") => {
  const answer = await runTool("plan", { sql }, harness.call(), harness.deps, HANDLERS)
  expect(answer).toMatchObject({ state: "planned" })
  return (answer as { planId: string }).planId
}

describe("every D tool asserts its own dotted action first", () => {
  for (const [tool, input] of Object.entries(INPUTS)) {
    it(`${tool}: databricks.${tool} on <account>:<operation>, before any call`, async () => {
      const harness = changeHarness({ features: [] })
      let callsAtAssert = -1
      const permission = new RecordingPermission(() => {
        if (callsAtAssert < 0) callsAtAssert = harness.calls.length + harness.api.requests.length
        return "allow"
      })
      const scoped = changeHarness({ features: [], permission })
      await runTool(tool as "jobs", input, scoped.call(`call_${tool}`), scoped.deps, HANDLERS)
      expect(scoped.permission.requests[0]).toMatchObject({ action: actionOf(tool), sessionID: "ses_test", callID: `call_${tool}` })
      expect(callsAtAssert, `${tool} reached Databricks before its assert`).toBe(0)
      expect(harness.calls, tool).toEqual([])
    })
  }

  it("a denied action sends nothing at all, for every D tool", async () => {
    for (const [tool, input] of Object.entries(INPUTS)) {
      const scoped = changeHarness({ permission: new RecordingPermission(() => "deny") })
      await expect(runTool(tool as "jobs", input, scoped.call(), scoped.deps, HANDLERS), tool).rejects.toThrow(/denied/)
      expect(scoped.api.requests, tool).toEqual([])
      expect(scoped.calls, tool).toEqual([])
    }
  })
})

describe("the start and the table asserts", () => {
  it("asserts databricks.start before charging the ledger or starting the warehouse", async () => {
    const permission = new RecordingPermission((request) => (request.action === "databricks.start" ? "deny" : "allow"))
    const harness = changeHarness({ warehouse: { ...RUNNING_WAREHOUSE, state: "STOPPED" }, permission })
    const planId = await planned(harness, "DELETE FROM main.s.t WHERE id = 1", "delete")
    await expect(runTool("delete", { planId }, harness.call("call_commit"), harness.deps, HANDLERS)).rejects.toThrow(/denied: databricks.start/)
    expect(harness.permission.requests.filter((request) => request.action === "databricks.start")).toHaveLength(1)
    expect(harness.ledger.charges).toEqual([])
    expect(harness.calls.filter((entry) => entry.method === "startWarehouse")).toEqual([])
    expect(harness.statements()).toEqual([])
  })

  it("asserts the start on the warehouse resource, as <account>:warehouse:<id>", async () => {
    const harness = changeHarness({ warehouse: { ...RUNNING_WAREHOUSE, state: "STOPPED" } })
    const planId = await planned(harness, "DELETE FROM main.s.t WHERE id = 1", "delete")
    await runTool("delete", { planId }, harness.call("call_commit"), harness.deps, HANDLERS)
    expect(harness.permission.requests.filter((request) => request.action === "databricks.start").map((request) => request.resource)).toEqual(["work:warehouse:wh-small"])
  })

  it("a notebook run asserts its own action and its plan's account, and the jobs family", async () => {
    const harness = changeHarness()
    const planAnswer = await runTool("plan", { account: "work", notebook: { path: NOTEBOOK_PATH } }, harness.call(), harness.deps, HANDLERS)
    const planId = (planAnswer as { planId: string }).planId
    await runTool("run", { planId }, harness.call("call_run"), harness.deps, HANDLERS)
    expect(harness.permission.requests.map((request) => request.action)).toEqual(expect.arrayContaining(["databricks.plan", "databricks.run"]))
    expect(harness.permission.requests.filter((request) => request.action === "databricks.run").every((request) => request.resource.startsWith("work:"))).toBe(true)
  })
})
