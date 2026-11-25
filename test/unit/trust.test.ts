import { describe, expect, it, vi } from "vitest"
import cancel from "../../src/handlers/changes/cancel.js"
import stop from "../../src/handlers/changes/stop.js"
import warehouses from "../../src/handlers/reads/warehouses.js"
import query from "../../src/handlers/reads/query.js"
import { Outputs } from "../../src/handlers/schemas.js"
import { loadOptions } from "../../src/options.js"
import type { Deps } from "../../src/handlers/deps.js"
import type { Warehouse } from "../../src/ports.js"

const { prepareRead } = vi.hoisted(() => ({ prepareRead: vi.fn() }))
vi.mock("../../src/provider/guards/read.js", () => ({ prepareRead }))

const warehouse: Warehouse = { id: "wh-small", name: "small", state: "STOPPED", warehouseType: "PRO", serverless: true, clusterSize: "Small", autoStopMins: 5, minNumClusters: 1, maxNumClusters: 1 }
const running: Warehouse = { ...warehouse, state: "RUNNING" }

function deps(): Deps {
  return {
    options: loadOptions({}),
    access: "all",
    auth: {
      account: () => ({ alias: "work", mode: "pat", host: "https://example.cloud.databricks.com", cloud: "aws", features: [], enforcement: "identity" }),
      accounts: () => [],
      token: async () => ({ accessToken: "x", expiresAt: 0, scopes: [], host: "https://example.cloud.databricks.com" }),
    },
    databricks: {
      listWarehouses: async () => [],
      getWarehouse: async () => warehouse,
      me: async () => ({ id: "42", userName: "ana@example.com" }),
      history: async () => ({ items: [{ queryId: "stmt-1", executedAsUserId: 42 }] }),
      cancelStatement: async () => {},
      submit: async () => ({ statementId: "stmt-1", state: "RUNNING" }),
    },
    clock: { now: () => 0, uuid: () => "id" },
  } as unknown as Deps
}

const call = { sessionID: "s", agent: "a", messageID: "m", id: "c", signal: new AbortController().signal, account: "work" }

describe("every plugin-owned success answer", () => {
  it("marks warehouse listings and the control writes untrusted", async () => {
    const listed = (await warehouses({ account: "work" }, call, deps())) as { state: string; trust?: string }
    const stopped = (await stop({ account: "work", warehouse: "wh-small" }, call, deps())) as { state: string; trust?: string; stopped?: boolean }
    const cancelled = (await cancel({ account: "work", statementId: "stmt-1" }, call, deps())) as { state: string; trust?: string }

    expect(listed).toMatchObject({ state: "ok", trust: "untrusted" })
    expect(stopped).toMatchObject({ state: "ok", trust: "untrusted", stopped: false })
    expect(cancelled).toMatchObject({ state: "ok", trust: "untrusted" })
  })

  it("marks a query still running after the wait untrusted and matches its output schema", async () => {
    prepareRead.mockResolvedValue({
      sent: "SELECT 1",
      warehouseId: running.id,
      warehouse: running,
      tables: [],
      enforcement: "identity",
      warnings: [],
    })
    const answer = await query({ account: "work", warehouse: "wh-small", sql: "SELECT 1", wait: 60 }, call, deps())
    expect(answer).toMatchObject({ state: "running", trust: "untrusted", statementId: "stmt-1" })
    expect(Outputs.query.safeParse(answer).success).toBe(true)
  })
})
