// Every DatabricksPort method over the fake workspace: the wire shapes each API returns, mapped exactly as
// src/ports.ts types them, plus the two refinements the design gives a call (RESULTS_EXPIRED for a gone statement,
// STOP_NOT_PERMITTED and WAREHOUSE_FORBIDDEN for a refusal).
import { describe, expect, it } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import type { FunctionInfo, HistoryQuery, RunInfo, TableInfo } from "../../../src/ports.js"
import { createDatabricksClient } from "../../../src/process/client.js"
import { fakeAuth, workspace } from "./support.js"

const signal = () => new AbortController().signal

const orders: TableInfo = {
  fullName: "main.sales.orders",
  tableType: "EXTERNAL",
  dataSourceFormat: "DELTA",
  owner: "owner@example.com",
  comment: "One row per order",
  columns: [
    { name: "order_id", typeText: "BIGINT", nullable: false },
    { name: "email", typeText: "STRING", mask: { functionName: "main.governance.mask_email" } },
    { name: "region", typeText: "STRING", nullable: true },
  ],
  partitionColumns: ["region"],
  rowFilter: { functionName: "main.governance.region_filter" },
  updatedAt: 1_700_000_000_000,
}

const view: TableInfo = {
  fullName: "main.sales.v_orders",
  tableType: "VIEW",
  viewDefinition: "SELECT order_id, email FROM main.sales.orders",
  columns: [],
  viewDependencies: [
    { kind: "table", name: "main.sales.orders" },
    { kind: "function", name: "system.ai.python_exec" },
    { kind: "connection", name: "warehouse_http" },
  ],
}

const noDependencies: TableInfo = { fullName: "main.sales.v_unknown", tableType: "VIEW", viewDefinition: "SELECT 1", columns: [] }

const mask: FunctionInfo = { fullName: "main.governance.mask_email", routineBody: "SQL", routineDefinition: "SELECT concat('***')", routineDependencies: [{ kind: "table", name: "main.sales.orders" }], sqlPath: "main.governance", isTableFunction: false }
const python: FunctionInfo = { fullName: "main.governance.py_udf", routineBody: "EXTERNAL", externalLanguage: "PYTHON", routineDefinition: "def f(x): return x", isTableFunction: false }
const udtf: FunctionInfo = { fullName: "main.governance.udtf", routineBody: "SQL", routineDefinition: "SELECT 1", isTableFunction: true }

const runs: RunInfo[] = [
  { runId: 101, jobId: 10, runName: "nightly", state: { lifeCycleState: "TERMINATED", resultState: "SUCCESS" }, startTime: 1_700_000_000_000, endTime: 1_700_000_060_000, creatorUserName: "user@example.com" },
  { runId: 102, jobId: 10, runName: "nightly", state: { lifeCycleState: "RUNNING" }, startTime: 1_700_000_100_000, creatorUserName: "user@example.com" },
]

const history: HistoryQuery[] = [
  { queryId: "q-old", status: "FINISHED", statementType: "SELECT", warehouseId: "wh-small", userId: 1, queryStartTimeMs: 1_000, durationMs: 20, rowsProduced: 2, readBytes: 4096, queryText: "SELECT 1", isFinal: true },
  { queryId: "q-mid", status: "FINISHED", statementType: "SELECT", warehouseId: "wh-small", userId: 1, queryStartTimeMs: 2_000, durationMs: 30, queryTags: { oc_plugin: "databricks", oc_call: "c2" }, isFinal: true },
  { queryId: "q-new", status: "CANCELED", warehouseId: "wh-other", userId: 2, queryStartTimeMs: 3_000, durationMs: 40, isFinal: true, resultFromCache: true },
]

async function clientFor(seed: Parameters<typeof workspace>[0] = {}) {
  const { fake, auth } = await workspace({ tables: new Map([orders, view, noDependencies].map((table) => [table.fullName, table])), functions: new Map([mask, python, udtf].map((fn) => [fn.fullName, fn])), runs, history, ...seed })
  return { fake, auth, client: createDatabricksClient({ auth }) }
}

