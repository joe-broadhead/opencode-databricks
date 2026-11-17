/**
 * **The local side of L4, L6 and L14** (design §15.4, review `databricks-4.md`, LOW 2). These are live checks by
 * definition — Databricks' own parse of a wrapped change, network reach from a serverless Python UDF, masks as a role
 * sees them — so this suite proves only what a unit test without a workspace can: the plugin's half. The live items stay
 * open in the release notes.
 *
 * **L4 — the wrapper (local side).** Every mutating statement form of §5.5 fails before the wrapper: the read path refuses it, and the
 * pinned grammar refuses it inside the wrapper too (`SELECT * FROM (DELETE …) AS oc_q`). An `ORDER BY` and duplicate
 * column names survive, because the wrapper is a subquery: the text is sent unchanged apart from qualification. A `;`
 * separates statements and is refused on the read path as well as by the API [35]. **Not provable here:** that a
 * particular warehouse's parser refuses each form (the live check).
 *
 * **L6 — a Python UDF cannot reach the network on serverless (local side).** v0.1.0 does not rely on it: a Python or Scala function,
 * with or without a connection dependency, is `NEEDS_PLAN`, so a read never runs one (design §5.4: "such UDFs need a plan
 * until it passes"). **Not provable here:** the network behaviour itself.
 *
 * **L14 — masks, filters, parameters and definition visibility (local side).** A masked column and a row filter are shown by name, and
 * a sample's values are whatever Databricks returned to this identity: the plugin never widens or re-filters. A view
 * whose `view_definition` is not returned warns (`VIEW_BODY_UNREAD`) and, under a fence, is refused; a function whose
 * `routine_definition` is not returned is `NEEDS_PLAN`. **Not provable here:** whether a reader with only `SELECT` or
 * `EXECUTE` really is denied those bodies — the live check measures how often the strict rule fires.
 */
import { describe, expect, it } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import { prepareRead } from "../../../src/guards/read.js"
import { HANDLERS } from "../../../src/registry.js"
import { runTool } from "../../../src/tool-spec.js"
import { analyzeRead } from "../../../src/sql/analyze.js"
import type { ReadRequest } from "../../../src/ports.js"
import { asserted, harness, readRequests, statementsSent, tableOf } from "./tool-harness.js"

const SIGNAL = new AbortController().signal
const request = (sql: string): ReadRequest => ({ account: "work", sql, tool: "query", sessionID: "ses_test", messageID: "msg_test", callID: "call_1" })

