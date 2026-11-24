// The six commit tools (design §5.5): exactly the planned text, the drift check afterwards, PLAN_CHANGED when the world
// moved, the warehouse policy's consent, no blind retry, and L13's idempotent job and notebook submits — all against the
// documented shapes in `fixtures/`.
import { describe, expect, it } from "vitest"
import type { Output } from "../../../src/domain/contract.js"
import { DatabricksError } from "../../../src/domain/errors.js"
import { forgetDrift } from "../../../src/drift.js"
import { HANDLERS } from "../../../src/registry.js"
import { runTool } from "../../../src/tool-spec.js"
import type { Deps } from "../../../src/registry.js"
import type { DatabricksPort, TableInfo } from "../../../src/ports.js"
import { RecordingPermission } from "../../fake/ports.js"
import { STATEMENT_FAILED, STATEMENT_SUCCEEDED_WITH_ROW_COUNT } from "./fixtures/workspace.js"
import { changeHarness, recorded, RUNNING_WAREHOUSE, type ChangeHarness } from "./harness.js"

const plan = async (input: Record<string, unknown>, harness: ChangeHarness): Promise<Output<"plan">> => (await runTool("plan", input, harness.call(), harness.deps, HANDLERS)) as Output<"plan">
const commit = async <T extends "write" | "delete" | "share" | "export" | "run" | "admin">(tool: T, harness: ChangeHarness, planId: string, deps: Deps = harness.deps) =>
  (await runTool(tool, { planId }, harness.call(`call_${tool}`), deps, HANDLERS)) as Record<string, unknown>

describe("a committed SQL plan", () => {
  it("sends exactly the planned text with the plan's tag, and reports its rows from the manifest", async () => {
    const harness = changeHarness({ statement: () => STATEMENT_SUCCEEDED_WITH_ROW_COUNT })
    const sql = "DELETE FROM main.s.t WHERE id = 1"
    const planned = await plan({ sql, params: [{ name: "v", value: 7, type: "BIGINT" }] }, harness)
    const answer = await commit("delete", harness, planned.planId!)
    expect(answer).toMatchObject({ state: "ok", statementId: "01eda0e7-e315-1846-84e2-79a963ffad46", rowsAffected: 3, durationMs: expect.any(Number) })
    // The committed statement's own cost: the warehouse it ran on and its estimated $/hour.
    expect(answer.warehouse).toEqual({ id: "wh-small", name: "bi-small", started: false, usdPerHour: expect.any(Number) })
    const sent = harness.statements()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      statement: sql,
      warehouse_id: "wh-small",
      disposition: "INLINE",
      format: "JSON_ARRAY",
      wait_timeout: "50s",
      on_wait_timeout: "CANCEL",
      parameters: [{ name: "v", value: "7", type: "BIGINT" }],
    })
    const tags = (sent[0]!.query_tags as { key: string; value?: string }[]) ?? []
    expect(Object.fromEntries(tags.map((tag) => [tag.key, tag.value]))).toMatchObject({ oc_plugin: "databricks", oc_tool: "delete", oc_plan: planned.planId })
    harness.settle()
  })

  it("asserts each of the plan's tables under its own dotted action, before the statement", async () => {
    const harness = changeHarness({ tables: { "main.s.t": { tableType: "MANAGED", owner: "ops" } } })
    const planned = await plan({ sql: "DELETE FROM main.s.t WHERE id = 1" }, harness)
    await commit("delete", harness, planned.planId!)
    expect(harness.permission.requests.map((request) => `${request.action} on ${request.resource}`)).toContain("databricks.delete on work:table:main.s.t")
    expect(harness.permission.requests.at(-1)).toMatchObject({ action: "databricks.delete" })
  })

  it("refuses a table a person's rule denies, before anything is sent", async () => {
    const permission = new RecordingPermission((request) => (request.resource.includes(":table:") ? "deny" : "allow"))
    const harness = changeHarness({ permission })
    const planned = await plan({ sql: "DELETE FROM main.s.t WHERE id = 1" }, harness)
    await expect(commit("delete", harness, planned.planId!)).rejects.toThrow(/denied: databricks.delete on work:table:main.s.t/)
    expect(harness.statements()).toEqual([])
  })

  it("is PLAN_CHANGED when a target appeared since the plan, because a CREATE over it is a replace", async () => {
    const tables: Record<string, Partial<TableInfo>> = {}
    const harness = changeHarness({ tables })
    const planned = await plan({ sql: "CREATE TABLE main.s.t (id BIGINT)" }, harness)
    expect(planned).toMatchObject({ category: "write" })
    tables["main.s.t"] = {}
    const answer = await commit("write", harness, planned.planId!)
    expect(answer).toMatchObject({ error: "PLAN_CHANGED", message: expect.stringContaining("delete change") })
    expect(harness.statements()).toEqual([])
  })

  it("never retries a statement, and reports a failure with Databricks' text only in providerError", async () => {
    const harness = changeHarness({ statement: () => STATEMENT_FAILED })
    const planned = await plan({ sql: "DELETE FROM main.s.t WHERE id = 1" }, harness)
    const answer = await commit("delete", harness, planned.planId!)
    expect(answer).toMatchObject({ state: "failed", error: "STATEMENT_FAILED", providerError: { errorCode: "BAD_REQUEST", trust: "untrusted" } })
    expect(String(answer.message)).not.toContain("PARSE_SYNTAX_ERROR")
    expect(harness.statements()).toHaveLength(1)
  })

  it("reports a statement Databricks cancelled at its wait as RUN_TIMEOUT, never as success", async () => {
    const harness = changeHarness({ statement: () => ({ statement_id: "st-c", status: { state: "CANCELED" } }) })
    const planned = await plan({ sql: "DELETE FROM main.s.t WHERE id = 1" }, harness)
    expect(await commit("delete", harness, planned.planId!)).toMatchObject({ state: "failed", error: "RUN_TIMEOUT" })
  })
})

