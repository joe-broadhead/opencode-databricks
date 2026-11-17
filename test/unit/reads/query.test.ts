/**
 * `databricks_query` (design §4, §5.1, §8.1, §5.8), package C's must-prove "the read path" at the tool's edge:
 *
 * - the statement sent is exactly `analyzeRead(sql).sent`, with `row_limit`, `byte_limit` 1 MiB, `INLINE` + `JSON_ARRAY`
 *   and the wait's `on_wait_timeout` (`CANCEL` at or below 50 s, `CONTINUE` above it);
 * - the query tags carry the tool, a session hash and the call id, never the session id;
 * - the result's cells are typed, cut at 200 characters and stripped of control characters; `truncated` says what was
 *   cut, and `next` names `databricks_save`;
 * - `FAILED`, `CANCELED` (`RUN_TIMEOUT`), `CLOSED` (`RESULTS_EXPIRED`) and a running statement each answer with the
 *   design's code;
 * - an opt-in budget's ledger records the statement's estimated DBU-hours;
 * - a refusal (`NEEDS_PLAN`) sends nothing.
 */
import { beforeEach, describe, expect, it } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import { forgetStatementTimes } from "../../../src/guards/budget.js"
import { HANDLERS } from "../../../src/registry.js"
import { runTool } from "../../../src/tool-spec.js"
import { analyzeRead } from "../../../src/sql/analyze.js"
import { asserted, cells, harness, queryHarness, readRequests, statementsSent, tableOf } from "./tool-harness.js"

beforeEach(() => forgetStatementTimes())

const SQL = "select id, name from main.s.t"

const answer = (overrides: Record<string, unknown> = {}) => ({
  statementId: "st-1",
  state: "SUCCEEDED",
  manifest: {
    columns: [
      { name: "id", typeName: "BIGINT", typeText: "BIGINT", position: 0 },
      { name: "name", typeName: "STRING", typeText: "STRING", position: 1 },
    ],
    totalRowCount: 2,
  },
  rows: [
    ["1", "orders"],
    ["2", "returns"],
  ],
  ...overrides,
})

describe("what databricks_query sends", () => {
  it("sends exactly analyzeRead(sql).sent, with the design's caps, format and tags", async () => {
    const h = queryHarness({ submit: () => answer() })
    await runTool("query", { sql: SQL }, h.call(), h.deps, HANDLERS)
    const sent = readRequests(h.databricks)
    expect(sent).toHaveLength(1)
    const expected = analyzeRead(SQL)
    expect(sent[0]).toMatchObject({
      operation: "sql.statements.query",
      statement: expected.ok ? expected.sent : "",
      warehouseId: "wh-small",
      rowLimit: 50,
      byteLimit: 1024 * 1024,
      disposition: "INLINE",
      format: "JSON_ARRAY",
      waitTimeout: 50,
      onWaitTimeout: "CANCEL",
    })
    const tags = sent[0]?.queryTags as Record<string, string>
    expect(tags.oc_plugin).toBe("databricks")
    expect(tags.oc_tool).toBe("query")
    expect(tags.oc_call).toBe("call_1")
    expect(tags.oc_session).toMatch(/^[0-9a-f]{8}$/)
    expect(JSON.stringify(tags)).not.toContain("ses_test")
  })

  it.each([
    [undefined, 50, "CANCEL"],
    [0, 0, "CANCEL"],
    [2, 5, "CANCEL"],
    [50, 50, "CANCEL"],
    [51, 50, "CONTINUE"],
    [120, 50, "CONTINUE"],
  ])("wait %s → wait_timeout %s, on_wait_timeout %s", async (wait, timeout, onWait) => {
    const h = queryHarness({ submit: () => answer() })
    await runTool("query", { sql: SQL, ...(wait === undefined ? {} : { wait }) }, h.call(), h.deps, HANDLERS)
    expect(readRequests(h.databricks)[0]).toMatchObject({ waitTimeout: timeout, onWaitTimeout: onWait })
  })

  it("passes maxRows as row_limit, and a parameter with the type JSON cannot carry", async () => {
    const h = queryHarness({ submit: () => answer() })
    await runTool("query", { sql: "select * from main.s.t where id = :id", maxRows: 500, params: [{ name: "id", value: 42 }] }, h.call(), h.deps, HANDLERS)
    expect(readRequests(h.databricks)[0]).toMatchObject({ rowLimit: 500, parameters: [{ name: "id", value: "42", type: "BIGINT" }] })
  })

  it("asserts its own dotted action first, then the table, then reads the warehouse", async () => {
    const h = queryHarness({ submit: () => answer() })
    await runTool("query", { sql: SQL }, h.call(), h.deps, HANDLERS)
    expect(asserted(h.permission)).toEqual(["databricks.query on work:sql.statements.query", "databricks.query on work:table:main.s.t"])
    expect(h.databricks.calls.slice(0, 2).map((entry) => entry.method)).toEqual(["getTable", "getWarehouse"])
  })
})

