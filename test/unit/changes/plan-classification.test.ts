// Design §15.1's classification row, and the plan's own promise: `databricks_plan` classifies every statement form in
// design §5.5's table, raises a category only by the token rules, never sends a statement (L7 as evidence), and previews
// what its commit will do.
import { describe, expect, it } from "vitest"
import { COMMIT_TOOL } from "../../../src/domain/actions.js"
import type { Output } from "../../../src/domain/contract.js"
import { HANDLERS } from "../../../src/registry.js"
import { runTool } from "../../../src/tool-spec.js"
import { changeHarness, RUNNING_WAREHOUSE, type ChangeHarness } from "./harness.js"

const plan = async (sql: string, harness: ChangeHarness = changeHarness(), extra: Record<string, unknown> = {}): Promise<Output<"plan">> =>
  (await runTool("plan", { sql, ...extra }, harness.call(), harness.deps, HANDLERS)) as Output<"plan">

describe("§5.5's statement table, through databricks_plan", () => {
  const TABLE: readonly (readonly [string, string, string])[] = [
    // [SQL, category, commit tool]
    ["INSERT INTO main.s.t SELECT 1", "write", "databricks_write"],
    ["UPDATE main.s.t SET id = 1 WHERE id = 2", "write", "databricks_write"],
    ["MERGE INTO main.s.t USING main.s.u ON t.id = u.id WHEN MATCHED THEN UPDATE SET id = u.id", "write", "databricks_write"],
    ["CREATE TABLE main.s.new (id BIGINT)", "write", "databricks_write"],
    ["CREATE VIEW main.s.v AS SELECT 1 AS one", "write", "databricks_write"],
    ["ALTER TABLE main.s.t ADD COLUMNS (extra STRING)", "write", "databricks_write"],
    ["COMMENT ON TABLE main.s.t IS 'orders'", "write", "databricks_write"],
    ["ANALYZE TABLE main.s.t COMPUTE STATISTICS", "write", "databricks_write"],
    ["REFRESH TABLE main.s.t", "write", "databricks_write"],
    ["DELETE FROM main.s.t WHERE id = 1", "delete", "databricks_delete"],
    ["TRUNCATE TABLE main.s.t", "delete", "databricks_delete"],
    ["DROP TABLE main.s.t", "delete", "databricks_delete"],
    ["DROP VIEW main.s.v", "delete", "databricks_delete"],
    ["INSERT OVERWRITE TABLE main.s.t SELECT 1", "delete", "databricks_delete"],
    ["MERGE INTO main.s.t USING main.s.u ON t.id = u.id WHEN MATCHED THEN DELETE", "delete", "databricks_delete"],
    ["CREATE OR REPLACE TABLE main.s.t (id BIGINT)", "delete", "databricks_delete"],
    ["ALTER TABLE main.s.t DROP COLUMN extra", "delete", "databricks_delete"],
    ["ALTER TABLE main.s.t SET TBLPROPERTIES ('delta.logRetentionDuration' = 'interval 1 days')", "delete", "databricks_delete"],
    ["GRANT SELECT ON TABLE main.s.t TO `team`", "share", "databricks_share"],
    ["REVOKE SELECT ON TABLE main.s.t FROM `team`", "share", "databricks_share"],
    ["INSERT OVERWRITE DIRECTORY '/tmp/out' USING parquet SELECT 1 AS one", "export", "databricks_export"],
    ["CREATE TABLE main.s.exported LOCATION '/mnt/x' AS SELECT 1 AS one", "export", "databricks_export"],
    ["EXECUTE IMMEDIATE 'DROP TABLE main.s.t'", "run", "databricks_run"],
    ["CALL main.s.procedure(1)", "run", "databricks_run"],
    ["BEGIN DELETE FROM main.s.t WHERE id = 1; INSERT INTO main.s.t SELECT 2 END", "run", "databricks_run"],
    // Databricks' and Delta's own statements the pinned OSS grammar cannot parse: `run`, the strictest (design §5.5
    // step 2 names these: VACUUM, OPTIMIZE, RESTORE, COPY INTO, CREATE STREAMING TABLE, REORG, FSCK).
    ["VACUUM main.s.t", "run", "databricks_run"],
    ["OPTIMIZE main.s.t ZORDER BY (id)", "run", "databricks_run"],
    ["RESTORE TABLE main.s.t TO VERSION AS OF 3", "run", "databricks_run"],
    ["COPY INTO main.s.t FROM '/mnt/x' FILEFORMAT = PARQUET", "run", "databricks_run"],
    // The pinned grammar parses CREATE STREAMING TABLE as a pipeline dataset (CreatePipelineDatasetContext), so Day 0's
    // statement table makes it `write` — stricter than nothing, and the table is the one authority for a category
    // (design §5.5: "The parser's category is final"). The design's list puts it under `run` as unparseable; the table
    // wins, and the PR records the difference for the contract keeper.
    ["CREATE STREAMING TABLE main.s.st AS SELECT * FROM STREAM main.s.t", "write", "databricks_write"],
    ["REORG TABLE main.s.t APPLY (PURGE)", "run", "databricks_run"],
    ["FSCK REPAIR TABLE main.s.t", "run", "databricks_run"],
    ["DENY SELECT ON TABLE main.s.t TO `team`", "run", "databricks_run"],
    ["ALTER TABLE main.s.t OWNER TO `team`", "run", "databricks_run"],
  ]

  for (const [sql, category, commitWith] of TABLE) {
    it(`plans ${sql.slice(0, 60)} as ${category}, committed with ${commitWith}`, async () => {
      const harness = changeHarness()
      const answer = await plan(sql, harness)
      expect(answer, JSON.stringify(answer)).toMatchObject({ state: "planned", category, commitWith })
      expect(COMMIT_TOOL[category as keyof typeof COMMIT_TOOL]).toBe(commitWith.replace("databricks_", ""))
      // A plan sends **no** statement, for any of these forms: that is what replaces EXPLAIN (design §5.5 step 3).
      expect(harness.statements()).toEqual([])
      harness.settle()
    })
  }

  it("refuses a read, a session statement and a secret function with the design's codes", async () => {
    expect(await plan("SELECT 1")).toMatchObject({ error: "CATEGORY_MISMATCH", message: expect.stringContaining("databricks_query") })
    expect(await plan("SET PATH = main.evil")).toMatchObject({ error: "SESSION_STATEMENT_REFUSED" })
    // The pinned grammar reads SET TAGS as a session SET, so Day 0's table refuses it as a session statement rather than
    // planning it as a share change; a refusal is the fail-closed answer, and the PR records it for the contract keeper.
    expect(await plan("SET TAGS ('pii' = 'true') ON TABLE main.s.t")).toMatchObject({ error: "SESSION_STATEMENT_REFUSED" })
    expect(await plan("SELECT secret('scope', 'key')")).toMatchObject({ error: "SECRET_FUNCTION_REFUSED" })
    expect(await plan("explain select 1")).toMatchObject({ error: "CATEGORY_MISMATCH" })
  })

  it("raises a category by the token rules, never lowers it, and says why", async () => {
    const identifier = await plan("INSERT INTO main.s.t SELECT * FROM IDENTIFIER(:table)", changeHarness(), { params: [{ name: "table", value: "main.s.u" }] })
    expect(identifier).toMatchObject({ category: "run" })
    expect(JSON.stringify(identifier.preview)).toContain("Raised to run by IDENTIFIER")
    const execute = await plan("EXECUTE IMMEDIATE 'DROP TABLE main.s.t'")
    expect(JSON.stringify(execute.preview)).toContain("Raised to run by EXECUTE IMMEDIATE")
  })

  it("says plainly when a script's statements are not known until it runs", async () => {
    const answer = await plan("BEGIN DELETE FROM main.s.t WHERE id = 1; SELECT 2 END")
    expect(answer).toMatchObject({ category: "run", preview: { kind: "script", parsed: false } })
    expect(answer.preview!.notes.join(" ")).toMatch(/not known until it runs/)
  })

  it("says a statement the plugin cannot parse is checked by Databricks at commit", async () => {
    const answer = await plan("VACUUM main.s.t")
    expect(answer).toMatchObject({ category: "run", preview: { parsed: false } })
    expect(answer.preview!.notes.join(" ")).toMatch(/Databricks checks it at commit/)
  })

  it("keeps a plan's own text and params exactly, for its commit to send", async () => {
    const harness = changeHarness()
    const sql = "INSERT INTO main.s.t SELECT :v AS v"
    const planned = await plan(sql, harness, { params: [{ name: "v", value: 7, type: "BIGINT" }] })
    const stored = harness.deps.plans.peek(planned.planId!)!
    expect(stored.plan.payload).toEqual({ kind: "sql", sql, params: [{ name: "v", value: 7, type: "BIGINT" }], warehouse: "wh-small" })
  })
})

