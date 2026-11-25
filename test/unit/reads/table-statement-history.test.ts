/**
 * `databricks_table`, `databricks_statement` and `databricks_history` (design §4, §5.4, §5.7, [24], [26]).
 *
 * `databricks_table`:
 * - the metadata read is `tables.get`, free, and shows each column's mask and the table's row filter **by name**, with
 *   `MASKED_COLUMNS` and `ROW_FILTERED` — the disclosure's promise that the plugin shows what it cannot see (L14);
 * - a view's definition is cut to 2,000 characters, and its recorded dependencies are listed;
 * - `sample` runs `SELECT * FROM <table> LIMIT n` through the whole read path (a table assert, the fence, the warehouse
 *   policy), and `lineage` reads `system.access.table_lineage` with the table name as a `:oc_table` parameter [26];
 * - `warehouse` and `start` are refused without `sample` or `lineage`, so a metadata call never implies a start.
 *
 * `databricks_statement` maps a 404 to `RESULTS_EXPIRED` (results live 12 hours [6]), pages chunks and never sends a
 * statement. `databricks_history` filters Query History by the identity's own user id with **no status filter** [24]
 * (review L2), filters locally, and keeps `query_text` to 200 characters as untrusted data.
 */
import { describe, expect, it } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import { HANDLERS } from "../../../src/registry.js"
import { runTool } from "../../../src/tool-spec.js"
import { LINEAGE_SQL } from "../../../src/tools/reads/sql.js"
import { sinceToMs, MAX_SINCE_MS } from "../../../src/tools/reads/history.js"
import { forgetStatementAges } from "../../../src/tools/reads/statement.js"
import { asserted, cells, harness, readRequests, statementsSent, tableOf } from "./tool-harness.js"

const viewDefinition = `SELECT ${"a, ".repeat(1500)}a FROM main.s.t`

