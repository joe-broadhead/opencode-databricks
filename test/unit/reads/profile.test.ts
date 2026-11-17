/**
 * `databricks_profile` (design §4): one aggregate query that summarises chosen columns instead of returning rows.
 *
 * - The SQL is one statement: `count(*)` for the row count, then per column `count_if(… IS NULL)`,
 *   `approx_count_distinct`, `min`, `max`, `percentile_approx(…, array(0.25, 0.5, 0.75), 10000)` and
 *   `approx_top_k(…, 5)` — all allowlisted built-ins, so the read path qualifies them.
 * - `samplePercent` adds `TABLESAMPLE (<p> PERCENT)`; `sql` makes the source a subquery.
 * - The statement goes through the read path (its table resolved, asserted and fenced; the warehouse policy applied) and
 *   is sent wrapped, exactly as `analyzeRead` says.
 * - The one result row is read positionally: `rows`, then seven cells per column.
 */
import { describe, expect, it } from "vitest"
import { HANDLERS } from "../../../src/registry.js"
import { runTool } from "../../../src/tool-spec.js"
import { profileQuery } from "../../../src/tools/reads/sql.js"
import { analyzeRead } from "../../../src/sql/analyze.js"
import { forgetStatementTimes } from "../../../src/guards/budget.js"
import { queryHarness, readRequests } from "./tool-harness.js"

/** The single row a profile answers with: rows, then seven cells per column, typed as Databricks types them. */
const profileRow = (rows: string, perColumn: string[][]) => ({
  statementId: "st-1",
  state: "SUCCEEDED",
  manifest: {
    columns: [
      { name: "oc_rows", typeName: "BIGINT", typeText: "BIGINT", position: 0 },
      ...perColumn.flatMap((_cells, index) => [
        { name: `oc_nulls_${index}`, typeName: "BIGINT", typeText: "BIGINT", position: 1 + index * 6 },
        { name: `oc_distinct_${index}`, typeName: "BIGINT", typeText: "BIGINT", position: 2 + index * 6 },
        { name: `oc_min_${index}`, typeName: "DOUBLE", typeText: "DOUBLE", position: 3 + index * 6 },
        { name: `oc_max_${index}`, typeName: "DOUBLE", typeText: "DOUBLE", position: 4 + index * 6 },
        { name: `oc_percentiles_${index}`, typeName: "ARRAY", typeText: "ARRAY<DOUBLE>", position: 5 + index * 6 },
        { name: `oc_top_${index}`, typeName: "ARRAY", typeText: "ARRAY<STRUCT<item: STRING, count: BIGINT>>", position: 6 + index * 6 },
      ]),
    ],
  },
  rows: [[rows, ...perColumn.flat()]],
})

describe("the SQL it builds", () => {
  it("is one aggregate over the table, with every allowlisted function and the honest aliases", () => {
    const sql = profileQuery({ table: "main.s.orders", columns: ["amount", "region"] })
    expect(sql).toContain("count(*) AS `oc_rows`")
    expect(sql).toContain("count_if(`amount` IS NULL) AS `oc_nulls_0`")
    expect(sql).toContain("approx_count_distinct(`amount`) AS `oc_distinct_0`")
    expect(sql).toContain("min(`amount`) AS `oc_min_0`")
    expect(sql).toContain("max(`amount`) AS `oc_max_0`")
    expect(sql).toContain("percentile_approx(`amount`, array(0.25, 0.5, 0.75), 10000) AS `oc_percentiles_0`")
    expect(sql).toContain("approx_top_k(`amount`, 5) AS `oc_top_0`")
    expect(sql).toContain("count_if(`region` IS NULL) AS `oc_nulls_1`")
    expect(sql).toContain("FROM `main`.`s`.`orders`")
    expect(sql.endsWith("FROM `main`.`s`.`orders`")).toBe(true)
  })

  it("takes a query as a subquery, and adds TABLESAMPLE for a sample", () => {
    const sql = profileQuery({ sql: "select * from main.s.orders", columns: ["a"], samplePercent: 10 })
    expect(sql).toContain("FROM (\nselect * from main.s.orders\n) AS oc_src TABLESAMPLE (10 PERCENT)")
    expect(profileQuery({ table: "main.s.t", columns: ["a"], samplePercent: 0.5 })).toContain("TABLESAMPLE (0.5 PERCENT)")
  })

  it("quotes a column name with a dot or a backtick as one identifier", () => {
    expect(profileQuery({ table: "main.s.t", columns: ["a.b"] })).toContain("min(`a.b`)")
    expect(profileQuery({ table: "main.s.t", columns: ["a`b"] })).toContain("min(`a``b`)")
  })

  it("passes the read path: its calls are all allowlisted built-ins, so it is sent wrapped and qualified", () => {
    const sql = profileQuery({ table: "main.s.orders", columns: ["amount"] })
    const analysis = analyzeRead(sql)
    expect(analysis.ok).toBe(true)
    expect(analysis.ok && analysis.sent.startsWith("SELECT * FROM (\nSELECT\n")).toBe(true)
    // count(*) stays unqualified: Spark's AstBuilder rewrites it by its bare name, so it is path-sensitive instead.
    expect(analysis.ok && analysis.sent).toContain("count(*) AS `oc_rows`")
    expect(analysis.ok && analysis.pathSensitive.some((form) => form.kind === "count-star")).toBe(true)
    expect(analysis.ok && analysis.sent).toContain("system.builtin.approx_top_k(`amount`, 5)")
  })
})