describe("the Databricks client: identity, warehouses and the two refusals", () => {
  it("maps the identity and the warehouses", async () => {
    const { fake, client } = await clientFor()
    try {
      expect(await client.me("work", signal())).toEqual({
        id: "1000000000000001",
        userName: "user@example.com",
        displayName: "Example User",
        // SCIM's groups (`value`/`display`) become the port's `{ id, displayName }`.
        groups: [{ id: "2000000000000001", displayName: "readers" }],
      })
      const warehouses = await client.listWarehouses("work", signal())
      expect(warehouses.find((warehouse) => warehouse.id === "wh-small")).toMatchObject({ state: "RUNNING", serverless: true, warehouseType: "PRO", clusterSize: "Small", autoStopMins: 5, minNumClusters: 1, maxNumClusters: 1 })
      expect(warehouses.find((warehouse) => warehouse.id === "wh-stopped")?.state).toBe("STOPPED")
      expect(await client.getWarehouse("work", "wh-stopped", signal())).toMatchObject({ id: "wh-stopped", state: "STOPPED" })
    } finally {
      await fake.close()
    }
  })

  it("starts and stops a warehouse", async () => {
    const { fake, client } = await clientFor()
    try {
      await client.startWarehouse("work", "wh-stopped", signal())
      expect(fake.state.warehouses.get("wh-stopped")?.state).toBe("RUNNING")
      await client.stopWarehouse("work", "wh-small", signal())
      expect(fake.state.warehouses.get("wh-small")?.state).toBe("STOPPED")
    } finally {
      await fake.close()
    }
  })

  it("refuses a start without Can use as WAREHOUSE_FORBIDDEN, and a stop as STOP_NOT_PERMITTED", async () => {
    const auth = fakeAuth({ alias: "work", mode: "interactive", host: "https://workspace.example", cloud: "aws", features: [], enforcement: "identity" })
    const forbidden = async () => new Response(JSON.stringify({ error_code: "PERMISSION_DENIED", message: "You need CAN USE." }), { status: 403 })
    const client = createDatabricksClient({ auth, fetch: forbidden })
    expect((await client.startWarehouse("work", "wh-small", signal()).catch((failure: unknown) => failure) as DatabricksError).code).toBe("WAREHOUSE_FORBIDDEN")
    expect((await client.stopWarehouse("work", "wh-small", signal()).catch((failure: unknown) => failure) as DatabricksError).code).toBe("STOP_NOT_PERMITTED")
  })

  it("answers RESULTS_EXPIRED for a statement the warehouse no longer holds", async () => {
    const { fake, client } = await clientFor()
    try {
      expect((await client.getStatement("work", "not-a-statement", signal()).catch((failure: unknown) => failure) as DatabricksError).code).toBe("RESULTS_EXPIRED")
      expect((await client.getWarehouse("work", "nope", signal()).catch((failure: unknown) => failure) as DatabricksError).code).toBe("NOT_FOUND")
    } finally {
      await fake.close()
    }
  })
})