describe("databricks_table", () => {
  const view = {
    getTable: () =>
      Promise.resolve(
        tableOf({
          fullName: "main.sales.orders_v",
          tableType: "VIEW",
          dataSourceFormat: "DELTA",
          comment: "orders, masked",
          owner: "sales@example.invalid",
          columns: [
            { name: "id", typeText: "BIGINT", nullable: false },
            { name: "email", typeText: "STRING", mask: { functionName: "main.masks.email" } },
          ],
          rowFilter: { functionName: "main.filters.region" },
          partitionColumns: ["region", "day"],
          viewDefinition,
          viewDependencies: [
            { kind: "table", name: "main.sales.orders" },
            { kind: "function", name: "main.functions.year_of" },
          ],
          updatedAt: 1_700_000_000_000,
        }),
      ),
  }

  it("shows columns, masks and the row filter by name, cuts the view definition, and flags both", async () => {
    const h = harness({ answers: { ...view } as never })
    const result = await runTool("table", { name: "main.sales.orders_v" }, h.call(), h.deps, HANDLERS)
    expect(result).toMatchObject({ state: "ok", trust: "untrusted", name: "main.sales.orders_v", tableType: "VIEW", format: "DELTA", rowFilter: "main.filters.region" })
    expect(result.columns).toEqual([
      { name: "id", type: "BIGINT", nullable: false },
      { name: "email", type: "STRING", mask: "main.masks.email" },
    ])
    expect(String(result.viewDefinition)).toContain("…[cut ")
    expect(result.viewDependencies).toEqual([
      { kind: "table", name: "main.sales.orders" },
      { kind: "function", name: "main.functions.year_of" },
    ])
    expect(result.partitionColumns).toEqual(["region", "day"])
    expect(result.updatedAt).toBe(new Date(1_700_000_000_000).toISOString())
    expect((result.warnings as { code: string }[]).map((warning) => warning.code)).toEqual(["MASKED_COLUMNS", "ROW_FILTERED"])
    // Its operation, then the table itself: a person's `deny databricks.table on work:table:*.hr.*` stops a view
    // definition and column comments too (review LOW 4).
    expect(asserted(h.permission)).toEqual(["databricks.table on work:unity-catalog.tables.get", "databricks.table on work:table:main.sales.orders_v"])
    expect(statementsSent(h.databricks)).toEqual([])
  })

  it("samples through the read path: SELECT * FROM <table> LIMIT n, on the warehouse policy", async () => {
    const h = harness({
      answers: {
        ...view,
        getTable: (_account: unknown, fullName: unknown) => {
          const name = String(fullName)
          if (name === "main.sales.orders_v") return view.getTable()
          if (name === "main.s.t" || name === "main.sales.orders") return Promise.resolve(tableOf({ fullName: name }))
          return Promise.reject(new DatabricksError("NOT_FOUND"))
        },
        // The view's recorded function dependency, checked under the same rules (design §5.4).
        getFunction: () => Promise.resolve({ fullName: "main.functions.year_of", routineBody: "SQL", routineDefinition: "year(a)", isTableFunction: false, sqlPath: "system.session,system.builtin,system.ai,main.functions" }),
        submit: () => ({ statementId: "st-1", state: "SUCCEEDED", manifest: { columns: [{ name: "id", typeName: "BIGINT", typeText: "BIGINT", position: 0 }] }, rows: [["1"]] }),
      } as never,
    })
    const result = await runTool("table", { name: "main.sales.orders_v", sample: 5 }, h.call(), h.deps, HANDLERS)
    expect(readRequests(h.databricks)[0]?.statement).toBe("SELECT * FROM (\nSELECT * FROM `main`.`sales`.`orders_v` LIMIT 5\n) AS oc_q")
    expect(result.sample).toEqual({ columns: ["id"], rows: [[1]] })
    // The sample's own cost: the warehouse it ran on and its estimated $/hour.
    expect(result.warehouse).toEqual({ id: "wh-small", name: "bi-small", started: false, usdPerHour: expect.any(Number) })
    // The tool's own metadata read asserts the table (LOW 4), then the read path asserts the sample's table and both
    // sources of the view's dependencies: the recorded one and the one its body names (the union, review delta check).
    expect(asserted(h.permission)).toEqual([
      "databricks.table on work:unity-catalog.tables.get",
      "databricks.table on work:table:main.sales.orders_v",
      "databricks.table on work:table:main.sales.orders_v",
      "databricks.table on work:table:main.sales.orders",
      "databricks.table on work:table:main.s.t",
    ])
  })

  it("reads lineage from system.access.table_lineage with the name as a :oc_table parameter", async () => {
    const h = harness({
      answers: {
        ...view,
        getTable: (_account: unknown, fullName: unknown) => Promise.resolve(tableOf({ fullName: String(fullName) })),
        submit: () => ({
          statementId: "st-2",
          state: "SUCCEEDED",
          manifest: {
            columns: [
              { name: "source", typeName: "STRING", typeText: "STRING", position: 0 },
              { name: "target", typeName: "STRING", typeText: "STRING", position: 1 },
              { name: "at", typeName: "TIMESTAMP", typeText: "TIMESTAMP", position: 2 },
            ],
          },
          rows: [["main.sales.orders", "main.sales.orders_v", "2026-11-17T09:00:00Z"]],
        }),
      } as never,
    })
    const result = await runTool("table", { name: "main.sales.orders_v", lineage: true }, h.call(), h.deps, HANDLERS)
    expect(readRequests(h.databricks)[0]?.statement).toBe(`SELECT * FROM (\n${LINEAGE_SQL}\n) AS oc_q`)
    expect(readRequests(h.databricks)[0]?.parameters).toEqual([{ name: "oc_table", value: "main.sales.orders_v", type: "STRING" }])
    expect(result.lineage).toEqual([{ source: "main.sales.orders", target: "main.sales.orders_v", at: "2026-11-17T09:00:00Z" }])
    expect(result.warehouse).toEqual({ id: "wh-small", name: "bi-small", started: false, usdPerHour: expect.any(Number) })
    // The lineage table is resolved and asserted like any other the read touches.
    expect(asserted(h.permission)).toEqual(expect.arrayContaining(["databricks.table on work:table:system.access.table_lineage"]))
  })

  it("refuses warehouse and start without a sample or lineage, before any call", async () => {
    const h = harness({ answers: { ...view } as never })
    const result = await runTool("table", { name: "main.sales.orders_v", warehouse: "wh-small", start: true }, h.call(), h.deps, HANDLERS)
    expect(result).toMatchObject({ error: "INPUT_INVALID" })
    expect(h.databricks.calls.filter((entry) => entry.method !== "getTable")).toEqual([])
  })

  it("lets Databricks say a table is not there", async () => {
    const h = harness({ answers: { getTable: () => Promise.reject(new DatabricksError("NOT_FOUND")) } as never })
    expect(await runTool("table", { name: "main.s.nope" }, h.call(), h.deps, HANDLERS)).toMatchObject({ state: "refused", error: "NOT_FOUND" })
  })
})

