/**
 * Design §15.1, the must-prove item for package C — **the read path**:
 *
 * - the wrapper is exactly `SELECT * FROM (\n<sql>\n) AS oc_q`, and a read sends nothing else;
 * - every refused construct is refused before any Databricks call (`analyzeRead`'s steps 1 and 2), including the review's
 *   `--` comment bypass, a nested comment, U+2028, `IDENTIFIER(…)`, a script transform and a second statement;
 * - the injection-shaped inputs a reviewer should try: the `python_exec` decoy by one, two and three parts,
 *   `system.ai.*`, `system.session.*`, a backquoted or Unicode-confusable name, a comment inside a dotted name, a
 *   Unicode-escaped name, a CTE, `EXECUTE IMMEDIATE`, `SET`/`SET PATH`, and a table function in `FROM`, `TABLE(…)` and
 *   `LATERAL VIEW`;
 * - dependencies (step 3), the fence and inline rules (step 4) and the warehouse policy (step 5) each refuse before the
 *   statement, and the tables are asserted (step 6) before the warehouse is touched.
 */
import { describe, expect, it } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import { prepareRead } from "../../../src/guards/read.js"
import type { ReadRequest } from "../../../src/ports.js"
import { analyzeRead } from "../../../src/sql/analyze.js"
import { answerOf, asserted, harness, runningWarehouse, statementsSent, tableOf } from "../reads/harness.js"

const SIGNAL = new AbortController().signal

const request = (sql: string, extra: Partial<ReadRequest> = {}): ReadRequest => ({ account: "work", sql, tool: "query", sessionID: "ses_test", messageID: "msg_test", callID: "call_1", ...extra })

/** The code a refusal carries, or `OK`. Every test also checks that nothing was sent. */
async function outcome(sql: string, extra: Partial<ReadRequest> = {}, answers = {}) {
  const h = harness({ answers })
  try {
    const prepared = await prepareRead(h.deps, request(sql, extra), SIGNAL)
    return { code: "OK", sent: prepared.sent, tables: prepared.tables, h }
  } catch (error) {
    if (error instanceof DatabricksError) return { code: error.code, detail: error.detail, h }
    throw error
  }
}

describe("the wrapper: a read sends exactly analyzeRead(sql).sent", () => {
  it("is SELECT * FROM (\\n<sql>\\n) AS oc_q, one trailing ; removed, built-ins qualified", async () => {
    const result = await outcome("SELECT upper(a) FROM main.s.t;", {}, { getTable: () => tableOf({ fullName: "main.s.t" }) })
    expect(result.code).toBe("OK")
    expect(result.sent).toBe("SELECT * FROM (\nSELECT system.builtin.upper(a) FROM main.s.t\n) AS oc_q")
    const expected = analyzeRead("SELECT upper(a) FROM main.s.t;")
    expect(result.sent).toBe(expected.ok ? expected.sent : "")
  })

  it("carries a CTE's body unchanged: a one-part name that is a CTE is not a Unity Catalog table", async () => {
    const result = await outcome("with q as (select 1 a) select * from q", {}, { getTable: () => Promise.reject(new DatabricksError("NOT_FOUND")) })
    expect(result.code).toBe("OK")
    expect(result.sent).toBe("SELECT * FROM (\nwith q as (select 1 a) select * from q\n) AS oc_q")
  })

  it("passes named parameters through as :name markers, never text", async () => {
    const result = await outcome("select :p as x", {}, {})
    expect(result.code).toBe("OK")
    expect(result.sent).toContain(":p")
  })
})