describe("the Databricks client: Unity Catalog", () => {
  it("lists catalogs, schemas, tables and functions derived from what the workspace holds", async () => {
    const { fake, client } = await clientFor()
    try {
      expect((await client.listCatalogs("work", {}, signal())).items.map((item) => item.name)).toEqual(["main"])
      expect((await client.listSchemas("work", "main", {}, signal())).items.map((item) => item.name)).toEqual(["sales", "governance"])
      const tables = await client.listTables("work", "main", "sales", {}, signal())
      expect(tables.items.map((item) => item.name).sort()).toEqual(["orders", "v_orders", "v_unknown"])
      expect(tables.items.find((item) => item.name === "v_orders")).toMatchObject({ tableType: "VIEW" })
      expect((await client.listFunctions("work", "main", "governance", {}, signal())).items.map((item) => `${item.name}:${item.routineBody}`).sort()).toEqual(["mask_email:SQL", "py_udf:EXTERNAL", "udtf:SQL"])
      expect((await client.listVolumes("work", "main", "sales", {}, signal())).items).toEqual([])
      expect((await client.listCatalogs("work", {}, signal())).nextPageToken).toBeUndefined()
    } finally {
      await fake.close()
    }
  })

  it("reads a table's masks, row filter and view dependencies, and keeps an unknown dependency list unknown", async () => {
    const { fake, client } = await clientFor()
    try {
      const table = await client.getTable("work", "main.sales.orders", signal())
      expect(table.tableType).toBe("EXTERNAL")
      expect(table.columns[1]).toEqual({ name: "email", typeText: "STRING", mask: { functionName: "main.governance.mask_email" } })
      expect(table.rowFilter).toEqual({ functionName: "main.governance.region_filter" })
      // The partition columns come from the columns' `partition_index`, in that order.
      expect(table.partitionColumns).toEqual(["region"])
      const dependent = await client.getTable("work", "main.sales.v_orders", signal())
      expect(dependent.viewDefinition).toContain("SELECT order_id")
      expect(dependent.viewDependencies).toEqual([
        { kind: "table", name: "main.sales.orders" },
        { kind: "function", name: "system.ai.python_exec" },
        { kind: "connection", name: "warehouse_http" },
      ])
      // "when DependencyList is None, the dependency is not provided": the port keeps that undefined, not empty.
      expect((await client.getTable("work", "main.sales.v_unknown", signal())).viewDependencies).toBeUndefined()
    } finally {
      await fake.close()
    }
  })

  it("reads a function's body, language, dependencies and table-function shape", async () => {
    const { fake, client } = await clientFor()
    try {
      expect(await client.getFunction("work", "main.governance.mask_email", signal())).toEqual(mask)
      // UC's `sql_path` is carried: package C checks a body's unqualified names against it.
      expect((await client.getFunction("work", "main.governance.mask_email", signal())).sqlPath).toBe("main.governance")
      expect(await client.getFunction("work", "main.governance.py_udf", signal())).toEqual(python)
      expect((await client.getFunction("work", "main.governance.udtf", signal())).isTableFunction).toBe(true)
      expect((await client.getFunction("work", "main.governance.missing", signal()).catch((failure: unknown) => failure) as DatabricksError).code).toBe("NOT_FOUND")
    } finally {
      await fake.close()
    }
  })

  it("reads effective permissions as principal and privileges, narrowed by principal", async () => {
    const { fake, client } = await clientFor()
    try {
      const assignments = await client.effectivePermissions("work", { type: "table", fullName: "main.sales.orders" }, signal())
      expect(assignments).toEqual([{ principal: "user@example.com", privileges: ["USE_CATALOG", "USE_SCHEMA", "SELECT", "EXECUTE"] }])
      // The API's securable type is upper case; the port's is the tool's own word. A `principal` narrows the call.
      expect(fake.requests.at(-1)?.path).toBe("/api/2.1/unity-catalog/effective-permissions/TABLE/main.sales.orders")
      await client.effectivePermissions("work", { type: "table", fullName: "main.sales.orders" }, signal(), "readers")
      expect(fake.requests.at(-1)?.query.principal).toBe("readers")
    } finally {
      await fake.close()
    }
  })

  it("pages effective permissions to the end", async () => {
    const auth = fakeAuth({ alias: "work", mode: "interactive", host: "https://workspace.example", cloud: "aws", features: [], enforcement: "identity" })
    const pages = [
      { privilege_assignments: [{ principal: "user@example.com", privileges: [{ privilege: "SELECT" }] }], next_page_token: "page-2" },
      { privilege_assignments: [{ principal: "readers", privileges: [{ privilege: "SELECT" }, { privilege: "USE_SCHEMA" }] }] },
    ]
    let asked = 0
    const client = createDatabricksClient({
      auth,
      fetch: async (input) => {
        const url = new URL(input)
        const page = pages[url.searchParams.get("page_token") === "page-2" ? 1 : 0]
        asked += 1
        return new Response(JSON.stringify(page), { status: 200 })
      },
    })
    const assignments = await client.effectivePermissions("work", { type: "catalog", fullName: "main" }, signal())
    expect(assignments).toEqual([
      { principal: "user@example.com", privileges: ["SELECT"] },
      { principal: "readers", privileges: ["SELECT", "USE_SCHEMA"] },
    ])
    expect(asked).toBe(2)
  })

  it("lists UC connections, the metastore's default catalog and a table's tags", async () => {
    const { fake, client } = await clientFor()
    try {
      expect(await client.listConnections("work", {}, signal())).toEqual({ items: [] })
      expect(await client.currentMetastoreAssignment("work", signal())).toEqual({ defaultCatalogName: "main" })
      expect(await client.listTagAssignments("work", { type: "tables", fullName: "main.sales.orders" }, signal())).toEqual([])
      expect(fake.requests.find((entry) => entry.path === "/api/2.1/unity-catalog/tag-assignments")?.query).toMatchObject({ entity_type: "tables", entity_name: "main.sales.orders" })
    } finally {
      await fake.close()
    }
  })
})

