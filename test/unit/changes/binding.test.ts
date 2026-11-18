// The person's rules on a change (design §10.1, §15.3, review of #7's H1 and M1): a target is resolved the way
// Databricks resolves it — the statement's catalog and then its schema — and every target is asserted under the commit
// tool's own dotted action, before the statement. A rule is the family's, resolved with OpenCode's last-match-wins.
import { describe, expect, it } from "vitest"
import type { Output } from "../../../src/domain/contract.js"
import { HANDLERS } from "../../../src/registry.js"
import { runTool } from "../../../src/tool-spec.js"
import { defaultRules, effectOf, type Rule } from "../../../src/permissions.js"
import { RecordingPermission } from "../../fake/ports.js"
import { changeHarness, RUNNING_WAREHOUSE, type ChangeHarness } from "./harness.js"

const plan = async (input: Record<string, unknown>, harness: ChangeHarness): Promise<Output<"plan">> => (await runTool("plan", input, harness.call(), harness.deps, HANDLERS)) as Output<"plan">
const commit = async (tool: "write" | "delete" | "share" | "export" | "run" | "admin", harness: ChangeHarness, planId: string) =>
  (await runTool(tool, { planId }, harness.call(`call_${tool}`), harness.deps, HANDLERS)) as Record<string, unknown>

/** A harness whose rules are OpenCode's: the base allow, the family's defaults, then the person's own rules last. */
const ruled = (rules: readonly Rule[], seed: Parameters<typeof changeHarness>[0] = {}) => {
  const all: Rule[] = [{ action: "*", resource: "*", effect: "allow" }, ...defaultRules("all"), ...rules]
  const permission = new RecordingPermission((request) => (effectOf(all, request.action, request.resource) === "deny" ? "deny" : "allow"))
  return changeHarness({ ...seed, permission })
}

const denyDelete = (resource: string): Rule => ({ action: "databricks.delete", resource, effect: "deny" })

describe("H1: a name is resolved the way Databricks resolves it", () => {
  const cases: readonly (readonly [string, Record<string, unknown>, string])[] = [
    ["one part", { sql: "DROP TABLE salaries", catalog: "main", schema: "hr" }, "work:table:main.hr.salaries"],
    ["two parts", { sql: "DROP TABLE hr.salaries", catalog: "main" }, "work:table:main.hr.salaries"],
    ["three parts", { sql: "DROP TABLE main.hr.salaries" }, "work:table:main.hr.salaries"],
  ]

  for (const [shape, input, resource] of cases) {
    it(`a ${shape} name is refused by the person's *.hr.* deny, and no statement is sent`, async () => {
      const harness = ruled([denyDelete("work:table:*.hr.*")])
      const planned = await plan(input, harness)
      expect(planned).toMatchObject({ state: "planned", category: "delete" })
      expect(planned.preview!.targets).toEqual([{ name: "main.hr.salaries", exists: false }])
      await expect(commit("delete", harness, planned.planId!)).rejects.toThrow(/denied/)
      expect(harness.permission.requests.map((request) => request.resource)).toContain(resource)
      expect(harness.statements()).toEqual([])
    })

    it(`a ${shape} name is allowed when the person allows exactly it, and the statement runs`, async () => {
      const harness = ruled([denyDelete("work:table:main.other.*")], { tables: { "main.hr.salaries": {} } })
      const planned = await plan(input, harness)
      await commit("delete", harness, planned.planId!)
      expect(harness.permission.requests.map((request) => request.resource)).toContain(resource)
      expect(harness.statements()).toHaveLength(1)
    })
  }

  it("a three-part name the person denies by its own name is refused too", async () => {
    const harness = ruled([denyDelete("work:table:main.hr.salaries")])
    const planned = await plan({ sql: "DROP TABLE main.hr.salaries" }, harness)
    await expect(commit("delete", harness, planned.planId!)).rejects.toThrow(/denied: databricks.delete on work:table:main.hr.salaries/)
    expect(harness.statements()).toEqual([])
  })
})

