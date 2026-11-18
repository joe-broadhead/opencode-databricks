// Every tool asserts its own dotted action first, before any Databricks call (design §10.1, §15.3), and asserted equals
// declared. Package D's plan and commit tools are real here, so the routing tests below run against a harness whose
// warehouse is running and whose `tables.get` answers NOT_FOUND: a plan is a set of free reads, and its commit is the one
// statement (design §5.5).
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { actionOf, DECLARED_ACTIONS, OPERATIONS, SCOPE_OF, type ToolName, TOOLS } from "../../src/domain/actions.js"
import { Enforcement, Inputs, Outputs, ROLE_ENFORCEMENT_TEXT } from "../../src/domain/contract.js"
import { DatabricksError } from "../../src/domain/errors.js"
import { HANDLERS, PRIMARY_OPERATION, REGISTERED } from "../../src/registry.js"
import { errorResult, runTool } from "../../src/tool-spec.js"
import { methods } from "../../src/tools-rpc.js"
import { call, fakeDatabricks, fakeDeps, RecordingPermission } from "../fake/ports.js"
import { harness } from "./reads/harness.js"

const INPUTS: Record<ToolName, unknown> = {
  status: {},
  catalog: {},
  table: { name: "main.sales.orders" },
  warehouses: {},
  explain: { sql: "select 1" },
  query: { sql: "select 1" },
  statement: { statementId: "st-1" },
  history: {},
  profile: { table: "main.sales.orders", columns: ["a"] },
  jobs: {},
  workspace: { path: "/Users" },
  plan: { sql: "drop table main.sales.orders" },
  events_list: { source: "queries" },
  saved_read: { query: "q-1", sha: "0".repeat(64) },
  save: { sql: "select 1" },
  write: { planId: "pln_none" },
  delete: { planId: "pln_none" },
  share: { planId: "pln_none" },
  export: { planId: "pln_none" },
  run: { planId: "pln_none" },
  admin: { planId: "pln_none" },
  cancel: { statementId: "st-1" },
  stop: { warehouse: "wh-small" },
}

