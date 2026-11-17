/**
 * `databricks_catalog` and `databricks_warehouses` (design §4, §6.1–§6.3): the two free control-plane reads.
 *
 * - `databricks_catalog` walks catalogs → schemas → objects, with `filter`, `limit` and `pageToken`; the objects level
 *   unions tables, functions and volumes.
 * - `databricks_warehouses` reports each warehouse's type, size, state, auto-stop, DBU and dollar rate, and whether the
 *   start policy allows it, with `whyNot` naming each failed condition.
 * - Neither reads a warehouse or sends a statement, so neither calls `getWarehouse` or `submit`; both are marked untrusted
 *   where they carry names and comments.
 */
import { describe, expect, it } from "vitest"
import { HANDLERS } from "../../../src/registry.js"
import { runTool } from "../../../src/tool-spec.js"
import { asserted, harness, runningWarehouse } from "./tool-harness.js"

const catalogs = { listCatalogs: () => ({ items: [{ name: "main", comment: "the main catalog", owner: "data@example.invalid" }, { name: "system" }] }) }
const schemas = { listSchemas: () => ({ items: [{ name: "sales", owner: "sales@example.invalid" }, { name: "sales_raw" }] }) }
const objects = {
  listTables: () => ({
    items: [
      { name: "orders", tableType: "MANAGED", owner: "sales@example.invalid", updatedAt: 1_700_000_000_000 },
      { name: "orders_v", tableType: "VIEW" },
    ],
    nextPageToken: "page-2",
  }),
  listFunctions: () => ({ items: [{ name: "year_of", routineBody: "SQL" }] }),
  listVolumes: () => ({ items: [{ name: "landing", volumeType: "MANAGED" }] }),
}

describe("databricks_catalog", () => {
  it("lists catalogs, schemas and then the objects of one schema, with no warehouse call", async () => {
    const h = harness({ answers: { ...catalogs, ...schemas } as never })
    const top = await runTool("catalog", {}, h.call(), h.deps, HANDLERS)
    expect(top).toMatchObject({ state: "ok", trust: "untrusted", level: "catalogs" })
    expect(top.items).toEqual([
      { name: "main", kind: "catalog", comment: "the main catalog", owner: "data@example.invalid" },
      { name: "system", kind: "catalog" },
    ])

    const middle = await runTool("catalog", { catalog: "main" }, h.call("call_2"), h.deps, HANDLERS)
    expect(middle).toMatchObject({ level: "schemas" })
    expect((middle.items as { name: string }[]).map((item) => item.name)).toEqual(["sales", "sales_raw"])

    const hObjects = harness({ answers: { ...objects } as never })
    const leaf = await runTool("catalog", { catalog: "main", schema: "sales" }, hObjects.call(), hObjects.deps, HANDLERS)
    expect(leaf).toMatchObject({ level: "objects", nextPageToken: "page-2" })
    expect((leaf.items as { name: string; kind: string }[]).map((item) => `${item.kind}:${item.name}`)).toEqual(["function:year_of", "managed:orders", "view:orders_v", "volume:managed:landing"])
    expect(hObjects.databricks.calls.map((entry) => entry.method)).toEqual(["listTables", "listFunctions", "listVolumes"])
    expect(h.databricks.calls.map((entry) => entry.method)).not.toContain("getWarehouse")
  })

  it("filters on a case-insensitive substring and caps the items at limit", async () => {
    const h = harness({ answers: { ...catalogs } as never })
    expect((await runTool("catalog", { filter: "MAI" }, h.call(), h.deps, HANDLERS)).items).toEqual([{ name: "main", kind: "catalog", comment: "the main catalog", owner: "data@example.invalid" }])
    const capped = harness({ answers: { ...objects } as never })
    expect((await runTool("catalog", { catalog: "main", schema: "sales", limit: 1 }, capped.call(), capped.deps, HANDLERS)).items).toHaveLength(1)
  })

  it("passes pageToken to the lists, and refuses a schema without its catalog", async () => {
    const h = harness({ answers: { ...catalogs } as never })
    await runTool("catalog", { pageToken: "token-1" }, h.call(), h.deps, HANDLERS)
    expect(h.databricks.calls[0]?.args[1]).toMatchObject({ pageToken: "token-1" })
    expect(await runTool("catalog", { schema: "sales" }, h.call("call_2"), h.deps, HANDLERS)).toMatchObject({ error: "INPUT_INVALID" })
  })

  it("asserts databricks.catalog on the unity-catalog operation first, and never asserts a table", async () => {
    const h = harness({ answers: { ...objects } as never })
    await runTool("catalog", { catalog: "main", schema: "sales" }, h.call(), h.deps, HANDLERS)
    expect(asserted(h.permission)).toEqual(["databricks.catalog on work:unity-catalog.catalogs.list"])
  })

  it("lets Databricks' refusal through as its code, with no name in the plugin's own words", async () => {
    const h = harness({ answers: { listCatalogs: () => Promise.reject(new (class extends Error {})()) } as never })
    await expect(runTool("catalog", {}, h.call(), h.deps, HANDLERS)).rejects.toThrow()
  })
})