describe("M1: every target is resolved fully and asserted", () => {
  it("refuses a name it cannot fully qualify, before anything is sent", async () => {
    const one = await plan({ sql: "DELETE FROM salaries" }, changeHarness())
    expect(one).toMatchObject({ error: "INPUT_INVALID", message: expect.stringContaining("not fully qualified") })
    const two = await plan({ sql: "DROP TABLE hr.salaries" }, changeHarness())
    expect(two).toMatchObject({ error: "INPUT_INVALID" })
    const harness = changeHarness()
    await plan({ sql: "DROP TABLE hr.salaries" }, harness)
    expect(harness.calls.filter((entry) => entry.method === "getTable")).toEqual([])
  })

  it("asserts a schema target as the schema wildcard, which the person's *.hr.* rule matches", async () => {
    const harness = ruled([denyDelete("work:table:*.hr.*")])
    const planned = await plan({ sql: "DROP SCHEMA main.hr" }, harness)
    expect(planned.preview!.targets).toEqual([{ name: "main.hr", type: "SCHEMA" }])
    await expect(commit("delete", harness, planned.planId!)).rejects.toThrow(/denied: databricks.delete on work:table:main.hr.\*/)
    expect(harness.statements()).toEqual([])
  })

  it("treats DROP SCHEMA … CASCADE as every object in the schema, and says how many", async () => {
    const harness = changeHarness({ schemas: { "main.hr": ["salaries", "people", "payroll"] } })
    const planned = await plan({ sql: "DROP SCHEMA main.hr CASCADE" }, harness)
    expect(planned).toMatchObject({ state: "planned", category: "delete" })
    expect(planned.preview!.notes.join(" ")).toMatch(/CASCADE: 3 objects will be checked against your rules/)
    expect(harness.calls.filter((entry) => entry.method === "listTables")).toHaveLength(1)
    // The commit re-lists the contents and asserts the schema-level rule.
    await commit("delete", harness, planned.planId!)
    expect(harness.permission.requests.map((request) => request.resource)).toContain("work:table:main.hr.*")
    expect(harness.statements()).toHaveLength(1)
  })

  it("refuses a CASCADE whose contents it cannot list", async () => {
    const harness = changeHarness()
    const broken = new Proxy(harness.deps.databricks, {
      get(target, name, receiver) {
        if (name === "listTables") return async () => Promise.reject(new Error("the list failed"))
        return Reflect.get(target, name, receiver)
      },
    })
    const planned = (await runTool("plan", { sql: "DROP SCHEMA main.hr CASCADE" }, harness.call(), { ...harness.deps, databricks: broken }, HANDLERS)) as Output<"plan">
    expect(planned).toMatchObject({ error: "FENCED", message: expect.stringContaining("cannot list the objects") })
    expect(harness.statements()).toEqual([])
  })

  it("is PLAN_CHANGED when the schema gained an object after the preview", async () => {
    const harness = changeHarness({ schemas: { "main.hr": ["salaries"] } })
    const planned = await plan({ sql: "DROP SCHEMA main.hr CASCADE" }, harness)
    harness.schemas.set("main.hr", ["salaries", "people"])
    expect(await commit("delete", harness, planned.planId!)).toMatchObject({ error: "PLAN_CHANGED", message: expect.stringContaining("kind, type or contents changed") })
    expect(harness.statements()).toEqual([])
  })

  it("asserts a function as a function, without asking tables.get about it", async () => {
    const harness = changeHarness()
    const planned = await plan({ sql: "DROP FUNCTION main.hr.f" }, harness)
    expect(planned.preview!.targets).toEqual([{ name: "main.hr.f", type: "FUNCTION" }])
    await commit("delete", harness, planned.planId!)
    expect(harness.permission.requests.map((request) => request.resource)).toContain("work:function:main.hr.f")
    expect(harness.calls.filter((entry) => entry.method === "getTable")).toEqual([])
  })
})

