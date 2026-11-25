import { describe, expect, it } from "vitest"
import start from "../../src/handlers/start.js"
import type { Deps } from "../../src/handlers/deps.js"
import type { Warehouse } from "../../src/ports.js"

const warehouse: Warehouse = { id: "wh-small", name: "small", state: "STOPPED", warehouseType: "PRO", serverless: true, clusterSize: "Small", autoStopMins: 5, minNumClusters: 1, maxNumClusters: 1 }

function deps(): Deps {
  let started = false
  return {
    options: { accounts: {}, maxStartSize: "Small", maxStartAutoStopMinutes: 15, wait: 1, usdPerDbu: { serverless: 0.7, pro: 0.55, classic: 0.22 } },
    access: "all",
    auth: {
      account: () => ({ alias: "work", mode: "pat", host: "https://example.cloud.databricks.com", cloud: "aws", features: [], enforcement: "identity" }),
      accounts: () => [],
      token: async () => ({ accessToken: "x", expiresAt: 0, scopes: [], host: "https://example.cloud.databricks.com" }),
    },
    databricks: {
      getWarehouse: async () => (started ? { ...warehouse, state: "RUNNING" } : warehouse),
      startWarehouse: async () => { started = true },
    },
    reads: { prepare: async () => { throw new Error("not used") } },
    ledger: {
      totals: async () => ({ startsToday: 0, dbuHoursToday: 0, startsSession: 0, dbuHoursSession: 0, estimate: true }),
      charge: async () => ({ recorded: true, totals: { startsToday: 1, dbuHoursToday: 0, startsSession: 1, dbuHoursSession: 0, estimate: true } }),
      starts: async () => [],
    },
    clock: { now: () => 0, uuid: () => "id" },
  } as unknown as Deps
}

describe("databricks.start", () => {
  it("starts a stopped warehouse and reports its state", async () => {
    const answer = (await start({ account: "work", warehouse: "wh-small" }, { sessionID: "s", agent: "a", messageID: "m", id: "c", signal: new AbortController().signal, account: "work" }, deps())) as { state: string; status?: string }
    expect(answer.state).toBe("ok")
    expect(answer.status).toBe("RUNNING")
  })
})