describe("the Databricks client: Query History and saved queries", () => {
  it("maps a history page, filters it with the API's dotted parameters, and pages it", async () => {
    const { fake, client } = await clientFor()
    try {
      const page = await client.history("work", { maxResults: 2 }, signal())
      expect(page.items.map((item) => item.queryId)).toEqual(["q-new", "q-mid"])
      expect(page.nextPageToken).toBe("p:2")
      const rest = await client.history("work", { maxResults: 2, pageToken: page.nextPageToken }, signal())
      expect(rest.items.map((item) => item.queryId)).toEqual(["q-old"])
      expect(rest.nextPageToken).toBeUndefined()
      const mine = await client.history("work", { warehouseIds: ["wh-small"], userIds: [1] }, signal())
      expect(mine.items.map((item) => item.queryId)).toEqual(["q-mid", "q-old"])
      const tagged = (await client.history("work", { includeMetrics: true }, signal())).items[0]!
      expect(tagged).toMatchObject({ status: "CANCELED", resultFromCache: true, durationMs: 40, isFinal: true })
      // `metrics` (and so resultFromCache) is absent unless the request asks for it, as the API documents (M5).
      expect((await client.history("work", {}, signal())).items[0]?.resultFromCache).toBeUndefined()
      expect(fake.requests.some((entry) => entry.query.include_metrics === "true")).toBe(true)
      const elapsed = await client.history("work", { startMs: 2_500 }, signal())
      expect(elapsed.items.map((item) => item.queryId)).toEqual(["q-new"])
    } finally {
      await fake.close()
    }
  })

  it("filters by statement ids, and reads cache_query_id and the metrics only when asked (M5)", async () => {
    const seeded: HistoryQuery[] = [
      { queryId: "stmt-a", status: "FINISHED", warehouseId: "wh-small", userId: 1, queryStartTimeMs: 2_000, isFinal: true, resultFromCache: true, cacheQueryId: "stmt-cached", readBytes: 512 },
      { queryId: "stmt-b", status: "FINISHED", warehouseId: "wh-small", userId: 1, queryStartTimeMs: 1_000, isFinal: true },
    ]
    const { fake, auth } = await workspace({ history: seeded })
    try {
      const client = createDatabricksClient({ auth })
      const one = await client.history("work", { statementIds: ["stmt-a"], includeMetrics: true }, signal())
      expect(one.items.map((item) => item.queryId)).toEqual(["stmt-a"])
      expect(one.items[0]).toMatchObject({ resultFromCache: true, cacheQueryId: "stmt-cached", readBytes: 512 })
      expect(fake.requests.at(-1)?.query["filter_by.statement_ids"]).toBe("stmt-a")
    } finally {
      await fake.close()
    }
  })

  it("maps UC tag assignments, with the column name for a column entity", async () => {
    const auth = fakeAuth({ alias: "work", mode: "interactive", host: "https://workspace.example", cloud: "aws", features: [], enforcement: "identity" })
    const client = createDatabricksClient({
      auth,
      fetch: async () => new Response(JSON.stringify({ tag_assignments: [{ tag_key: "pii", tag_value: "true" }, { tag_key: "owner" }] }), { status: 200 }),
    })
    expect(await client.listTagAssignments("work", { type: "tables", fullName: "main.sales.orders" }, signal())).toEqual([{ key: "pii", value: "true" }, { key: "owner" }])
    expect(await client.listTagAssignments("work", { type: "columns", fullName: "main.sales.orders.email" }, signal())).toEqual([
      { key: "pii", value: "true", column: "email" },
      { key: "owner", column: "email" },
    ])
  })

  it("serialises saved-query reads, which the Queries API warns against running concurrently", async () => {
    let active = 0
    let peak = 0
    const auth = fakeAuth({ alias: "work", mode: "interactive", host: "https://workspace.example", cloud: "aws", features: [], enforcement: "identity" })
    const client = createDatabricksClient({
      auth,
      fetch: async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 10))
        active -= 1
        return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } })
      },
    })
    await Promise.all([client.listQueries("work", {}, signal()), client.listQueries("work", {}, signal())])
    expect(peak).toBe(1)
  })

  it("lists no saved queries and answers NOT_FOUND for one: the fake seeds none (see the fake's header)", async () => {
    const { fake, client } = await clientFor()
    try {
      expect((await client.listQueries("work", {}, signal())).items).toEqual([])
      expect((await client.getQuery("work", "q-1", signal()).catch((failure: unknown) => failure) as DatabricksError).code).toBe("NOT_FOUND")
    } finally {
      await fake.close()
    }
  })
})