describe("the preview", () => {
  it("names the warehouse and says a running one is already running", async () => {
    const harness = changeHarness()
    const answer = await plan("DELETE FROM main.s.t WHERE id = 1", harness)
    expect(answer.preview!.warehouse).toMatchObject({ id: "wh-small", started: false, usdPerHour: expect.any(Number) })
    expect(answer.preview!.notes.join(" ")).toMatch(/already running/)
    expect(harness.calls.filter((entry) => entry.method === "startWarehouse")).toEqual([])
  })

  it("says a stopped warehouse would be started by the commit, what that costs, and starts nothing itself", async () => {
    const harness = changeHarness({ warehouse: { ...RUNNING_WAREHOUSE, state: "STOPPED" } })
    const answer = await plan("DELETE FROM main.s.t WHERE id = 1", harness)
    expect(answer.state).toBe("planned")
    expect(answer.preview!.notes.join(" ")).toMatch(/committing this plan starts it, which costs at least about \$1\.40/)
    expect(harness.calls.filter((entry) => entry.method === "startWarehouse")).toEqual([])
    expect(harness.ledger.charges).toEqual([])
  })

  it("refuses a stopped warehouse whose start policy refuses, naming each condition", async () => {
    const harness = changeHarness({ warehouse: { ...RUNNING_WAREHOUSE, state: "STOPPED", serverless: false, warehouseType: "CLASSIC" } })
    expect(await plan("DELETE FROM main.s.t WHERE id = 1", harness)).toMatchObject({ error: "START_REFUSED", message: expect.stringContaining("only a serverless warehouse may be started") })
    expect(harness.ledger.charges).toEqual([])
  })

  it("shows every target with its type and owner, and whether it exists", async () => {
    const harness = changeHarness({ tables: { "main.s.t": { tableType: "MANAGED", owner: "team" } } })
    const answer = await plan("DELETE FROM main.s.t WHERE id = 1", harness)
    expect(answer.preview!.targets).toEqual([{ name: "main.s.t", type: "MANAGED", owner: "team", exists: true }])
  })

  it("turns a CREATE over an existing target into a replace, which is a delete plan", async () => {
    const existing = await plan("CREATE TABLE main.s.t (id BIGINT)", changeHarness({ tables: { "main.s.t": {} } }))
    expect(existing).toMatchObject({ category: "delete", commitWith: "databricks_delete" })
    expect(existing.preview!.notes.join(" ")).toMatch(/already exists, so this is a replace/)
    const fresh = await plan("CREATE TABLE main.s.t (id BIGINT)")
    expect(fresh).toMatchObject({ category: "write" })
  })

  it("refuses a name it cannot fully qualify, rather than letting the server resolve it", async () => {
    const answer = await plan("DROP TABLE t")
    expect(answer).toMatchObject({ error: "INPUT_INVALID", message: expect.stringContaining("not fully qualified") })
    expect(answer.next).toMatch(/catalog\.schema\.name/)
    expect(answer).not.toHaveProperty("planId")
  })

  it("resolves a one-part name with the catalog first, then the schema", async () => {
    const harness = changeHarness({ tables: { "main.hr.salaries": { tableType: "MANAGED", owner: "hr" } } })
    const answer = await plan("DROP TABLE salaries", harness, { catalog: "main", schema: "hr" })
    expect(answer.preview!.targets).toEqual([{ name: "main.hr.salaries", type: "MANAGED", owner: "hr", exists: true }])
  })

  it("resolves a two-part name against the catalog only", async () => {
    const harness = changeHarness({ tables: { "main.hr.salaries": {} } })
    const answer = await plan("DROP TABLE hr.salaries", harness, { catalog: "main" })
    expect(answer.preview!.targets).toEqual([{ name: "main.hr.salaries", type: "MANAGED", exists: true }])
  })

  it("stores the defaults it resolved with, so the commit sends the same ones", async () => {
    const harness = changeHarness()
    const planned = await plan("DROP TABLE salaries", harness, { catalog: "main", schema: "hr" })
    await plan("DROP TABLE salaries", harness, { catalog: "main", schema: "hr" })
    const stored = harness.deps.plans.peek(planned.planId!)!.plan
    expect(stored.payload).toMatchObject({ kind: "sql", catalog: "main", schema: "hr" })
  })
})

describe("admin plans", () => {
  it("needs a reason, and refuses when admin plans are turned off", async () => {
    const harness = changeHarness()
    expect(await plan("ALTER TABLE main.s.t SET LOCATION '/mnt/x'", harness)).toMatchObject({ error: "ADMIN_REASON_REQUIRED" })
    const planned = await plan("ALTER TABLE main.s.t SET LOCATION '/mnt/x'", harness, { reason: "move to the new mount" })
    expect(planned).toMatchObject({ category: "admin", commitWith: "databricks_admin", preview: { reason: "move to the new mount" } })
    const off = changeHarness({ options: { admin: { enabled: false } } })
    expect(await plan("ALTER TABLE main.s.t SET LOCATION '/mnt/x'", off, { reason: "move" })).toMatchObject({ error: "PERMISSION_DENIED", next: expect.stringContaining("admin.enabled") })
  })
})