describe("§15.1: every refused construct is refused before any Databricks call", () => {
  it.each([
    // The decoy, by one, two and three parts.
    ["select python_exec('x')", "FUNCTION_NAME_PARTIAL"],
    ["select sch.python_exec('x')", "FUNCTION_NAME_PARTIAL"],
    ["select myfn(a) from main.s.t", "FUNCTION_NAME_PARTIAL"],
    ["select builtin.upper(a)", "FUNCTION_NAME_PARTIAL"],
    ["select * from main.s.t pivot (myagg(a) for b in (1, 2))", "FUNCTION_NAME_PARTIAL"],
    ["select transform(arr, x -> python_exec(x)) from main.s.t", "FUNCTION_NAME_PARTIAL"],
    // system.ai, system.session, and the same names written so a reader has to look twice.
    ["select system.ai.python_exec('x')", "NEEDS_PLAN"],
    ["select SYSTEM.AI.PYTHON_EXEC('x')", "NEEDS_PLAN"],
    ["select `system`.`ai`.`python_exec`('x')", "NEEDS_PLAN"],
    ["select system/*x*/.ai.python_exec('x')", "NEEDS_PLAN"],
    ["select system.ai.python_exec('x') -- \u2028", "STATEMENT_NOT_READ"],
    ["select system.session.f(1)", "FUNCTION_REFUSED"],
    ["select session.f(1)", "FUNCTION_REFUSED"],
    ["select `session`.f(1)", "FUNCTION_REFUSED"],
    ["select system.builtin.secret('s', 'k')", "SECRET_FUNCTION_REFUSED"],
    ["select builtin.secret('s', 'k')", "SECRET_FUNCTION_REFUSED"],
    ["select secret('s', 'k')", "SECRET_FUNCTION_REFUSED"],
    ["select reflect('java.lang.Runtime', 'x')", "FUNCTION_REFUSED"],
    ["select java_method('c', 'm')", "FUNCTION_REFUSED"],
    // Dynamic names.
    ["select * from identifier(:t)", "IDENTIFIER_REFUSED"],
    ["select identifier('upper')('a')", "IDENTIFIER_REFUSED"],
    ["select * from IDENTIFIER /*x*/ ('t')", "IDENTIFIER_REFUSED"],
    // More than one statement, and the constructs where parsers can disagree where a token ends.
    ["select 1; select 2", "STATEMENT_NOT_READ"],
    ["select ';'", "STATEMENT_NOT_READ"],
    ["select 1 -- ;\n", "STATEMENT_NOT_READ"],
    ["select 1 /* a /* b */ */", "STATEMENT_NOT_READ"],
    ["select 1 -- x\\\n, secret('s', 'k')", "STATEMENT_NOT_READ"],
    ["select 1 -- x\\", "STATEMENT_NOT_READ"],
    ["select 1 -- a\u0085, 2", "STATEMENT_NOT_READ"],
    ["select 1 \u2028", "STATEMENT_NOT_READ"],
    ["select ?", "SQL_INVALID"],
    // Statements, not queries.
    ["insert into main.s.t select 1", "STATEMENT_NOT_READ"],
    ["update main.s.t set a = 1", "STATEMENT_NOT_READ"],
    ["delete from main.s.t", "STATEMENT_NOT_READ"],
    ["drop table main.s.t", "STATEMENT_NOT_READ"],
    ["create table main.s.t (a int)", "STATEMENT_NOT_READ"],
    ["grant select on main.s.t to `u`", "STATEMENT_NOT_READ"],
    ["EXECUTE IMMEDIATE 'drop table main.s.t'", "STATEMENT_NOT_READ"],
    ["EXECUTE IMMEDIATE 'select 1'", "STATEMENT_NOT_READ"],
    ["CALL main.s.p()", "STATEMENT_NOT_READ"],
    ["EXPLAIN select 1", "STATEMENT_NOT_READ"],
    ["SHOW TABLES", "STATEMENT_NOT_READ"],
    ["BEGIN SELECT 1; END", "STATEMENT_NOT_READ"],
    // Session state: the API keeps none, and SET PATH could redirect a name.
    ["SET PATH = main.evil, system.builtin", "SESSION_STATEMENT_REFUSED"],
    ["SET spark.sql.ansi.enabled = false", "SESSION_STATEMENT_REFUSED"],
    ["SET VAR x = 1", "SESSION_STATEMENT_REFUSED"],
    ["RESET", "SESSION_STATEMENT_REFUSED"],
    ["USE main.evil", "SESSION_STATEMENT_REFUSED"],
    ["DECLARE x INT", "SESSION_STATEMENT_REFUSED"],
    ["CREATE TEMPORARY VIEW v USING parquet OPTIONS (path 'x')", "SESSION_STATEMENT_REFUSED"],
    // Scripts and table functions, in every position a read can name one.
    ["SELECT TRANSFORM(a) USING 'cat' FROM main.s.t", "FUNCTION_REFUSED"],
    ["MAP a USING 'cat' AS b FROM main.s.t", "FUNCTION_REFUSED"],
    ["SELECT * FROM read_files('s3://bucket/x')", "NEEDS_PLAN"],
    ["SELECT * FROM read_kafka(bootstrapServers => 'h:9092')", "NEEDS_PLAN"],
    ["SELECT * FROM cloud_files_state('x')", "NEEDS_PLAN"],
    ["SELECT * FROM cat.sch.py_udtf(1)", "NEEDS_PLAN"],
    ["SELECT * FROM main.s.t LATERAL VIEW cat.sch.py_udtf(c) v", "NEEDS_PLAN"],
    ["SELECT * FROM main.s.t LATERAL VIEW myudtf(c) v AS x", "NEEDS_PLAN"],
    ["SELECT * FROM cat.sch.sql_udtf(TABLE(main.s.t))", "NEEDS_PLAN"],
    ["SELECT * FROM STREAM read_kafka(bootstrapServers => 'h')", "NEEDS_PLAN"],
    // Text the pinned grammar cannot parse fails closed.
    ["selec 1", "SQL_UNSUPPORTED"],
    ["SELECT * FROM TABLE(range(3))", "SQL_UNSUPPORTED"],
  ])("%s → %s, with no Databricks call", async (sql, expected) => {
    const result = await outcome(sql)
    expect(result.code).toBe(expected)
    expect(result.h.databricks.calls, sql).toEqual([])
    expect(result.h.permission.requests.filter((entry) => entry.action === "databricks.start")).toEqual([])
  })
})

