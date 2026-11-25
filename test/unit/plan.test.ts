import { describe, expect, it } from "vitest"
import { DatabricksError } from "../../src/domain/errors.js"
import { loadOptions } from "../../src/options.js"
import { planWrite } from "../../src/handlers/changes/plan.js"
import { commitTool } from "../../src/handlers/changes/commit.js"
import type { Deps } from "../../src/handlers/deps.js"
import type { Warehouse } from "../../src/ports.js"

const warehouse: Warehouse = { id: "wh-small", name: "small", state: "RUNNING", warehouseType: "PRO", serverless: true, clusterSize: "Small", autoStopMins: 5, minNumClusters: 1, maxNumClusters: 1 }

function deps(): Deps {
  let submitted: { statement: string; queryTags: Record<string, string> } | undefined
  const base = {
    options: loadOptions({}),
    access: "all",
    auth: {
      account: () => ({ alias: "work", mode: "pat", host: "https://example.cloud.databricks.com", cloud: "aws", features: [], enforcement: "identity" }),
      accounts: () => [],
      token: async () => ({ accessToken: "x", expiresAt: 0, scopes: [], host: "https://example.cloud.databricks.com" }),
    },
    databricks: {
      getWarehouse: async () => warehouse,
      getTable: async () => {
        throw new DatabricksError("NOT_FOUND", "no table")
      },
      submit: async (request: { statement: string; queryTags: Record<string, string> }) => {
        submitted = request
        return { statementId: "stmt-1", state: "SUCCEEDED", manifest: { totalRowCount: 0 } }
      },
      history: async () => ({ items: [] }),
    },
    reads: { prepare: async () => { throw new Error("not used") } },
    ledger: {
      totals: async () => ({ startsToday: 0, dbuHoursToday: 0, startsSession: 0, dbuHoursSession: 0, estimate: true }),
      charge: async () => ({ recorded: true, totals: { startsToday: 0, dbuHoursToday: 0, startsSession: 0, dbuHoursSession: 0, estimate: true } }),
      starts: async () => [],
    },
    clock: { now: () => 1_000_000, uuid: () => "id" },
    submitted: () => submitted,
  }
  return base as unknown as Deps
}

const call = { sessionID: "s", agent: "a", messageID: "m", id: "c", signal: new AbortController().signal, account: "work" }

describe("a plan and its commit", () => {
  it("answers the commit method and a private plan, never a planId", async () => {
    const answer = (await planWrite({ account: "work", warehouse: "wh-small", sql: "CREATE TABLE main.default.orders (id INT)" }, call, deps())) as { method: string; plan: { category: string; payload: { sql: string } } }
    expect(answer.method).toBe("write")
    expect(answer.plan.category).toBe("write")
    expect(answer.plan.payload.sql).toContain("CREATE TABLE")
    expect(answer).not.toHaveProperty("planId")
  })

  it("runs exactly the planned text, once, tagged with the plan id", async () => {
    const d = deps()
    const answer = await planWrite({ account: "work", warehouse: "wh-small", sql: "CREATE TABLE main.default.orders (id INT)" }, call, d)
    const out = (await commitTool("write")({ planId: "plan-1" }, { ...call, plan: answer }, d)) as { statementId: string; state: string }
    expect(out.statementId).toBe("stmt-1")
    const submitted = (d as unknown as { submitted: () => { statement: string; queryTags: Record<string, string> } }).submitted()
    expect(submitted?.statement).toContain("CREATE TABLE main.default.orders")
    expect(submitted?.queryTags.oc_plan).toBe("plan-1")
  })

  it("refuses a change of another class with the plan method to call", async () => {
    await expect(planWrite({ account: "work", warehouse: "wh-small", sql: "DROP TABLE main.default.orders" }, call, deps())).rejects.toMatchObject({ code: "INPUT_INVALID" })
  })
})
