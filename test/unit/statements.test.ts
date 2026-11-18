// The statement table (design §5.5): every form the pinned grammar parses has a rule; categories; token raises.
import { describe, expect, it } from "vitest"
import * as generated from "../../src/sql/generated/SqlBaseParser.js"
import { CATEGORY_RANK, classifyPlan, raise, STATEMENT_RULES, tokenRaises } from "../../src/domain/statements.js"
import type { Category } from "../../src/domain/actions.js"
import { ERRORS } from "../../src/domain/errors.js"
import { parseStatement } from "../../src/sql/parse.js"
import { type ChangeTarget, walk } from "../../src/sql/analyze.js"

const plan = (sql: string) => {
  const result = classifyPlan(sql)
  return result.ok ? result.category : result.code
}

describe("the statement table", () => {
  it("has a rule for every statement and setResetStatement alternative of the generated parser, and nothing else", () => {
    const parentOf = (name: string) => Object.getPrototypeOf((generated as Record<string, unknown>)[name] as object)?.name as string | undefined
    const alternatives = Object.keys(generated).filter((name) => name.endsWith("Context") && (parentOf(name) === "StatementContext" || parentOf(name) === "SetResetStatementContext"))
    expect(alternatives.length).toBeGreaterThan(90)
    expect(alternatives.filter((name) => !(name in STATEMENT_RULES))).toEqual([])
    expect(Object.keys(STATEMENT_RULES).filter((name) => !alternatives.includes(name))).toEqual([])
  })

  it.each([
    ["INSERT INTO main.s.t SELECT 1", "write"],
    ["INSERT OVERWRITE main.s.t SELECT 1", "delete"],
    ["INSERT INTO main.s.t REPLACE WHERE a = 1 SELECT 1", "delete"],
    ["INSERT OVERWRITE DIRECTORY 's3://b/x' USING parquet SELECT 1", "export"],
    ["UPDATE main.s.t SET a = 1", "write"],
    ["DELETE FROM main.s.t WHERE a = 1", "delete"],
    ["MERGE INTO main.s.t USING main.s.u ON t.id = u.id WHEN MATCHED THEN UPDATE SET *", "write"],
    ["MERGE INTO main.s.t USING main.s.u ON t.id = u.id WHEN MATCHED THEN DELETE", "delete"],
    ["MERGE INTO main.s.t USING main.s.u ON t.id = u.id WHEN NOT MATCHED BY SOURCE THEN DELETE", "delete"],
    ["CREATE TABLE main.s.t (a INT)", "write"],
    ["CREATE OR REPLACE TABLE main.s.t AS SELECT 1", "delete"],
    ["REPLACE TABLE main.s.t AS SELECT 1", "delete"],
    ["CREATE TABLE main.s.t LOCATION 's3://b/x' AS SELECT 1", "export"],
    ["CREATE VIEW main.s.v AS SELECT 1", "write"],
    ["CREATE OR REPLACE VIEW main.s.v AS SELECT 1", "delete"],
    ["CREATE FUNCTION main.s.f() RETURNS INT RETURN 1", "write"],
    ["CREATE MATERIALIZED VIEW main.s.mv AS SELECT 1", "write"],
    ["CREATE SCHEMA main.s2", "write"],
    ["ALTER TABLE main.s.t ADD COLUMN b INT", "write"],
    ["ALTER TABLE main.s.t DROP COLUMN b", "delete"],
    ["ALTER TABLE main.s.t SET TBLPROPERTIES ('delta.logRetentionDuration' = '1 day')", "delete"],
    ["ALTER TABLE main.s.t SET TBLPROPERTIES ('comment' = 'x')", "write"],
    ["ALTER TABLE main.s.t SET LOCATION 's3://b/x'", "admin"],
    ["COMMENT ON TABLE main.s.t IS 'x'", "write"],
    ["ANALYZE TABLE main.s.t COMPUTE STATISTICS", "write"],
    ["REFRESH TABLE main.s.t", "write"],
    ["MSCK REPAIR TABLE main.s.t", "write"],
    ["TRUNCATE TABLE main.s.t", "delete"],
    ["DROP TABLE main.s.t", "delete"],
    ["DROP VIEW main.s.v", "delete"],
    ["DROP SCHEMA main.s2 CASCADE", "delete"],
    ["GRANT SELECT ON TABLE main.s.t TO `a@example.com`", "share"],
    ["REVOKE SELECT ON TABLE main.s.t FROM `a@example.com`", "share"],
    ["EXECUTE IMMEDIATE 'DROP TABLE main.s.t'", "run"],
    ["CALL main.s.p()", "run"],
    ["BEGIN SELECT 1; END", "run"],
    ["SELECT 1; SELECT 2", "run"],
    ["VACUUM main.s.t", "run"],
    ["OPTIMIZE main.s.t ZORDER BY (a)", "run"],
    ["RESTORE TABLE main.s.t TO VERSION AS OF 1", "run"],
    ["COPY INTO main.s.t FROM 's3://b/x' FILEFORMAT = CSV", "run"],
    // Review of #7, ruling 4: the pinned grammar parses CREATE STREAMING TABLE (CreatePipelineDatasetContext), so it is
    // write; CREATE OR REFRESH STREAMING TABLE is not parsed, so run. SET TAG ON … reads as a session SET, so it is
    // refused; ALTER … SET TAGS and UNSET TAG ON … are not parsed, so run.
    ["CREATE STREAMING TABLE main.s.st AS SELECT 1", "write"],
    ["CREATE OR REFRESH STREAMING TABLE main.s.st AS SELECT * FROM STREAM main.s.t", "run"],
    ["SET TAG ON TABLE main.s.t pii = 'yes'", "SESSION_STATEMENT_REFUSED"],
    ["ALTER TABLE main.s.t SET TAGS ('pii' = 'yes')", "run"],
    ["UNSET TAG ON TABLE main.s.t pii", "run"],
    ["REORG TABLE main.s.t APPLY (PURGE)", "run"],
    ["SELECT http_request(conn => 'c', method => 'POST', path => '/')", "write"],
    ["SELECT * FROM read_files('s3://b/x')", "write"],
    ["SELECT cat.sch.f(1)", "run"],
    ["SELECT f(1)", "run"],
    ["CREATE VIEW main.s.v AS SELECT * FROM IDENTIFIER('main.s.t')", "run"],
    ["SELECT 1", "CATEGORY_MISMATCH"],
    ["SHOW TABLES", "CATEGORY_MISMATCH"],
    ["DESCRIBE TABLE main.s.t", "CATEGORY_MISMATCH"],
    ["EXPLAIN DELETE FROM main.s.t", "CATEGORY_MISMATCH"],
    ["SET PATH = main.evil", "SESSION_STATEMENT_REFUSED"],
    ["SET spark.sql.ansi.enabled = false", "SESSION_STATEMENT_REFUSED"],
    ["USE main.s", "SESSION_STATEMENT_REFUSED"],
    ["DECLARE x INT", "SESSION_STATEMENT_REFUSED"],
    ["CREATE TEMPORARY FUNCTION f() RETURNS INT RETURN 1", "SESSION_STATEMENT_REFUSED"],
    ["CREATE TEMPORARY VIEW v AS SELECT 1", "SESSION_STATEMENT_REFUSED"],
    ["ADD JAR 's3://b/x.jar'", "SESSION_STATEMENT_REFUSED"],
    ["SELECT secret('s', 'k')", "SECRET_FUNCTION_REFUSED"],
    ["SELECT 1 -- \\\n", "STATEMENT_NOT_READ"],
  ])("%s → %s", (sql, expected) => {
    expect(plan(sql)).toBe(expected)
  })

  it("tells SET TAG to write ALTER … SET TAGS instead (review of #7, ruling 4b)", () => {
    expect(ERRORS.SESSION_STATEMENT_REFUSED.next).toContain("for SET TAG, write ALTER … SET TAGS, which plans as run")
  })

  it("marks text it cannot parse, and scripts, as not parsed", () => {
    const vacuum = classifyPlan("VACUUM main.s.t")
    expect(vacuum.ok && [vacuum.parsed, vacuum.kind]).toEqual([false, "unparsed"])
    const script = classifyPlan("BEGIN DELETE FROM main.s.t; END")
    expect(script.ok && [script.parsed, script.kind, script.notes[0]]).toEqual([false, "script", "A script: its statements are not known until it runs."])
  })
})

