import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { DatabricksError } from "../../src/domain/errors.js"
import { loadOptions } from "../../src/options.js"
import { savedRead } from "../../src/handlers/sources/saved.js"
import type { Deps } from "../../src/handlers/deps.js"
import type { Warehouse } from "../../src/ports.js"

const query = { id: "q1", name: "Revenue", queryText: "SELECT 1", warehouseId: "wh-small" }
const sha = createHash("sha256").update(query.queryText).digest("hex")
const warehouse: Warehouse = { id: "wh-small", name: "small", state: "RUNNING", warehouseType: "PRO", serverless: true, clusterSize: "Small", autoStopMins: 5, minNumClusters: 1, maxNumClusters: 1 }

const deps = {
  options: loadOptions({}),
  auth: { account: () => ({ alias: "work", mode: "pat", host: "https://example.cloud.databricks.com", cloud: "aws", features: [], enforcement: "identity" }) },
  databricks: { getQuery: async () => query, getWarehouse: async () => warehouse },
  reads: { prepare: async () => Promise.reject(new DatabricksError("AUTH_REQUIRED", "The stored sign-in is held by the host and cannot be renewed here.", "Sign in again.")) },
  ledger: { totals: async () => ({ startsToday: 0, dbuHoursToday: 0, startsSession: 0, dbuHoursSession: 0, estimate: true }), charge: async () => ({ recorded: true, totals: { startsToday: 0, dbuHoursToday: 0, startsSession: 0, dbuHoursSession: 0, estimate: true } }), starts: async () => [] },
  clock: { now: () => 0, uuid: () => "id" },
} as unknown as Deps

const call = { sessionID: "s", agent: "a", messageID: "m", id: "c", signal: new AbortController().signal, account: "work" }

describe("the saved snapshot", () => {
  it("surfaces a host-held sign-in as NEEDS_SIGN_IN", async () => {
    const error = (await savedRead(deps, { account: "work", query: query.id, sha }, call).catch((caught: unknown) => caught)) as { code: string; what: string }
    expect(error.code).toBe("NEEDS_SIGN_IN")
    expect(error.what).toContain("held by the host")
  })
})