describe("the registry", () => {
  it("has a handler for every tool in the table, and every sample input fits its schema", () => {
    expect([...REGISTERED].sort()).toEqual(Object.keys(HANDLERS).sort())
    for (const tool of REGISTERED) expect(Inputs[tool].safeParse(INPUTS[tool]).success, tool).toBe(true)
  })

  it("every tool asserts exactly its dotted action on <account>:<operation> first, and calls Databricks before nothing", async () => {
    const seen = new Set<string>()
    for (const tool of REGISTERED) {
      // The Databricks calls made before the tool's first assert: a tool that is built may call afterwards (its own
      // reads), but no tool may reach Databricks before the person's rules have had their say.
      let callsBeforeFirstAssert = -1
      const permission = new RecordingPermission(() => {
        if (callsBeforeFirstAssert < 0) callsBeforeFirstAssert = fake.databricks.calls.length
        return "allow"
      })
      const fake = fakeDeps({ permission })
      await runTool(tool, INPUTS[tool], call(`call_${tool}`), fake.deps, HANDLERS)
      expect(fake.permission.requests[0], tool).toMatchObject({ action: actionOf(tool), resource: `work:${PRIMARY_OPERATION[tool]}`, sessionID: "ses_test", callID: `call_${tool}` })
      for (const request of fake.permission.requests) seen.add(request.action)
      expect(callsBeforeFirstAssert, tool).toBe(0)
    }
    // Asserted equals declared: the tools assert their own actions; the RPC's probe asserts databricks.probe; a start
    // asserts databricks.start (package C), checked by its own test there; a bound source's content read asserts
    // databricks.read (package E, review of #8 H2), checked by E's tests.
    const fake = fakeDeps()
    const probe = methods(() => fake.deps, HANDLERS).find((method) => method.name === "probe")!
    await probe.run({}, call("call_probe") as never)
    for (const request of fake.permission.requests) seen.add(request.action)
    expect([...new Set([...seen, "databricks.start", "databricks.read"])].sort()).toEqual([...DECLARED_ACTIONS].sort())
  })

  it("a denied assert stops the tool before anything else happens", async () => {
    for (const tool of REGISTERED) {
      const fake = fakeDeps({ permission: new RecordingPermission(() => "deny") })
      await expect(runTool(tool, INPUTS[tool], call(), fake.deps, HANDLERS), tool).rejects.toThrow(/denied/)
      expect(fake.databricks.calls).toEqual([])
    }
  })

  it("no source file asserts an engine name (databricks_<tool>)", () => {
    const root = fileURLToPath(new URL("../../src", import.meta.url))
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? (name === "generated" ? [] : files(join(dir, name))) : [join(dir, name)]))
    for (const file of files(root)) {
      const text = readFileSync(file, "utf8")
      expect(text, file).not.toMatch(/action:\s*[`"']databricks_/)
    }
  })

  it("the tools RPC offers the reads, probe and saved_list, never an export or a change", () => {
    const fake = fakeDeps()
    const names = methods(() => fake.deps, HANDLERS).map((method) => method.name)
    expect(names).toEqual([...TOOLS.filter((tool) => tool.readOnly).map((tool) => tool.name), "probe", "saved_list"])
  })
})

describe("plan → commit routing", () => {
  it("plans a drop as delete, sends no statement, and commits only through databricks_delete, once", async () => {
    const fake = harness()
    const planned = await runTool("plan", { sql: "DROP TABLE main.sales.orders" }, call(), fake.deps, HANDLERS)
    expect(planned).toMatchObject({ state: "planned", category: "delete", commitWith: "databricks_delete" })
    // A plan's reads are free control-plane calls; what it never does is send a statement (design §5.5 step 3).
    expect(fake.databricks.calls.filter((entry) => entry.method === "submit")).toEqual([])
    const planId = planned.planId as string
    expect(await runTool("write", { planId }, call("c2"), fake.deps, HANDLERS)).toMatchObject({ error: "CATEGORY_MISMATCH", next: expect.stringContaining("databricks_delete") })
    expect(await runTool("delete", { planId }, call("c3", "ses_other"), fake.deps, HANDLERS)).toMatchObject({ error: "PLAN_CALLER_MISMATCH" })
    expect(await runTool("delete", { planId }, call("c4"), fake.deps, HANDLERS)).toMatchObject({ state: "ok" })
    expect(await runTool("delete", { planId }, call("c5"), fake.deps, HANDLERS)).toMatchObject({ error: "PLAN_ALREADY_USED" })
  })

  it("expires a plan after planTtlSeconds", async () => {
    const fake = harness()
    const planned = await runTool("plan", { sql: "insert into main.s.t select 1" }, call(), fake.deps, HANDLERS)
    fake.clock.advance(300_000)
    expect(await runTool("write", { planId: planned.planId }, call("c2"), fake.deps, HANDLERS)).toMatchObject({ error: "PLAN_EXPIRED" })
  })

  it("refuses reads, session statements and secrets at plan time, and needs a reason for admin plans", async () => {
    const fake = harness()
    expect(await runTool("plan", { sql: "select 1" }, call(), fake.deps, HANDLERS)).toMatchObject({ error: "CATEGORY_MISMATCH" })
    expect(await runTool("plan", { sql: "SET PATH = main.evil" }, call(), fake.deps, HANDLERS)).toMatchObject({ error: "SESSION_STATEMENT_REFUSED" })
    expect(await runTool("plan", { sql: "select secret('s', 'k')" }, call(), fake.deps, HANDLERS)).toMatchObject({ error: "SECRET_FUNCTION_REFUSED" })
    expect(await runTool("plan", { sql: "alter table main.s.t set location 's3://x'" }, call(), fake.deps, HANDLERS)).toMatchObject({ error: "ADMIN_REASON_REQUIRED" })
    expect(await runTool("plan", { sql: "alter table main.s.t set location 's3://x'", reason: "move" }, call(), fake.deps, HANDLERS)).toMatchObject({ category: "admin" })
  })

  it("uses the plan id as the run's idempotency token shape (pln_<uuid>)", async () => {
    const fake = harness()
    const planned = await runTool("plan", { sql: "CALL main.s.p()" }, call(), fake.deps, HANDLERS)
    expect(planned).toMatchObject({ category: "run" })
    expect(planned.planId).toMatch(/^pln_[0-9a-f-]{36}$/)
  })
})

describe("the contract's amendments for package C", () => {
  it("FakeReads prepares a read on the running fake warehouse, with the facts the ledger needs", async () => {
    const fake = fakeDeps()
    const prepared = await fake.deps.reads.prepare({ account: "work", sql: "select upper(a) from main.s.t", tool: "query", sessionID: "ses_test" }, new AbortController().signal)
    expect(prepared.warehouse).toMatchObject({ id: "wh-small", state: "RUNNING", clusterSize: "Small", serverless: true, autoStopMins: 10 })
    expect(prepared.warehouseId).toBe(prepared.warehouse.id)
    expect(prepared.sent).toBe("SELECT * FROM (\nselect system.builtin.upper(a) from main.s.t\n) AS oc_q")
  })
})

describe("the contract's amendments for package B", () => {
  it("fakeDatabricks waits for a statement by polling getStatement until it is terminal", async () => {
    const states = ["PENDING", "RUNNING", "SUCCEEDED"]
    const { port, calls } = fakeDatabricks({ getStatement: () => ({ statementId: "st-1", state: states.shift() ?? "SUCCEEDED" }) })
    const answer = await port.waitForStatement("work", "st-1", { untilMs: Number.MAX_SAFE_INTEGER }, new AbortController().signal)
    expect(answer.state).toBe("SUCCEEDED")
    expect(calls.map((item) => item.method)).toEqual(["waitForStatement", "getStatement", "getStatement", "getStatement"])
  })

  it("stops waiting at untilMs and returns the last answer", async () => {
    let now = 0
    const { port } = fakeDatabricks({ getStatement: () => ((now += 1000), { statementId: "st-1", state: "RUNNING" }) }, () => now)
    expect((await port.waitForStatement("work", "st-1", { untilMs: 3000 }, new AbortController().signal)).state).toBe("RUNNING")
    expect(now).toBe(3000)
  })

  it("carries retryAfterSec from a DatabricksError into the tool's result", () => {
    const error = new DatabricksError("RATE_LIMITED", undefined, undefined, undefined, { retryAfterSec: 12 })
    expect(error.retryAfterSec).toBe(12)
    expect(error.message).toBe(new DatabricksError("RATE_LIMITED").message)
    expect(errorResult(error)).toMatchObject({ state: "failed", error: "RATE_LIMITED", retryAfterSec: 12 })
    expect(Outputs.query.safeParse(errorResult(error)).success).toBe(true)
    expect(errorResult(new DatabricksError("RATE_LIMITED"))).not.toHaveProperty("retryAfterSec")
  })
})

describe("the contract's amendments for package A", () => {
  it("names the new Unity Catalog reads as unity-catalog operations under the scope the sign-in holds", () => {
    for (const operation of ["unity-catalog.connections.list", "unity-catalog.current-metastore-assignment.get", "unity-catalog.effective-permissions.get"] as const) {
      expect(OPERATIONS).toContain(operation)
      expect(SCOPE_OF[operation]).toBe("unity-catalog")
    }
  })

  it("gives every account an enforcement and every token its workspace host", async () => {
    const fake = fakeDeps()
    const account = fake.auth.account("work")
    expect(Enforcement.safeParse(account.enforcement).success).toBe(true)
    expect((await fake.auth.token("work", ["sql"], new AbortController().signal)).host).toBe(account.host)
    expect(ROLE_ENFORCEMENT_TEXT).toBe("SQL writes refused on what doctor checked; secret scopes and serving endpoints not checked; job runs use each job's Run as identity")
  })
})