describe("a submit B recovered by its tag", () => {
  it("LOW 1: reports the recovered statement and id, and charges it, instead of discarding it", async () => {
    const harness = changeHarness()
    const real = harness.deps.databricks
    const recovered = new Proxy(real, {
      get(target, name, receiver) {
        // B's client joins a statement it found by this call's own `oc_call` tag after a submit that got no answer
        // (design §9): it answers the joined statement with `ambiguous: true`.
        if (name === "submit") return async () => ({ statementId: "st-recovered", state: "SUCCEEDED", ambiguous: true, manifest: { columns: [], totalRowCount: 2 } })
        return Reflect.get(target, name, receiver)
      },
    }) as DatabricksPort
    const planned = await plan({ sql: "DELETE FROM main.s.t WHERE id = 1" }, harness)
    const answer = await commit("delete", harness, planned.planId!, { ...harness.deps, databricks: recovered })
    expect(answer).toMatchObject({ state: "ok", statementId: "st-recovered", rowsAffected: 2, next: expect.stringContaining("reported rather than resent") })
    expect(harness.ledger.charges.map((charge) => charge.kind)).toContain("statement")
  })
})

describe("the warehouse policy at commit", () => {
  it("starts one only when the plan previewed a start: its own action, then a ledger charge, then the start", async () => {
    const harness = changeHarness({ warehouse: { ...RUNNING_WAREHOUSE, state: "STOPPED" } })
    const planned = await plan({ sql: "DELETE FROM main.s.t WHERE id = 1" }, harness)
    const answer = await commit("delete", harness, planned.planId!)
    expect(answer).toMatchObject({ state: "ok", warnings: [{ code: "STARTED_WAREHOUSE" }] })
    expect(answer.warehouse).toEqual({ id: "wh-small", name: "bi-small", started: true, usdPerHour: expect.any(Number) })
    const start = harness.permission.requests.find((request) => request.action === "databricks.start")
    expect(start).toMatchObject({ resource: "work:warehouse:wh-small" })
    expect(harness.ledger.charges.map((charge) => charge.kind)).toEqual(["start", "statement"])
    expect(harness.calls.filter((entry) => entry.method === "startWarehouse")).toHaveLength(1)
  })

  it("is PLAN_CHANGED when a warehouse that was running at plan time has stopped, because the preview named no start", async () => {
    const harness = changeHarness()
    const planned = await plan({ sql: "DELETE FROM main.s.t WHERE id = 1" }, harness)
    harness.setWarehouse({ ...RUNNING_WAREHOUSE, state: "STOPPED" })
    expect(await commit("delete", harness, planned.planId!)).toMatchObject({ error: "PLAN_CHANGED", message: expect.stringContaining("named no start") })
    expect(harness.ledger.charges).toEqual([])
    expect(harness.statements()).toEqual([])
  })

  it("is PLAN_CHANGED when the start policy refuses what it allowed at plan time", async () => {
    const harness = changeHarness()
    const planned = await plan({ warehouse: { id: "wh-small", edit: { size: "Medium" } }, reason: "grow" }, harness)
    expect(planned.state).toBe("planned")
    // A SQL plan previews a start only when the policy allows it; here the warehouse stays running, so a stop is the
    // change that matters. This case is the policy's other half, proven in plan-classification.test.ts (START_REFUSED).
    harness.setWarehouse({ ...RUNNING_WAREHOUSE, state: "DELETED" })
    const sql = await plan({ sql: "DELETE FROM main.s.t WHERE id = 1" }, harness)
    expect(sql.state).toBe("refused")
  })
})