describe("R2-M1: a rename's destination is a target too", () => {
  it("refuses moving a table into a schema the person denies, and asserts both names", async () => {
    // An ALTER is a write, so the rule that governs it is databricks.write.
    const harness = ruled([{ action: "databricks.write", resource: "work:table:*.hr.*", effect: "deny" }], { tables: { "main.s.a": { tableType: "MANAGED" } } })
    const planned = await plan({ sql: "ALTER TABLE main.s.a RENAME TO main.hr.b" }, harness)
    expect(planned).toMatchObject({ state: "planned", category: "write" })
    expect(planned.preview!.targets.map((target) => target.name)).toEqual(["main.s.a", "main.hr.b"])
    await expect(commit("write", harness, planned.planId!)).rejects.toThrow(/denied/)
    const asked = harness.permission.requests.map((request) => request.resource)
    expect(asked).toContain("work:table:main.s.a")
    expect(asked).toContain("work:table:main.hr.b")
    expect(harness.statements()).toEqual([])
  })

  it("resolves a one-part destination with the catalog first, then the schema", async () => {
    const harness = ruled([{ action: "databricks.write", resource: "work:table:*.hr.*", effect: "deny" }], { tables: { "main.s.a": {} } })
    const planned = await plan({ sql: "ALTER TABLE main.s.a RENAME TO b", catalog: "main", schema: "hr" }, harness)
    expect(planned.preview!.targets.map((target) => target.name)).toEqual(["main.s.a", "main.hr.b"])
    await expect(commit("write", harness, planned.planId!)).rejects.toThrow(/denied: databricks.write on work:table:main.hr.b/)
    expect(harness.statements()).toEqual([])
  })

  it("does the same for a view", async () => {
    const harness = ruled([{ action: "databricks.write", resource: "work:table:*.hr.*", effect: "deny" }], { tables: { "main.s.v": { tableType: "VIEW" } } })
    const planned = await plan({ sql: "ALTER VIEW main.s.v RENAME TO main.hr.w" }, harness)
    expect(planned.preview!.targets.map((target) => target.name)).toEqual(["main.s.v", "main.hr.w"])
    await expect(commit("write", harness, planned.planId!)).rejects.toThrow(/denied/)
    expect(harness.statements()).toEqual([])
  })

  it("plans a function rename as run, because the pinned grammar does not parse ALTER FUNCTION", async () => {
    const harness = changeHarness()
    const planned = await plan({ sql: "ALTER FUNCTION main.hr.f RENAME TO main.hr.g" }, harness)
    expect(planned).toMatchObject({ state: "planned", category: "run", commitWith: "databricks_run", preview: { parsed: false } })
    expect(planned.preview!.targets).toEqual([])
    expect(planned.preview!.notes.join(" ")).toMatch(/Databricks checks it at commit/)
  })
})