describe("the tool", () => {
  it("sends the profile wrapped, and maps the row into rows, nulls, distinct, min, max, percentiles and top", async () => {
    forgetStatementTimes()
    const perColumn = [["2", "8", "1.5", "99.5", "[1.0,2.0,3.0]", `[{"item":"eu","count":7},{"item":"us","count":3}]`]]
    const h = queryHarness({ submit: () => profileRow("10", perColumn) })
    const result = await runTool("profile", { table: "main.s.t", columns: ["amount"] }, h.call(), h.deps, HANDLERS)
    const expected = analyzeRead(profileQuery({ table: "main.s.t", columns: ["amount"] }))
    expect(readRequests(h.databricks)[0]?.statement).toBe(expected.ok ? expected.sent : "")
    expect(readRequests(h.databricks)[0]?.rowLimit).toBe(1)
    expect(result).toMatchObject({ state: "ok", trust: "untrusted", rows: 10, statementId: "st-1" })
    expect(result.columns).toEqual([
      {
        name: "amount",
        nulls: 2,
        distinct: 8,
        min: 1.5,
        max: 99.5,
        percentiles: [1, 2, 3],
        top: [
          { value: "eu", count: 7 },
          { value: "us", count: 3 },
        ],
      },
    ])
  })

  it("leaves `top` out when Databricks answers a shape the plugin does not recognise, instead of inventing counts", async () => {
    const perColumn = [["0", "1", "1", "1", "[1.0]", `not json`]]
    const h = queryHarness({ submit: () => profileRow("1", perColumn) })
    const result = await runTool("profile", { table: "main.s.t", columns: ["a"] }, h.call(), h.deps, HANDLERS)
    expect((result.columns as Record<string, unknown>[])[0]).not.toHaveProperty("top")
  })

  it("profiles a query as a subquery, through the read path", async () => {
    const h = queryHarness({ submit: () => profileRow("3", [["0", "3", "1", "2", "[1.0,1.5,2.0]", `[{"item":1,"count":2}]`]]) })
    const result = await runTool("profile", { sql: "select a from main.s.t", columns: ["a"] }, h.call(), h.deps, HANDLERS)
    expect(readRequests(h.databricks)[0]?.statement).toContain("FROM (\nselect a from main.s.t\n) AS oc_src")
    expect(result.rows).toBe(3)
  })

  it("says a sample's figures are estimates", async () => {
    const h = queryHarness({ submit: () => profileRow("4", [["0", "4", "1", "2", "[1.0]", `[]`]]) })
    const result = await runTool("profile", { table: "main.s.t", columns: ["a"], samplePercent: 10 }, h.call(), h.deps, HANDLERS)
    expect(result.message).toContain("10% sample")
  })

  it("needs a table or a sql, but not both", async () => {
    const h = queryHarness({})
    expect(await runTool("profile", { columns: ["a"] }, h.call(), h.deps, HANDLERS)).toMatchObject({ error: "INPUT_INVALID" })
    expect(await runTool("profile", { table: "main.s.t", sql: "select 1", columns: ["a"] }, h.call("call_2"), h.deps, HANDLERS)).toMatchObject({ error: "INPUT_INVALID" })
    expect(readRequests(h.databricks)).toEqual([])
  })
})