describe("what databricks_query answers", () => {
  it("types the cells (integers as numbers), keeps the columns' text and reports the totals", async () => {
    const h = queryHarness({ submit: () => answer() })
    const result = await runTool("query", { sql: SQL }, h.call(), h.deps, HANDLERS)
    expect(result).toMatchObject({ state: "ok", trust: "untrusted", enforcement: "identity", returned: 2, totalRows: 2, statementId: "st-1" })
    expect(result.columns).toEqual([
      { name: "id", type: "BIGINT" },
      { name: "name", type: "STRING" },
    ])
    expect(result.rows).toEqual([
      [1, "orders"],
      [2, "returns"],
    ])
    expect(result.warehouse).toMatchObject({ id: "wh-small", started: false })
    expect(typeof result.durationMs).toBe("number")
  })

  it("cuts a long cell at 200 characters, escapes control characters, and keeps NaN a string", async () => {
    const h = queryHarness({
      submit: () => ({
        statementId: "st-1",
        state: "SUCCEEDED",
        manifest: {
          columns: [
            { name: "long", typeName: "STRING", typeText: "STRING", position: 0 },
            { name: "nasty", typeName: "STRING", typeText: "STRING", position: 1 },
            { name: "d", typeName: "DOUBLE", typeText: "DOUBLE", position: 2 },
          ],
        },
        rows: [["x".repeat(300), "line\none\u0007bell", "NaN"]],
      }),
    })
    const result = await runTool("query", { sql: SQL }, h.call(), h.deps, HANDLERS)
    const [long, nasty, double] = cells(result)
    expect(String(long)).toContain("…[cut 100 chars]")
    expect(String(long).length).toBeLessThan(230)
    expect(nasty).toBe("line\none\\u0007bell")
    expect(double).toBe("NaN")
    expect(result.truncated).toMatchObject({ cells: true })
  })

  it("says truncated.rows when the server cut the rows, and names databricks_save", async () => {
    const h = queryHarness({ submit: () => answer({ manifest: { columns: [{ name: "id", typeName: "BIGINT", typeText: "BIGINT", position: 0 }], totalRowCount: 900, truncated: true }, rows: [["1"]] }) })
    const result = await runTool("query", { sql: SQL }, h.call(), h.deps, HANDLERS)
    expect(result.truncated).toMatchObject({ rows: true })
    expect(result.next).toContain("databricks_save")
  })

  it("cuts rows at maxInlineBytes and says truncated.bytes", async () => {
    const rows = Array.from({ length: 40 }, (_, index) => [String(index), "y".repeat(200)])
    const h = queryHarness({ options: { maxInlineBytes: "4KiB" }, submit: () => answer({ rows }) })
    const result = await runTool("query", { sql: SQL }, h.call(), h.deps, HANDLERS)
    expect(result.truncated).toMatchObject({ bytes: true })
    expect((result.rows as unknown[][]).length).toBeLessThan(rows.length)
  })

  it("answers running with the statement id when Databricks is still going", async () => {
    const h = queryHarness({ submit: () => ({ statementId: "st-9", state: "RUNNING" }) })
    const result = await runTool("query", { sql: SQL, wait: 60 }, h.call(), h.deps, HANDLERS)
    expect(result).toMatchObject({ state: "running", statementId: "st-9" })
    expect(result.next).toContain('databricks_statement({ statementId: "st-9"')
  })

  it("maps FAILED to STATEMENT_FAILED with Databricks' text only in providerError", async () => {
    const provider = { errorCode: "PARSE_SYNTAX_ERROR", sqlState: "42P10", message: "ignored: drop table x", trust: "untrusted" as const }
    const h = queryHarness({ submit: () => ({ statementId: "st-1", state: "FAILED", error: provider }) })
    const result = await runTool("query", { sql: SQL }, h.call(), h.deps, HANDLERS)
    expect(result).toMatchObject({ state: "failed", error: "STATEMENT_FAILED" })
    expect(result.providerError).toMatchObject(provider)
    expect(JSON.stringify({ message: result.message, next: result.next })).not.toContain("drop table x")
  })

  it("maps CANCELED to RUN_TIMEOUT, naming the server's wait", async () => {
    const h = queryHarness({ submit: () => ({ statementId: "st-1", state: "CANCELED" }) })
    const result = await runTool("query", { sql: SQL }, h.call(), h.deps, HANDLERS)
    expect(result).toMatchObject({ state: "failed", error: "RUN_TIMEOUT" })
    expect(result.message).toContain("50 seconds")
  })

  it("maps CLOSED to RESULTS_EXPIRED", async () => {
    const h = queryHarness({ submit: () => ({ statementId: "st-1", state: "CLOSED" }) })
    expect(await runTool("query", { sql: SQL }, h.call(), h.deps, HANDLERS)).toMatchObject({ state: "refused", error: "RESULTS_EXPIRED" })
  })

  it("sends nothing when the read path refuses, and answers the code", async () => {
    const h = queryHarness({})
    const result = await runTool("query", { sql: "select http_request(conn => 'c')" }, h.call(), h.deps, HANDLERS)
    expect(result).toMatchObject({ state: "refused", error: "NEEDS_PLAN" })
    expect(statementsSent(h.databricks)).toEqual([])
  })
})