describe("the review's LOWs", () => {
  it("LOW 1: a CASCADE reaches a rule that names one of its tables", async () => {
    const harness = ruled([denyDelete("work:table:main.hr.salaries")], { schemas: { "main.hr": ["salaries", "people"] } })
    const planned = await plan({ sql: "DROP SCHEMA main.hr CASCADE" }, harness)
    expect(planned).toMatchObject({ state: "planned" })
    await expect(commit("delete", harness, planned.planId!)).rejects.toThrow(/denied: databricks.delete on work:table:main.hr.salaries/)
    expect(harness.statements()).toEqual([])
  })

  it("LOW 3: DROP CATALOG is a target even though it plans as run", async () => {
    const harness = changeHarness()
    const planned = await plan({ sql: "DROP CATALOG main CASCADE" }, harness)
    expect(planned).toMatchObject({ state: "planned", category: "run", commitWith: "databricks_run" })
    expect(planned.preview!.targets).toEqual([{ name: "main", type: "CATALOG" }])
    await commit("run", harness, planned.planId!)
    expect(harness.permission.requests.map((request) => request.resource)).toContain("work:table:main.*.*")
    expect(harness.statements()).toHaveLength(1)
  })

  it("round 3: a catalog CASCADE asserts each schema and object, so a *.hr.* rule refuses it", async () => {
    // A DROP CATALOG plans as `run` (unparseable), so the rule that governs it is databricks.run.
    const harness = ruled([{ action: "databricks.run", resource: "work:table:*.hr.*", effect: "deny" }], { catalogs: { main: ["hr", "s"] }, schemas: { "main.hr": ["salaries", "people"], "main.s": ["one"] } })
    const planned = await plan({ sql: "DROP CATALOG main CASCADE" }, harness)
    expect(planned).toMatchObject({ state: "planned", category: "run", commitWith: "databricks_run" })
    expect(planned.preview!.notes.join(" ")).toMatch(/CASCADE: 2 schemas and 3 objects will be checked against your rules/)
    await expect(commit("run", harness, planned.planId!)).rejects.toThrow(/denied: databricks.run on work:table:main.hr.\*/)
    const asked = harness.permission.requests.map((request) => request.resource)
    expect(asked).toContain("work:table:main.*.*")
    expect(asked).toContain("work:table:main.hr.*")
    expect(harness.statements()).toEqual([])
  })

  it("round 3: every schema and object of a catalog CASCADE is asserted, in order", async () => {
    const harness = changeHarness({ catalogs: { main: ["hr", "s"] }, schemas: { "main.hr": ["salaries", "people"], "main.s": ["one"] } })
    const planned = await plan({ sql: "DROP CATALOG main CASCADE" }, harness)
    await commit("run", harness, planned.planId!)
    const asked = harness.permission.requests.map((request) => request.resource).filter((resource) => resource.startsWith("work:table:main"))
    expect(asked).toEqual(["work:table:main.*.*", "work:table:main.hr.*", "work:table:main.hr.people", "work:table:main.hr.salaries", "work:table:main.s.*", "work:table:main.s.one"])
    expect(harness.statements()).toHaveLength(1)
  })

  it("round 4 (LOW 3): a CASCADE lists functions and volumes, and a function rule refuses it", async () => {
    const harness = ruled([{ action: "databricks.delete", resource: "work:function:*.hr.*", effect: "deny" }], { schemas: { "main.hr": ["salaries"] }, functionNames: { "main.hr": ["f"] }, volumeNames: { "main.hr": ["v"] } })
    const planned = await plan({ sql: "DROP SCHEMA main.hr CASCADE" }, harness)
    expect(planned.preview!.notes.join(" ")).toMatch(/CASCADE: 3 objects will be checked against your rules/)
    await expect(commit("delete", harness, planned.planId!)).rejects.toThrow(/denied: databricks.delete on work:function:main.hr.f/)
    const asked = harness.permission.requests.map((request) => request.resource)
    expect(asked).toContain("work:table:main.hr.*")
    expect(asked).toContain("work:table:main.hr.salaries")
    expect(asked).toContain("work:function:main.hr.f")
    expect(harness.statements()).toEqual([])
  })

  it("round 5: a CASCADE lists registered models, and a model rule refuses it", async () => {
    const harness = ruled([{ action: "databricks.delete", resource: "work:model:*.hr.*", effect: "deny" }], { schemas: { "main.hr": ["salaries"] }, modelNames: { "main.hr": ["risk"] } })
    const planned = await plan({ sql: "DROP SCHEMA main.hr CASCADE" }, harness)
    expect(planned.preview!.notes.join(" ")).toMatch(/CASCADE: 2 objects will be checked against your rules/)
    await expect(commit("delete", harness, planned.planId!)).rejects.toThrow(/denied: databricks.delete on work:model:main.hr.risk/)
    expect(harness.permission.requests.map((request) => request.resource)).toContain("work:model:main.hr.risk")
    expect(harness.statements()).toEqual([])
  })

  it("round 5: refuses a CASCADE whose model list cannot be read", async () => {
    const harness = changeHarness()
    const broken = new Proxy(harness.deps.databricks, {
      get(target, name, receiver) {
        if (name === "listModels") return async () => Promise.reject(new Error("the list failed"))
        return Reflect.get(target, name, receiver)
      },
    })
    const planned = (await runTool("plan", { sql: "DROP SCHEMA main.hr CASCADE" }, harness.call(), { ...harness.deps, databricks: broken }, HANDLERS)) as Output<"plan">
    expect(planned).toMatchObject({ error: "FENCED", next: expect.stringContaining("SQL editor") })
    expect(harness.statements()).toEqual([])
  })

  it("round 4 (LOW 3): a volume is asserted under its own resource", async () => {
    const harness = changeHarness({ schemas: { "main.hr": [] }, functionNames: { "main.hr": [] }, volumeNames: { "main.hr": ["v"] } })
    const planned = await plan({ sql: "DROP SCHEMA main.hr CASCADE" }, harness)
    await commit("delete", harness, planned.planId!)
    expect(harness.permission.requests.map((request) => request.resource)).toContain("work:volume:main.hr.v")
  })

  it("round 4 (LOW 3): refuses a CASCADE whose function list cannot be read", async () => {
    const harness = changeHarness()
    const broken = new Proxy(harness.deps.databricks, {
      get(target, name, receiver) {
        if (name === "listFunctions") return async () => Promise.reject(new Error("the list failed"))
        return Reflect.get(target, name, receiver)
      },
    })
    const planned = (await runTool("plan", { sql: "DROP SCHEMA main.hr CASCADE" }, harness.call(), { ...harness.deps, databricks: broken }, HANDLERS)) as Output<"plan">
    expect(planned).toMatchObject({ error: "FENCED", next: expect.stringContaining("SQL editor") })
  })

  it("round 3: refuses a catalog CASCADE whose schema list cannot be read, with a next step", async () => {
    const harness = changeHarness()
    const broken = new Proxy(harness.deps.databricks, {
      get(target, name, receiver) {
        if (name === "listSchemas") return async () => Promise.reject(new Error("the list failed"))
        return Reflect.get(target, name, receiver)
      },
    })
    const planned = (await runTool("plan", { sql: "DROP CATALOG main CASCADE" }, harness.call(), { ...harness.deps, databricks: broken }, HANDLERS)) as Output<"plan">
    expect(planned).toMatchObject({ error: "FENCED", message: expect.stringContaining("cannot list the schemas"), next: expect.stringContaining("SQL editor") })
    expect(harness.statements()).toEqual([])
  })

  it("round 3: refuses a catalog CASCADE whose contents are past the bound", async () => {
    const many = Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`main.s${index}`, [] as string[]]))
    const harness = changeHarness({ catalogs: { main: Array.from({ length: 1001 }, (_, index) => `s${index}`) }, schemas: many })
    const planned = await plan({ sql: "DROP CATALOG main CASCADE" }, harness)
    expect(planned).toMatchObject({ error: "FENCED", next: expect.stringContaining("SQL editor") })
    expect(harness.statements()).toEqual([])
  })

  it("round 3: an empty catalog asserts only the catalog itself", async () => {
    const harness = changeHarness({ catalogs: { main: [] } })
    const planned = await plan({ sql: "DROP CATALOG main CASCADE" }, harness)
    expect(planned.preview!.notes.join(" ")).toMatch(/CASCADE: 0 schemas and 0 objects will be checked against your rules/)
    await commit("run", harness, planned.planId!)
    const asked = harness.permission.requests.map((request) => request.resource)
    expect(asked).toContain("work:table:main.*.*")
    expect(asked.filter((resource) => resource.startsWith("work:table:main."))).toEqual(["work:table:main.*.*"])
    expect(harness.statements()).toHaveLength(1)
  })

  it("round 3: DROP CATALOG without CASCADE asserts only the catalog, as RESTRICT leaves the contents alone", async () => {
    const harness = ruled([denyDelete("work:table:*.hr.*")], { catalogs: { main: ["hr"] }, schemas: { "main.hr": ["salaries"] } })
    const planned = await plan({ sql: "DROP CATALOG main" }, harness)
    await commit("run", harness, planned.planId!)
    const asked = harness.permission.requests.map((request) => request.resource)
    expect(asked).toContain("work:table:main.*.*")
    expect(asked).not.toContain("work:table:main.hr.*")
    expect(harness.calls.filter((entry) => entry.method === "listSchemas")).toEqual([])
  })

  it("LOW 3: a person's catalog rule refuses it, and IF EXISTS parses too", async () => {
    const denied = ruled([{ action: "databricks.run", resource: "work:table:main.*.*", effect: "deny" }])
    const planned = await plan({ sql: "DROP CATALOG IF EXISTS main CASCADE" }, denied)
    expect(planned.preview!.targets).toEqual([{ name: "main", type: "CATALOG" }])
    await expect(commit("run", denied, planned.planId!)).rejects.toThrow(/denied: databricks.run on work:table:main.\*\.\*/)
    expect(denied.statements()).toEqual([])
  })
  it("LOW 2: another session's plan is refused before the person is asked anything", async () => {
    const harness = changeHarness()
    const planned = await plan({ sql: "DELETE FROM main.s.t WHERE id = 1" }, harness)
    const before = harness.permission.requests.length
    const foreign = { ...harness.call("call_other"), sessionID: "ses_other" }
    expect(await runTool("delete", { planId: planned.planId! }, foreign, harness.deps, HANDLERS)).toMatchObject({ error: "PLAN_CALLER_MISMATCH" })
    // Nothing is asked of the person at all: not the tool's action, not a target.
    expect(harness.permission.requests.slice(before)).toEqual([])
    expect(harness.deps.plans.peek(planned.planId!)).toMatchObject({ used: false })
  })

  it("LOW 2: a denied table assert leaves the plan unused", async () => {
    const harness = changeHarness({ permission: new RecordingPermission((request) => (request.resource.includes(":table:") ? "deny" : "allow")) })
    const planned = await plan({ sql: "DELETE FROM main.s.t WHERE id = 1" }, harness)
    await expect(commit("delete", harness, planned.planId!)).rejects.toThrow(/denied/)
    expect(harness.deps.plans.peek(planned.planId!)).toMatchObject({ used: false })
  })

  it("LOW 3: a job plan asserts the Jobs operation, a notebook plan runs/submit, a SQL plan the change path", async () => {
    const job = changeHarness()
    const jobPlan = await plan({ job: { jobId: 100 } }, job)
    await commit("run", job, jobPlan.planId!)
    expect(job.permission.requests.filter((request) => request.action === "databricks.run")).toEqual([expect.objectContaining({ resource: "work:jobs.jobs.runNow" })])

    const notebook = changeHarness()
    const notebookPlan = await plan({ notebook: { path: "/Shared/Nightly" } }, notebook)
    await commit("run", notebook, notebookPlan.planId!)
    expect(notebook.permission.requests.filter((request) => request.action === "databricks.run")).toEqual([expect.objectContaining({ resource: "work:jobs.runs.submit" })])

    const sql = changeHarness()
    const sqlPlan = await plan({ sql: "DELETE FROM main.s.t WHERE id = 1" }, sql)
    await commit("delete", sql, sqlPlan.planId!)
    expect(sql.permission.requests.filter((request) => request.action === "databricks.delete")[0]).toMatchObject({ resource: "work:sql.statements.change" })
  })

  it("LOW 4: a target that changed type since the preview is PLAN_CHANGED", async () => {
    const tables: Record<string, { tableType?: string }> = { "main.s.t": { tableType: "MANAGED" } }
    const harness = changeHarness({ tables })
    const planned = await plan({ sql: "DELETE FROM main.s.t WHERE id = 1" }, harness)
    tables["main.s.t"] = { tableType: "VIEW" }
    expect(await commit("delete", harness, planned.planId!)).toMatchObject({ error: "PLAN_CHANGED" })
    expect(harness.statements()).toEqual([])
  })

  it("LOW 4: a warehouse resized since the preview is PLAN_CHANGED", async () => {
    const harness = changeHarness()
    const planned = await plan({ sql: "DELETE FROM main.s.t WHERE id = 1" }, harness)
    harness.setWarehouse({ ...RUNNING_WAREHOUSE, clusterSize: "4X-Large" })
    expect(await commit("delete", harness, planned.planId!)).toMatchObject({ error: "PLAN_CHANGED", message: expect.stringContaining("changed since the plan was made") })
    expect(harness.statements()).toEqual([])
  })

  it("LOW 4: a target that vanished since the preview is PLAN_CHANGED", async () => {
    const tables: Record<string, { tableType?: string }> = { "main.s.t": { tableType: "MANAGED" } }
    const harness = changeHarness({ tables })
    const planned = await plan({ sql: "DELETE FROM main.s.t WHERE id = 1" }, harness)
    delete tables["main.s.t"]
    expect(await commit("delete", harness, planned.planId!)).toMatchObject({ error: "PLAN_CHANGED" })
  })

  it("LOW 5: a streaming table's preview says it bills at serverless pipeline rates", async () => {
    const streaming = await plan({ sql: "CREATE STREAMING TABLE main.s.st AS SELECT * FROM STREAM main.s.t" }, changeHarness())
    expect(streaming.preview!.notes.join(" ")).toMatch(/serverless pipeline rates/)
    const materialized = await plan({ sql: "CREATE MATERIALIZED VIEW main.s.mv AS SELECT 1 AS one" }, changeHarness())
    expect(materialized.preview!.notes.join(" ")).toMatch(/serverless pipeline rates/)
    const plain = await plan({ sql: "CREATE TABLE main.s.t (id BIGINT)" }, changeHarness())
    expect(plain.preview!.notes.join(" ")).not.toMatch(/pipeline rates/)
  })
})