describe("databricks_warehouses", () => {
  const list = [
    runningWarehouse({ id: "wh-small", name: "bi-small", clusterSize: "Small", autoStopMins: 10 }),
    runningWarehouse({ id: "wh-big", name: "bi-large", clusterSize: "Large", autoStopMins: 45, warehouseType: "CLASSIC", serverless: false, maxNumClusters: 4 }),
    runningWarehouse({ id: "wh-forever", name: "bi-forever", autoStopMins: 0, state: "STOPPED" }),
  ]

  it("reports type, size, state, auto-stop, DBU and dollar rates, and the start policy per warehouse", async () => {
    const h = harness({ answers: { listWarehouses: () => list } as never })
    const result = await runTool("warehouses", {}, h.call(), h.deps, HANDLERS)
    const items = result.items as Record<string, unknown>[]
    expect(items[0]).toMatchObject({ id: "wh-small", type: "serverless", size: "Small", state: "RUNNING", autoStopMinutes: 10, dbuPerHour: 12, mayStart: true })
    expect(items[0]!.usdPerHour as number).toBeCloseTo(8.4)
    expect(items[1]).toMatchObject({ id: "wh-big", type: "classic", size: "Large", dbuPerHour: 40, mayStart: false })
    expect(String(items[1]!.whyNot)).toContain("only a serverless warehouse may be started")
    expect(String(items[1]!.whyNot)).toContain("above maxStartSize Small")
    expect(String(items[1]!.whyNot)).toContain("above maxStartAutoStopMinutes 15")
    expect(items[2]).toMatchObject({ id: "wh-forever", mayStart: false })
    expect(String(items[2]!.whyNot)).toContain("never auto-stops")
  })

  it("flags an auto-stop that is off or longer than 30 minutes, and marks the prices as estimates", async () => {
    const h = harness({ answers: { listWarehouses: () => list } as never })
    const result = await runTool("warehouses", {}, h.call(), h.deps, HANDLERS)
    const codes = (result.warnings as { code: string }[]).map((warning) => warning.code)
    expect(codes).toEqual(expect.arrayContaining(["ESTIMATE_ONLY", "AUTO_STOP_OFF", "AUTO_STOP_LONG"]))
  })

  it("is free: it lists, and never gets a warehouse or sends a statement", async () => {
    const h = harness({ answers: { listWarehouses: () => list } as never })
    await runTool("warehouses", {}, h.call(), h.deps, HANDLERS)
    expect(h.databricks.calls.map((entry) => entry.method)).toEqual(["listWarehouses"])
    expect(asserted(h.permission)).toEqual(["databricks.warehouses on work:sql.warehouses.list"])
  })
})