describe("token rules only raise (design §5.5 step 2)", () => {
  it("find EXECUTE IMMEDIATE, CALL and IDENTIFIER anywhere outside comments", () => {
    expect(tokenRaises("insert into t select * from identifier('u')")).toEqual(["IDENTIFIER"])
    expect(tokenRaises("insert into t select 1 -- CALL x()\n")).toEqual([])
    expect(tokenRaises("create view v as select 1 /* EXECUTE IMMEDIATE */")).toEqual([])
  })

  it("never lower a category", () => {
    const categories = Object.keys(CATEGORY_RANK) as Category[]
    for (const from of categories) for (const to of categories) expect(CATEGORY_RANK[raise(from, to)]).toBeGreaterThanOrEqual(CATEGORY_RANK[from])
    expect(plan("DROP TABLE IDENTIFIER('main.s.t')")).toBe("run")
  })
})

describe("walk(tree).targets: the statement's own targets (review of #7, contract request 5)", () => {
  const walked = (sql: string) => {
    const parsed = parseStatement(sql)
    if (!parsed.ok || !parsed.tree) throw new Error(`not parsed: ${sql}`)
    return walk(parsed.tree)
  }
  const t = (name: string, kind: ChangeTarget["kind"] = "table"): ChangeTarget => ({ parts: name === "" ? [] : name.split("."), kind })

  it.each<[string, ChangeTarget[], string[]]>([
    ["DROP TABLE hr.salaries", [t("hr.salaries")], []],
    ["DROP TABLE main.hr.salaries PURGE", [t("main.hr.salaries")], []],
    ["DELETE FROM salaries WHERE id IN (SELECT id FROM main.s.u)", [t("salaries")], ["main.s.u"]],
    ["MERGE INTO main.hr.t USING main.s.u ON t.id = u.id WHEN MATCHED THEN DELETE", [t("main.hr.t")], []],
    ["MERGE INTO main.hr.t USING (SELECT * FROM main.s.u) u ON t.id = u.id WHEN MATCHED THEN DELETE", [t("main.hr.t")], ["main.s.u"]],
    ["CREATE TABLE main.hr.t AS SELECT * FROM main.s.u", [t("main.hr.t")], ["main.s.u"]],
    ["CREATE OR REPLACE VIEW main.hr.v AS SELECT * FROM main.s.u", [t("main.hr.v")], ["main.s.u"]],
    ["CREATE TABLE main.hr.t2 LIKE main.s.u", [t("main.hr.t2")], []],
    ["INSERT INTO main.hr.t SELECT * FROM main.s.u", [t("main.hr.t")], ["main.s.u"]],
    ["WITH q AS (SELECT * FROM main.s.u) INSERT OVERWRITE main.hr.t SELECT * FROM q", [t("main.hr.t")], ["main.s.u", "q"]],
    ["FROM main.s.u INSERT INTO main.hr.a SELECT * INSERT INTO main.hr.b SELECT *", [t("main.hr.a"), t("main.hr.b")], ["main.s.u"]],
    ["UPDATE main.hr.t SET a = 1 WHERE b IN (SELECT b FROM main.s.u)", [t("main.hr.t")], ["main.s.u"]],
    ["ALTER TABLE main.hr.t ADD COLUMN c INT", [t("main.hr.t")], []],
    ["ALTER TABLE main.hr.t RENAME TO main.other.t2", [t("main.hr.t"), t("main.other.t2")], []],
    ["TRUNCATE TABLE main.hr.t", [t("main.hr.t")], []],
    ["CREATE STREAMING TABLE main.s.st AS SELECT * FROM STREAM main.s.t", [t("main.s.st")], ["main.s.t"]],
    ["DROP SCHEMA main.hr CASCADE", [t("main.hr", "schema")], []],
    ["CREATE SCHEMA main.hr", [t("main.hr", "schema")], []],
    ["COMMENT ON SCHEMA main.hr IS 'x'", [t("main.hr", "schema")], []],
    ["DROP FUNCTION main.hr.f", [t("main.hr.f", "function")], []],
    ["CREATE FUNCTION main.hr.f(x INT) RETURNS INT RETURN x + 1", [t("main.hr.f", "function")], []],
    ["CALL main.s.proc()", [t("main.s.proc", "other")], []],
    ["DROP TABLE IDENTIFIER('main.hr.t')", [t("")], []],
    ["SELECT * FROM main.s.t", [], ["main.s.t"]],
  ])("%s", (sql, targets, tables) => {
    const found = walked(sql)
    expect(found.targets).toEqual(targets)
    // `tables` is unchanged: what queries inside the statement read, never its targets.
    expect(found.tables.map((table) => table.parts.join("."))).toEqual(tables)
  })

  it("names every kind by the statement form", () => {
    expect(walked("DROP SCHEMA IF EXISTS main.hr RESTRICT").targets.map((target) => target.kind)).toEqual(["schema"])
    expect(walked("DROP FUNCTION IF EXISTS main.hr.f").targets.map((target) => target.kind)).toEqual(["function"])
  })
})