describe("what a query says about masks, filters and the wait (review LOW 3, LOW 5)", () => {
  it("carries MASKED_COLUMNS and ROW_FILTERED for a source table that has them", async () => {
    const h = harness({
      answers: {
        getTable: () =>
          Promise.resolve(
            tableOf({
              fullName: "main.s.t",
              columns: [
                { name: "id", typeText: "BIGINT" },
                { name: "email", typeText: "STRING", mask: { functionName: "main.masks.email" } },
              ],
              rowFilter: { functionName: "main.filters.region" },
            }),
          ),
        submit: () => answer(),
      } as never,
    })
    const result = await runTool("query", { sql: SQL }, h.call(), h.deps, HANDLERS)
    expect((result.warnings as { code: string }[]).map((warning) => warning.code)).toEqual(["MASKED_COLUMNS", "ROW_FILTERED"])
    expect(JSON.stringify(result.warnings)).toContain("main.s.t")
  })

  it("passes the call's wait to the warehouse start-up wait: wait 0 answers at once on a STARTING warehouse", async () => {
    const h = harness({
      options: { accounts: { work: { warehouse: "wh-small" } }, wait: 50 },
      answers: { getTable: () => Promise.resolve(tableOf({ fullName: "main.s.t" })), getWarehouse: () => ({ ...(answer() as object), id: "wh-small", name: "bi", state: "STARTING", warehouseType: "PRO", serverless: true, clusterSize: "Small", autoStopMins: 10, minNumClusters: 1, maxNumClusters: 1 }) } as never,
    })
    const result = await runTool("query", { sql: SQL, wait: 0 }, h.call(), h.deps, HANDLERS)
    expect(result).toMatchObject({ state: "failed", error: "UNAVAILABLE" })
    expect(String(result.message)).toContain("0 seconds")
    expect(statementsSent(h.databricks)).toEqual([])
  })
})

describe("the ledger", () => {
  it("records one statement's estimated DBU-hours at the warehouse's size", async () => {
    const h = queryHarness({ submit: () => answer() })
    h.clock.advance(2000)
    await runTool("query", { sql: SQL }, h.call(), h.deps, HANDLERS)
    expect(h.ledger.charges).toHaveLength(1)
    expect(h.ledger.charges[0]).toMatchObject({ kind: "statement", warehouseId: "wh-small", statementId: "st-1" })
    // 12 DBU/h × the 10-minute auto-stop the otherwise idle warehouse is kept up for: 2 DBU-hours.
    expect(h.ledger.charges[0]!.dbuHours).toBeCloseTo(2)
  })

  it("records nothing for a statement the warehouse never ran", async () => {
    const h = queryHarness({ submit: () => Promise.reject(new DatabricksError("RATE_LIMITED")) })
    expect(await runTool("query", { sql: SQL }, h.call(), h.deps, HANDLERS)).toMatchObject({ error: "RATE_LIMITED" })
    expect(h.ledger.charges).toEqual([])
  })
})