describe("L4, local side: the wrapper", () => {
  const MUTATING = [
    "insert into main.s.t select 1",
    "insert overwrite main.s.t select 1",
    "insert overwrite directory '/tmp/x' select 1",
    "update main.s.t set a = 1",
    "delete from main.s.t",
    "merge into main.s.t using main.s.u on main.s.t.a = main.s.u.a when matched then delete",
    "truncate table main.s.t",
    "drop table main.s.t",
    "create table main.s.t (a int)",
    "create or replace table main.s.t as select 1",
    "alter table main.s.t add column b int",
    "alter table main.s.t set location 's3://x'",
    "grant select on main.s.t to `u`",
    "revoke select on main.s.t from `u`",
    "optimize main.s.t",
    "vacuum main.s.t",
    "restore table main.s.t to version as of 1",
    "analyze table main.s.t compute statistics",
    "refresh table main.s.t",
    "comment on table main.s.t is 'x'",
    "copy into main.s.t from 's3://x'",
    "SET PATH = main.evil",
    "USE main.evil",
    "EXECUTE IMMEDIATE 'drop table main.s.t'",
    "CALL main.s.p()",
    "BEGIN SELECT 1; END",
    "PUT 'x' INTO '/tmp/y'",
  ]

  it.each(MUTATING)("%s is refused before any Databricks call", async (sql) => {
    const h = harness({})
    const result = await runTool("query", { sql }, h.call(), h.deps, HANDLERS)
    expect(result.state).toBe("refused")
    expect(h.databricks.calls).toEqual([])
  })

  it.each(["delete from main.s.t", "insert into main.s.t select 1", "drop table main.s.t", "grant select on main.s.t to `u`", "EXECUTE IMMEDIATE 'drop table main.s.t'", "CALL main.s.p()", "SET PATH = main.evil"])(
    "SELECT * FROM (%s) AS oc_q is not a query the wrapper can carry",
    (inner) => {
      const wrapped = `SELECT * FROM (${inner}) AS oc_q`
      const analysis = analyzeRead(wrapped)
      expect(analysis.ok).toBe(false)
      expect(analysis.ok ? "OK" : analysis.refusal.code).not.toBe("OK")
    },
  )

  it("keeps ORDER BY inside the wrapper, so the order survives", async () => {
    const h = harness({ answers: { getTable: () => Promise.resolve(tableOf({ fullName: "main.s.t" })) } as never })
    const prepared = await prepareRead(h.deps, request("select id from main.s.t order by id desc"), SIGNAL)
    expect(prepared.sent).toBe("SELECT * FROM (\nselect id from main.s.t order by id desc\n) AS oc_q")
    expect(prepared.sent.indexOf("order by id desc")).toBeLessThan(prepared.sent.indexOf(") AS oc_q"))
  })

  it("keeps duplicate output column names: the wrapper adds no column list", async () => {
    const h = harness({ answers: { getTable: () => Promise.resolve(tableOf({ fullName: "main.s.t" })) } as never })
    const prepared = await prepareRead(h.deps, request("select id as dup, name as dup from main.s.t"), SIGNAL)
    expect(prepared.sent).toContain("id as dup, name as dup")
    expect(prepared.sent).not.toMatch(/AS oc_q\s*\(/u)
  })

  it("refuses a second statement on the read path, before the API can refuse it", async () => {
    const h = harness({})
    expect(await runTool("query", { sql: "select 1; select 2" }, h.call(), h.deps, HANDLERS)).toMatchObject({ state: "refused", error: "STATEMENT_NOT_READ" })
    expect(statementsSent(h.databricks)).toEqual([])
  })
})

describe("L6, local side: a Python UDF needs a plan, so no read depends on the live check", () => {
  it.each([
    ["without a connection", { routineBody: "EXTERNAL", externalLanguage: "PYTHON", isTableFunction: false }],
    ["with a connection", { routineBody: "EXTERNAL", externalLanguage: "PYTHON", isTableFunction: false, routineDependencies: [{ kind: "connection", name: "pg" }] }],
  ])("%s it answers NEEDS_PLAN at the tool, and sends nothing", async (_what, routine) => {
    const h = harness({
      answers: {
        getTable: () => Promise.resolve(tableOf({ fullName: "main.s.t" })),
        getFunction: () => Promise.resolve({ fullName: "main.s.pya", ...routine }),
      } as never,
    })
    const result = await runTool("query", { sql: "select main.s.pya(a) from main.s.t" }, h.call(), h.deps, HANDLERS)
    expect(result).toMatchObject({ state: "refused", error: "NEEDS_PLAN" })
    expect(statementsSent(h.databricks)).toEqual([])
  })
})

describe("L14, local side: masks, filters and definition visibility", () => {
  const masked = {
    getTable: () =>
      Promise.resolve(
        tableOf({
          fullName: "main.hr.people",
          columns: [
            { name: "id", typeText: "BIGINT" },
            { name: "email", typeText: "STRING", mask: { functionName: "main.masks.email" } },
          ],
          rowFilter: { functionName: "main.filters.region" },
          viewDefinition: "SELECT id, email FROM main.hr.people_raw",
          viewDependencies: [{ kind: "table", name: "main.hr.people_raw" }],
        }),
      ),
  }

  it("shows the mask and the filter by name, and never claims to see through them", async () => {
    const h = harness({ answers: masked as never })
    const result = await runTool("table", { name: "main.hr.people" }, h.call(), h.deps, HANDLERS)
    expect(result).toMatchObject({ rowFilter: "main.filters.region" })
    expect((result.columns as Record<string, unknown>[])[1]).toMatchObject({ name: "email", mask: "main.masks.email" })
    const codes = (result.warnings as { code: string }[]).map((warning) => warning.code)
    expect(codes).toEqual(["MASKED_COLUMNS", "ROW_FILTERED"])
  })

  it("returns a sample's values as Databricks returned them: the plugin sends the table name and nothing else", async () => {
    const h = harness({
      answers: {
        ...masked,
        getTable: (_account: unknown, fullName: unknown) => Promise.resolve(tableOf({ fullName: String(fullName) })),
        submit: (requested: unknown) => {
          const statement = String((requested as { statement: string }).statement)
          if (statement.includes("current_path")) return { statementId: "st-path", state: "SUCCEEDED", manifest: { columns: [{ name: "p", typeName: "STRING", typeText: "STRING", position: 0 }] }, rows: [["system.builtin,system.ai,main.default"]] }
          return { statementId: "st-1", state: "SUCCEEDED", manifest: { columns: [{ name: "email", typeName: "STRING", typeText: "STRING", position: 0 }] }, rows: [["m***@example.invalid"]] }
        },
      } as never,
    })
    const result = await runTool("table", { name: "main.hr.people", sample: 1 }, h.call(), h.deps, HANDLERS)
    expect(readRequests(h.databricks)[0]?.statement).toBe("SELECT * FROM (\nSELECT * FROM `main`.`hr`.`people` LIMIT 1\n) AS oc_q")
    expect(result.sample).toEqual({ columns: ["email"], rows: [["m***@example.invalid"]] })
  })

  it("warns VIEW_BODY_UNREAD when a view's definition is not returned, and refuses it under a fence", async () => {
    const noBody = { getTable: () => Promise.resolve(tableOf({ fullName: "main.s.v", tableType: "VIEW", viewDependencies: [] })) }
    const warned = harness({ answers: noBody as never })
    expect((await runTool("query", { sql: "select * from main.s.v" }, warned.call(), warned.deps, HANDLERS)).warnings).toEqual([expect.objectContaining({ code: "VIEW_BODY_UNREAD" })])
    const fenced = harness({ options: { accounts: { work: { warehouse: "wh-small", fence: { allow: ["main.s.*"] } } } }, answers: noBody as never })
    expect(await runTool("query", { sql: "select * from main.s.v" }, fenced.call(), fenced.deps, HANDLERS)).toMatchObject({ error: "DEPENDENCIES_UNKNOWN" })
  })

  it("is NEEDS_PLAN when a function's body is not returned to this identity", async () => {
    const h = harness({
      answers: {
        getTable: () => Promise.resolve(tableOf({ fullName: "main.s.t" })),
        getFunction: () => Promise.resolve({ fullName: "main.s.hidden", routineBody: "SQL", isTableFunction: false }),
      } as never,
    })
    expect(await runTool("query", { sql: "select main.s.hidden(a) from main.s.t" }, h.call(), h.deps, HANDLERS)).toMatchObject({ error: "NEEDS_PLAN" })
    expect(statementsSent(h.databricks)).toEqual([])
  })

  it("says the enforcement a read runs under: a requested role is role-requested until doctor proves it", async () => {
    const h = harness({
      answers: { ...masked, getTable: () => Promise.resolve(tableOf({ fullName: "main.s.t" })) } as never,
      auth: new (await import("../../fake/ports.js")).FakeAuth([{ alias: "work", mode: "interactive", host: "https://fake-workspace.cloud.databricks.com", cloud: "aws", features: [], warehouse: "wh-small", role: { groupId: "grp-1", name: "readers" } }]),
    })
    expect(await runTool("query", { sql: "select * from main.s.t" }, h.call(), h.deps, HANDLERS)).toMatchObject({ enforcement: "role-requested" })
    const service = harness({
      answers: { getTable: () => Promise.resolve(tableOf({ fullName: "main.s.t" })) } as never,
      auth: new (await import("../../fake/ports.js")).FakeAuth([{ alias: "work", mode: "m2m", host: "https://fake-workspace.cloud.databricks.com", cloud: "aws", features: [], warehouse: "wh-small" }]),
    })
    expect(await runTool("query", { sql: "select * from main.s.t" }, service.call(), service.deps, HANDLERS)).toMatchObject({ enforcement: "service-principal" })
  })

  it("asserts what a masked table's read touches, so a person's rules can refuse it", async () => {
    const h = harness({ answers: { getTable: () => Promise.resolve(tableOf({ fullName: "main.hr.people" })) } as never })
    await runTool("query", { sql: "select * from main.hr.people" }, h.call(), h.deps, HANDLERS)
    expect(asserted(h.permission)).toContain("databricks.query on work:table:main.hr.people")
    expect((await runTool("query", { sql: "select * from main.hr.people" }, h.call("call_2"), h.deps, HANDLERS)).error).toBeUndefined()
  })

  it("lets a refusal from Unity Catalog through rather than widening it", async () => {
    const h = harness({ answers: { getTable: () => Promise.reject(new DatabricksError("PERMISSION_DENIED")) } as never })
    expect(await runTool("query", { sql: "select * from main.hr.people" }, h.call(), h.deps, HANDLERS)).toMatchObject({ state: "refused", error: "PERMISSION_DENIED" })
  })
})