describe("the Databricks client: jobs", () => {
  it("maps jobs, runs, one run's tasks and its output", async () => {
    const { fake, client } = await clientFor()
    try {
      expect((await client.listJobs("work", {}, signal())).items).toEqual([{ jobId: 10, name: "nightly", creatorUserName: "user@example.com" }])
      expect((await client.listRuns("work", {}, signal())).items.map((run) => run.runId)).toEqual([102, 101])
      const runsPage = await client.listRuns("work", { jobId: 10 }, signal())
      expect(runsPage.items.map((run) => run.runId)).toEqual([102, 101])
      expect(runsPage.items[1]).toMatchObject({ state: { lifeCycleState: "TERMINATED", resultState: "SUCCESS" }, endTime: 1_700_000_060_000 })
      expect((await client.listRuns("work", { jobId: 10, completedOnly: true }, signal())).items.map((run) => run.runId)).toEqual([101])
      const run = await client.getRun("work", 101, signal())
      expect(run.tasks).toEqual([{ taskKey: "main", state: "SUCCESS", durationMs: 60_000 }])
      expect(await client.getRunOutput("work", 101, signal())).toEqual({ output: "Example output for run 101." })
    } finally {
      await fake.close()
    }
  })

  it("replays a run for the same idempotency token and starts one otherwise (L13's client half)", async () => {
    const { fake, client } = await clientFor()
    try {
      const first = await client.runNow("work", { jobId: 10, idempotencyToken: "plan-1" }, signal())
      const replay = await client.runNow("work", { jobId: 10, idempotencyToken: "plan-1" }, signal())
      const other = await client.runNow("work", { jobId: 10, idempotencyToken: "plan-2" }, signal())
      expect(replay.runId).toBe(first.runId)
      expect(other.runId).not.toBe(first.runId)
      const submitted = await client.submitRun("work", { notebookPath: "/Shared/example", idempotencyToken: "plan-3", timeoutSeconds: 3600 }, signal())
      expect(submitted.runId).toBeGreaterThan(0)
      const body = fake.requests.find((entry) => entry.path === "/api/2.2/jobs/runs/submit")?.body as Record<string, unknown>
      expect(body).toMatchObject({ timeout_seconds: 3600, idempotency_token: "plan-3" })
      await client.cancelRun("work", first.runId, signal())
      expect(fake.state.runs.find((run) => run.runId === first.runId)?.state).toMatchObject({ lifeCycleState: "TERMINATED", resultState: "CANCELED" })
    } finally {
      await fake.close()
    }
  })
})

describe("the Databricks client: workspace and Files", () => {
  it("lists a folder, exports a notebook's source and lists a volume directory", async () => {
    const { fake, client } = await clientFor()
    try {
      expect(await client.listWorkspace("work", "/", signal())).toEqual([{ path: "/Shared", objectType: "DIRECTORY" }])
      expect((await client.exportNotebook("work", "/Shared/example", signal())).source).toContain("# Databricks notebook source")
      expect(await client.listDirectory("work", "/Volumes/main/sales/landing", signal())).toEqual([])
      expect((await client.listWorkspace("work", "/Nope", signal()).catch((failure: unknown) => failure) as DatabricksError).code).toBe("NOT_FOUND")
    } finally {
      await fake.close()
    }
  })
})