describe("§15.1: what passes is sent wrapped, and nothing else is sent", () => {
  it.each([
    ["select * from range(10)", {}],
    ["select * from main.s.t lateral view explode(arr) v as c", {}],
    ["SELECT * FROM main.s.t PIVOT (sum(a) FOR b IN (1, 2))", {}],
    ["select row_number() over (order by a) from main.s.t", {}],
    ["select /*+ REPARTITION(3) */ a from main.s.t", {}],
    ["select cast(a as int), extract(year from d) from main.s.t", {}],
  ])("%s → the wrapped text, unchanged but for qualification", async (sql) => {
    const result = await outcome(sql, {}, { getTable: () => tableOf({ fullName: "main.s.t" }), submit: () => answerOf({ manifest: { columns: [{ name: "path", typeName: "STRING", typeText: "STRING", position: 0 }] }, rows: [["system.session,system.builtin,system.ai,main.default"]] }) })
    // The path-sensitive forms ask for `current_path()` first, which the harness answers with the default path.
    expect(result.code).toBe("OK")
    const expected = analyzeRead(sql)
    expect(result.sent).toBe(expected.ok ? expected.sent : "")
  })

  it("resolves every table reference and asserts each one, under the calling tool's action", async () => {
    const h = harness({ answers: { getTable: () => tableOf({ fullName: "main.s.t" }) } })
    const prepared = await prepareRead(h.deps, request("select * from main.s.t", { tool: "profile" }), SIGNAL)
    expect(prepared.tables).toEqual(["main.s.t"])
    expect(asserted(h.permission)).toEqual(["databricks.profile on work:table:main.s.t"])
  })

  it("stops before the warehouse when a person's rule denies a table", async () => {
    const h = harness({ permission: new (await import("../../../test/fake/ports.js")).RecordingPermission((entry) => (entry.resource.includes(":table:") ? "deny" : "allow")), answers: { getTable: () => tableOf({ fullName: "main.hr.salaries" }) } })
    await expect(prepareRead(h.deps, request("select * from main.hr.salaries"), SIGNAL)).rejects.toThrow(/denied: databricks.query on work:table:main.hr.salaries/)
    expect(h.databricks.calls.map((entry) => entry.method)).toEqual(["getTable"])
  })

  it("pages and rows come only from the statement: the guard never sends one", async () => {
    const h = harness({ answers: { getTable: () => tableOf({ fullName: "main.s.t" }), submit: () => answerOf() } })
    await prepareRead(h.deps, request("select * from main.s.t"), SIGNAL)
    expect(statementsSent(h.databricks)).toEqual([])
    expect(h.databricks.calls.map((entry) => entry.method)).toEqual(["getTable", "getWarehouse"])
  })

  it("a warehouse above maxRunSize is refused even while it runs", async () => {
    const h = harness({ options: { maxRunSize: "X-Small" }, answers: { getTable: () => tableOf({ fullName: "main.s.t" }), getWarehouse: () => runningWarehouse({ clusterSize: "Large" }) } })
    await expect(prepareRead(h.deps, request("select * from main.s.t"), SIGNAL)).rejects.toThrow(/above maxRunSize X-Small/)
    expect(statementsSent(h.databricks)).toEqual([])
  })
})