describe("databricks_statement", () => {
  const statement = (overrides: Record<string, unknown> = {}) => ({
    statementId: "st-1",
    state: "SUCCEEDED",
    manifest: { columns: [{ name: "id", typeName: "BIGINT", typeText: "BIGINT", position: 0 }] },
    nextChunkIndex: 1,
    rows: [["1"]],
    ...overrides,
  })

  it("answers one statement's state and rows, and pages a chunk", async () => {
    const h = harness({ answers: { getStatement: () => statement(), getChunk: () => statement({ rows: [["2"]] }) } as never })
    const first = await runTool("statement", { statementId: "st-1" }, h.call(), h.deps, HANDLERS)
    expect(first).toMatchObject({ state: "ok", statementId: "st-1", status: "SUCCEEDED", nextChunk: 1 })
    expect(first.rows).toEqual([[1]])
    const second = await runTool("statement", { statementId: "st-1", chunk: 1 }, h.call("call_2"), h.deps, HANDLERS)
    expect(second).toMatchObject({ chunk: 1 })
    expect(statementsSent(h.databricks)).toEqual([])
  })

  it("maps a statement Databricks no longer has to RESULTS_EXPIRED", async () => {
    const h = harness({ answers: { getStatement: () => Promise.reject(new DatabricksError("NOT_FOUND")) } as never })
    const result = await runTool("statement", { statementId: "st-gone" }, h.call(), h.deps, HANDLERS)
    expect(result).toMatchObject({ state: "refused", error: "RESULTS_EXPIRED" })
  })

  it("maps a FAILED statement to STATEMENT_FAILED, its text only in providerError", async () => {
    const provider = { errorCode: "PERMISSION_DENIED", message: "User does not have SELECT", trust: "untrusted" as const }
    const h = harness({ answers: { getStatement: () => statement({ state: "FAILED", error: provider }) } as never })
    const result = await runTool("statement", { statementId: "st-1" }, h.call(), h.deps, HANDLERS)
    expect(result).toMatchObject({ state: "failed", error: "STATEMENT_FAILED" })
    expect(result.providerError).toMatchObject(provider)
    expect(result.message).not.toContain("SELECT")
  })

  it("cancels a statement older than maxRunSeconds, while this process runs, and answers RUN_TIMEOUT", async () => {
    forgetStatementAges()
    const h = harness({ options: { maxRunSeconds: 60 }, answers: { getStatement: () => statement({ state: "RUNNING", rows: undefined }) } as never })
    const first = await runTool("statement", { statementId: "st-long" }, h.call(), h.deps, HANDLERS)
    expect(first).toMatchObject({ state: "running" })
    h.clock.advance(61_000)
    const second = await runTool("statement", { statementId: "st-long" }, h.call("call_2"), h.deps, HANDLERS)
    expect(second).toMatchObject({ state: "failed", error: "RUN_TIMEOUT" })
    expect(h.databricks.calls.filter((entry) => entry.method === "cancelStatement")).toHaveLength(1)
  })

  it("answers running, and CANCELED as cancelled", async () => {
    const running = harness({ answers: { getStatement: () => statement({ state: "RUNNING", rows: undefined }) } as never })
    expect(await runTool("statement", { statementId: "st-1" }, running.call(), running.deps, HANDLERS)).toMatchObject({ state: "running" })
    const cancelled = harness({ answers: { getStatement: () => statement({ state: "CANCELED", rows: undefined }) } as never })
    expect(await runTool("statement", { statementId: "st-1" }, cancelled.call(), cancelled.deps, HANDLERS)).toMatchObject({ state: "cancelled" })
  })
})