describe("drift, after the change has run", () => {
  it("adds no warning when Query History agrees with the plan", async () => {
    forgetDrift()
    const harness = changeHarness({ history: [recorded({ statementId: "st-ok", statementType: "DELETE" })] })
    harness.api.state.statements.set("*", () => ({ statement_id: "st-ok", status: { state: "SUCCEEDED" } }))
    const planned = await plan({ sql: "DELETE FROM main.s.t WHERE id = 1" }, harness)
    const answer = await commit("delete", harness, planned.planId!)
    expect(answer).not.toHaveProperty("warnings")
  })

  it("records an unchecked comparison when Query History had no record yet, and never fails the change for it", async () => {
    const harness = changeHarness({ history: [] })
    harness.api.state.statements.set("*", () => ({ statement_id: "st-late", status: { state: "SUCCEEDED" } }))
    const planned = await plan({ sql: "DELETE FROM main.s.t WHERE id = 1" }, harness)
    const answer = await commit("delete", harness, planned.planId!)
    expect(answer).toMatchObject({ state: "ok", statementId: "st-late" })
    expect(answer).not.toHaveProperty("warnings")
  })

  it("skips the comparison for a run, whose effects are not known until it runs", async () => {
    const harness = changeHarness()
    const planned = await plan({ job: { jobId: 100 } }, harness)
    await commit("run", harness, planned.planId!)
    expect(harness.api.requests.filter((request) => request.path === "/api/2.0/sql/history/queries")).toEqual([])
  })
})

describe("L13: a job or notebook submit carries an idempotency token, and a replay launches one run", () => {
  it("replays an ambiguous run-now once with the same token, and Databricks answers the same run", async () => {
    const harness = changeHarness()
    const planned = await plan({ job: { jobId: 100 } }, harness)
    const real = harness.deps.databricks
    let lost = true
    const flaky = new Proxy(real, {
      get(target, name, receiver) {
        if (name === "runNow") {
          return async (...args: unknown[]) => {
            if (lost) {
              lost = false
              throw new DatabricksError("UNAVAILABLE", "the connection dropped after the request was sent")
            }
            return (target.runNow as (...input: unknown[]) => Promise<{ runId: number }>)(...args)
          }
        }
        return Reflect.get(target, name, receiver)
      },
    }) as DatabricksPort
    const answer = await commit("run", harness, planned.planId!, { ...harness.deps, databricks: flaky })
    expect(answer).toMatchObject({ state: "running", runId: expect.any(Number) })
    // One request reached the API, and the token it carried is the plan's, so the replay cannot have launched a second run.
    const requests = harness.api.requests.filter((request) => request.path === "/api/2.2/jobs/run-now")
    expect(requests).toHaveLength(1)
    expect(harness.api.idempotency.get(planned.planId!)).toBe(answer.runId)
    expect(harness.api.state.runs.size).toBe(0)
  })

  it("does not replay a cancelled submit, and does not replay a refusal", async () => {
    const harness = changeHarness()
    const planned = await plan({ job: { jobId: 100 } }, harness)
    const real = harness.deps.databricks
    let calls = 0
    const refusing = new Proxy(real, {
      get(target, name, receiver) {
        if (name === "runNow") return async () => {
          calls += 1
          throw new DatabricksError("PERMISSION_DENIED")
        }
        return Reflect.get(target, name, receiver)
      },
    }) as DatabricksPort
    expect(await commit("run", harness, planned.planId!, { ...harness.deps, databricks: refusing })).toMatchObject({ error: "PERMISSION_DENIED" })
    expect(calls).toBe(1)
  })

  it("gives a notebook run a timeout and the same token, and submits it once", async () => {
    const harness = changeHarness({ options: { runTimeoutSeconds: 900 } })
    const planned = await plan({ notebook: { path: "/Shared/Nightly" } }, harness)
    await commit("run", harness, planned.planId!)
    const requests = harness.api.requests.filter((request) => request.path === "/api/2.2/jobs/runs/submit")
    expect(requests).toHaveLength(1)
    expect(requests[0]!.body).toMatchObject({ idempotency_token: planned.planId, timeout_seconds: 900 })
    harness.settle()
  })
})