describe("databricks_history", () => {
  const me = { me: () => ({ id: "4821", userName: "reader@example.invalid", displayName: "Reader" }) }
  const page = (items: unknown[]) => ({ items })

  it("filters by the identity's user id and by time, without a status filter, and filters the status here", async () => {
    const now = Date.parse("2026-11-17T12:00:00Z")
    const h = harness({
      answers: {
        ...me,
        history: (_account: unknown, filter: unknown) => page([
          { queryId: "q-1", status: "FINISHED", statementType: "SELECT", warehouseId: "wh-small", queryStartTimeMs: now - 1000, durationMs: 12, rowsProduced: 3, readBytes: 400, queryTags: { oc_tool: "query" }, queryText: "select * from main.s.t", isFinal: true },
          { queryId: "q-2", status: "FAILED", queryStartTimeMs: now - 2000, queryText: "select secret('s','k')" },
        ]),
      } as never,
    })
    h.clock.advance(0)
    const fakeNow = now - h.clock.now()
    h.clock.advance(fakeNow)
    const result = await runTool("history", { limit: 25 }, h.call(), h.deps, HANDLERS)
    const filter = h.databricks.calls.find((entry) => entry.method === "history")?.args[1] as Record<string, unknown>
    expect(filter.userIds).toEqual([4821])
    expect(filter.maxResults).toBe(25)
    expect(filter.status).toBeUndefined()
    expect(typeof filter.startMs).toBe("number")
    expect((result.items as { id: string }[]).map((item) => item.id)).toEqual(["q-1", "q-2"])
    expect((result.items as { sql?: string }[])[1]?.sql).toBe("select secret('s','k')")
    const failed = await runTool("history", { status: "FAILED" }, h.call("call_2"), h.deps, HANDLERS)
    expect((failed.items as { id: string }[]).map((item) => item.id)).toEqual(["q-2"])
  })

  it("takes since as an ISO date, a timestamp or an age, and refuses a window beyond 30 days", async () => {
    const now = Date.parse("2026-11-17T12:00:00Z")
    expect(sinceToMs("24h", now)).toBe(now - 86_400_000)
    expect(sinceToMs("7d", now)).toBe(now - 7 * 86_400_000)
    expect(sinceToMs("2026-11-10T00:00:00Z", now)).toBe(Date.parse("2026-11-10T00:00:00Z"))
    expect(sinceToMs(undefined, now)).toBe(now - 86_400_000)
    expect(() => sinceToMs("31d", now)).toThrow(/30 days/)
    expect(() => sinceToMs("2026-01-01", now)).toThrow(/30 days/)
    expect(() => sinceToMs("yesterday", now)).toThrow(/ISO 8601/)
    expect(MAX_SINCE_MS).toBe(30 * 86_400_000)
    const h = harness({ answers: { ...me, history: () => page([]) } as never })
    expect(await runTool("history", { since: "31d" }, h.call(), h.deps, HANDLERS)).toMatchObject({ error: "INPUT_INVALID" })
  })

  it("refuses an identity whose id is not numeric, because Query History filters by a number", async () => {
    const h = harness({ answers: { me: () => ({ id: "principal-uuid", userName: "sp@example.invalid" }) } as never })
    expect(await runTool("history", {}, h.call(), h.deps, HANDLERS)).toMatchObject({ state: "failed", error: "UNAVAILABLE" })
  })

  it("truncates query_text to 200 characters: it is untrusted and carries literals", async () => {
    const h = harness({ answers: { ...me, history: () => page([{ queryId: "q-1", status: "FINISHED", queryStartTimeMs: 1, queryText: "x".repeat(500) }]) } as never })
    const result = await runTool("history", {}, h.call(), h.deps, HANDLERS)
    expect(((result.items as { sql?: string }[])[0]?.sql ?? "").length).toBe(200)
  })
})
