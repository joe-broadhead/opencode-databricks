// The plan store's semantics and package D's non-SQL plans (design §15.1 "Plans": single use, TTL, caller binding,
// PLAN_CHANGED, admin reason, and the run's idempotency token equal to the plan ID), against the documented Jobs API
// shapes in `fixtures/`.
import { describe, expect, it } from "vitest"
import type { Output } from "../../../src/domain/contract.js"
import { HANDLERS } from "../../../src/registry.js"
import { runTool } from "../../../src/tool-spec.js"
import { defaultRules, effectOf } from "../../../src/permissions.js"
import { RecordingPermission } from "../../fake/ports.js"
import { changeHarness, NOTEBOOK_PATH, recorded, RUNNING_WAREHOUSE, type ChangeHarness } from "./harness.js"

const plan = async (input: Record<string, unknown>, harness: ChangeHarness = changeHarness()): Promise<Output<"plan">> =>
  (await runTool("plan", input, harness.call(), harness.deps, HANDLERS)) as Output<"plan">
const commit = async (tool: "write" | "delete" | "share" | "export" | "run" | "admin", harness: ChangeHarness, planId: string, id = "call_commit") =>
  (await runTool(tool, { planId }, harness.call(id), harness.deps, HANDLERS)) as Record<string, unknown>

describe("the plan store", () => {
  it("is single use, bound to its caller, and expires after planTtlSeconds", async () => {
    const harness = changeHarness()
    const planned = await plan({ sql: "DELETE FROM main.s.t WHERE id = 1" }, harness)
    const id = planned.planId!
    expect(harness.deps.plans.peek(id)).toMatchObject({ used: false, plan: { category: "delete", account: "work", sessionId: "ses_test", agentId: "build" } })
    expect(await commit("delete", harness, id)).toMatchObject({ state: "ok" })
    expect(await commit("delete", harness, id, "call_2")).toMatchObject({ error: "PLAN_ALREADY_USED" })

    const other = await plan({ sql: "DELETE FROM main.s.t WHERE id = 1" }, harness)
    expect(await runTool("delete", { planId: other.planId! }, { ...harness.call("call_3"), sessionID: "ses_other" }, harness.deps, HANDLERS)).toMatchObject({ error: "PLAN_CALLER_MISMATCH" })
    expect(await runTool("delete", { planId: "pln_none" }, harness.call("call_4"), harness.deps, HANDLERS)).toMatchObject({ error: "PLAN_NOT_FOUND" })

    const expiring = await plan({ sql: "DELETE FROM main.s.t WHERE id = 1" }, harness)
    harness.clock.advance(300_000)
    expect(await commit("delete", harness, expiring.planId!, "call_5")).toMatchObject({ error: "PLAN_EXPIRED" })
  })

  it("refuses a plan committed with another category's tool, naming the right one, and consumes nothing", async () => {
    const harness = changeHarness()
    const planned = await plan({ sql: "GRANT SELECT ON TABLE main.s.t TO `team`" }, harness)
    expect(await commit("write", harness, planned.planId!)).toMatchObject({ error: "CATEGORY_MISMATCH", next: expect.stringContaining("databricks_share") })
    expect(harness.deps.plans.peek(planned.planId!)).toMatchObject({ used: false })
    expect(await commit("share", harness, planned.planId!, "call_2")).toMatchObject({ state: "ok" })
  })

  it("takes exactly one of sql, job, notebook and warehouse, and a SQL plan's params stay inside it", async () => {
    expect(await plan({})).toMatchObject({ error: "INPUT_INVALID" })
    expect(await plan({ sql: "DELETE FROM main.s.t WHERE id = 1", job: { jobId: 100 } })).toMatchObject({ error: "INPUT_INVALID" })
    expect(await plan({ job: { jobId: 100 }, params: [{ name: "v", value: 1 }] })).toMatchObject({ error: "INPUT_INVALID" })
    expect(await plan({ notebook: { path: NOTEBOOK_PATH }, warehouse: "wh-small" })).toMatchObject({ error: "INPUT_INVALID" })
  })
})

describe("a job run", () => {
  it("needs the jobs API family before any call", async () => {
    const harness = changeHarness({ features: [] })
    expect(await plan({ job: { jobId: 100 } }, harness)).toMatchObject({ error: "AUTH_SCOPE_MISSING", next: expect.stringContaining("features") })
    expect(harness.calls).toEqual([])
    expect(harness.api.requests).toEqual([])
  })

  it("previews the job's tasks and their compute, its timeout and what is billed separately, and sends nothing", async () => {
    const harness = changeHarness()
    const planned = await plan({ job: { jobId: 100 }, reason: "backfill" }, harness)
    expect(planned).toMatchObject({ state: "planned", category: "run", commitWith: "databricks_run", preview: { kind: "job", parsed: false } })
    const notes = planned.preview!.notes.join(" ")
    expect(notes).toMatch(/`nightly`/)
    expect(notes).toMatch(/`Orders_Ingest` on a job cluster of `Standard_DS3_v2` with 2 workers/)
    expect(notes).toMatch(/task timeout 1800s/)
    expect(notes).toMatch(/timeout_seconds 3600, which stops it/)
    expect(notes).toMatch(/billed separately/)
    expect(notes).toMatch(/idempotency_token/)
    expect(harness.statements()).toEqual([])
    harness.settle()
  })

  it("R5-M1: previews every documented kind of task compute, and never calls an unknown one serverless", async () => {
    const harness = changeHarness({
      jobSettings: {
        100: {
          jobId: 100,
          name: "nightly",
          creatorUserName: "user@example.com",
          timeoutSeconds: 3600,
          tasks: [
            { taskKey: "inline", compute: { kind: "job-cluster", nodeTypeId: "Standard_DS3_v2", numWorkers: 2 } },
            { taskKey: "shared", compute: { kind: "job-cluster", jobClusterKey: "shared_big", nodeTypeId: "i3.8xlarge", numWorkers: 40 } },
            { taskKey: "existing", compute: { kind: "existing", clusterId: "0923-164208-meows279" } },
            { taskKey: "sql", compute: { kind: "warehouse", warehouseId: "wh-small" } },
            { taskKey: "serverless", compute: { kind: "serverless" } },
            { taskKey: "mystery", compute: { kind: "unknown", reason: "a pipeline task runs on its pipeline's compute" } },
          ],
        },
      },
    })
    const notes = (await plan({ job: { jobId: 100 } }, harness)).preview!.notes.join(" ")
    expect(notes).toMatch(/`inline` on a job cluster of `Standard_DS3_v2` with 2 workers/)
    expect(notes).toMatch(/`shared` on a job cluster shared as `shared_big` of `i3.8xlarge` with 40 workers/)
    expect(notes).toMatch(/`existing` on the all-purpose cluster `0923-164208-meows279`/)
    expect(notes).toMatch(/`sql` on the SQL warehouse a Small serverless warehouse `bi-small` at about \$8\.40\/hour/)
    expect(notes).toMatch(/`serverless` on serverless compute/)
    expect(notes).toMatch(/`mystery` on compute not determined \(a pipeline task runs on its pipeline's compute\)/)
    expect(notes).not.toMatch(/`mystery` on serverless/)
  })

  it("R5-M1 (round 2): renders delegated, recursive and undetermined compute, and never calls one serverless", async () => {
    const harness = changeHarness({
      jobSettings: {
        100: {
          jobId: 100,
          name: "nightly",
          timeoutSeconds: 3600,
          tasks: [
            { taskKey: "each", compute: { kind: "for-each", compute: { kind: "job-cluster", nodeTypeId: "i3.8xlarge", numWorkers: 40 } } },
            { taskKey: "nested", compute: { kind: "for-each", compute: { kind: "for-each", compute: { kind: "existing", clusterId: "c-1" } } } },
            { taskKey: "child", compute: { kind: "job", jobId: 42 } },
            { taskKey: "guard", compute: { kind: "none", what: "a condition task needs no compute" } },
            { taskKey: "pipe", compute: { kind: "pipeline", pipelineId: "p-1" } },
            { taskKey: "future", compute: { kind: "unknown", reason: "its task type new_kind_task is not one this version knows" } },
          ],
        },
      },
    })
    const notes = (await plan({ job: { jobId: 100 } }, harness)).preview!.notes.join(" ")
    expect(notes).toMatch(/`each` on each iteration on a job cluster of `i3.8xlarge` with 40 workers/)
    expect(notes).toMatch(/`nested` on each iteration on each iteration on the all-purpose cluster `c-1`/)
    expect(notes).toMatch(/`child` on the compute of job 42/)
    expect(notes).toMatch(/`guard` on no compute \(a condition task needs no compute\)/)
    expect(notes).toMatch(/`pipe` on the pipeline's own compute \(`p-1`\)/)
    expect(notes).toMatch(/`future` on compute not determined \(its task type new_kind_task is not one this version knows\)/)
    expect(notes).not.toMatch(/`future` on serverless/)
  })

  it("says a job with no timeout has none, and names an all-purpose cluster", async () => {
    const harness = changeHarness({
      jobSettings: { 100: { jobId: 100, name: "nightly", timeoutSeconds: 0, tasks: [{ taskKey: "one", compute: { kind: "existing", clusterId: "0923-164208-meows279" } }] } },
    })
    const notes = (await plan({ job: { jobId: 100 } }, harness)).preview!.notes.join(" ")
    expect(notes).toMatch(/no timeout \(timeout_seconds 0\)/)
    expect(notes).toMatch(/the all-purpose cluster `0923-164208-meows279`/)
  })

  it("refuses a job it cannot see", async () => {
    expect(await plan({ job: { jobId: 999 } })).toMatchObject({ error: "NOT_FOUND", next: expect.stringContaining("databricks_jobs") })
  })

  it("commits through run-now with the plan id as the idempotency token and the plan's own parameters", async () => {
    const harness = changeHarness()
    const planned = await plan({ job: { jobId: 100, params: { day: "2026-11-17" } } }, harness)
    const id = planned.planId!
    expect(id.length).toBeLessThanOrEqual(64)
    const answer = await commit("run", harness, id)
    expect(answer).toMatchObject({ state: "running", runId: expect.any(Number), next: expect.stringContaining("databricks_jobs") })
    const requests = harness.api.requests.filter((request) => request.path === "/api/2.2/jobs/run-now")
    expect(requests).toHaveLength(1)
    expect(requests[0]!.body).toEqual({ job_id: 100, job_parameters: { day: "2026-11-17" }, idempotency_token: id })
    harness.settle()
  })
})

describe("a one-time notebook run", () => {
  it("carries runTimeoutSeconds, previews it, and puts this plan's id on the run", async () => {
    const harness = changeHarness({ options: { runTimeoutSeconds: 1800 } })
    const planned = await plan({ notebook: { path: NOTEBOOK_PATH, params: { day: "2026-11-17" } } }, harness)
    expect(planned).toMatchObject({ category: "run", preview: { kind: "notebook", targets: [{ name: NOTEBOOK_PATH, type: "NOTEBOOK", exists: true }] } })
    expect(planned.preview!.notes.join(" ")).toMatch(/timeout_seconds 1800/)
    expect(planned.preview!.notes.join(" ")).toMatch(/serverless/)
    const answer = await commit("run", harness, planned.planId!)
    expect(answer).toMatchObject({ state: "running", runId: expect.any(Number) })
    expect(String(answer.next)).toContain("1800-second timeout")
    const requests = harness.api.requests.filter((request) => request.path === "/api/2.2/jobs/runs/submit")
    expect(requests).toHaveLength(1)
    expect(requests[0]!.body).toMatchObject({
      idempotency_token: planned.planId,
      timeout_seconds: 1800,
      tasks: [{ task_key: "notebook", notebook_task: { notebook_path: NOTEBOOK_PATH, base_parameters: { day: "2026-11-17" } } }],
    })
    harness.settle()
  })

  it("says a path it cannot see would make runs/submit fail, and still plans it", async () => {
    const planned = await plan({ notebook: { path: "/Shared/missing" } })
    expect(planned).toMatchObject({ state: "planned", preview: { targets: [{ name: "/Shared/missing", exists: false }] } })
    expect(planned.preview!.notes.join(" ")).toMatch(/runs\/submit would fail/)
  })
})

describe("a warehouse edit plan", () => {
  it("previews each field, the rate it implies and its reason, and its commit edits the warehouse", async () => {
    const harness = changeHarness()
    expect(await plan({ warehouse: { id: "wh-small", edit: { size: "Medium" } } }, harness)).toMatchObject({ error: "ADMIN_REASON_REQUIRED" })
    const planned = await plan({ warehouse: { id: "wh-small", edit: { size: "Medium", autoStopMinutes: 5 } }, reason: "the nightly load needs more" }, harness)
    expect(planned).toMatchObject({ category: "admin", commitWith: "databricks_admin", preview: { kind: "warehouse", reason: "the nightly load needs more" } })
    const notes = planned.preview!.notes.join(" ")
    expect(notes).toMatch(/size Small → Medium/)
    expect(notes).toMatch(/autoStopMinutes 10 → 5/)
    expect(notes).toMatch(/about \$8\.40\/hour now and about \$16\.80\/hour after/)
    expect(notes).toMatch(/Committing re-reads the warehouse first/)
    const answer = await commit("admin", harness, planned.planId!)
    expect(answer).toMatchObject({ state: "ok", next: expect.stringContaining("databricks_warehouses") })
    const edits = harness.calls.filter((entry) => entry.method === "editWarehouse")
    expect(edits).toHaveLength(1)
    expect(edits[0]!.args.slice(0, 3)).toEqual(["work", "wh-small", { clusterSize: "Medium", autoStopMins: 5 }])
    // The commit asserts its own action on the operation it uses, then the warehouse itself (design §10.1, R4-M2).
    expect(harness.permission.requests.filter((request) => request.action === "databricks.admin").map((request) => request.resource)).toEqual(["work:sql.warehouses.edit", "work:warehouse:wh-small"])
    expect(harness.statements()).toEqual([])
  })

  it("is PLAN_CHANGED when the warehouse was resized between the preview and the commit", async () => {
    const harness = changeHarness()
    const planned = await plan({ warehouse: { id: "wh-small", edit: { size: "Medium" } }, reason: "grow" }, harness)
    harness.setWarehouse({ ...RUNNING_WAREHOUSE, clusterSize: "Large" })
    expect(await commit("admin", harness, planned.planId!)).toMatchObject({ error: "PLAN_CHANGED", message: expect.stringContaining("changed since the plan was made") })
    expect(harness.calls.filter((entry) => entry.method === "editWarehouse")).toEqual([])
  })

  it("R4-M2 (W1): a person's rule on the warehouse refuses the edit, and nothing is sent", async () => {
    const rules = [{ action: "*", resource: "*", effect: "allow" as const }, ...defaultRules("all"), { action: "databricks.admin", resource: "work:warehouse:wh-small", effect: "deny" as const }]
    const permission = new RecordingPermission((request) => (effectOf(rules, request.action, request.resource) === "deny" ? "deny" : "allow"))
    const harness = changeHarness({ permission })
    const planned = await plan({ warehouse: { id: "wh-small", edit: { size: "4X-Large" } }, reason: "grow" }, harness)
    await expect(commit("admin", harness, planned.planId!)).rejects.toThrow(/denied: databricks.admin on work:warehouse:wh-small/)
    expect(harness.calls.filter((entry) => entry.method === "editWarehouse")).toEqual([])
    expect(harness.calls.filter((entry) => entry.method === "getWarehouse")).toHaveLength(1) // the plan's own read only
  })

  it("LOW 2: autoStopMinutes 0 is previewed as never auto-stopping", async () => {
    const harness = changeHarness()
    const planned = await plan({ warehouse: { id: "wh-small", edit: { autoStopMinutes: 0 } }, reason: "keep it warm" }, harness)
    expect(planned.preview!.notes.join(" ")).toMatch(/never auto-stops: it bills until someone stops it/)
  })

  it("refuses a statement_timeout in an edit, which the edit body cannot carry", async () => {
    const harness = changeHarness()
    expect(await plan({ warehouse: { id: "wh-small", edit: { statementTimeoutSeconds: 600 } }, reason: "timeout" }, harness)).toMatchObject({ error: "INPUT_INVALID", message: expect.stringContaining("statementTimeoutSeconds") })
    expect(harness.calls.filter((entry) => entry.method === "editWarehouse")).toEqual([])
  })

  it("is PLAN_CHANGED when the job's settings changed after the preview", async () => {
    const harness = changeHarness()
    const planned = await plan({ job: { jobId: 100 } }, harness)
    harness.jobSettings.set(100, { jobId: 100, name: "nightly", timeoutSeconds: 60, tasks: [] })
    expect(await commit("run", harness, planned.planId!)).toMatchObject({ error: "PLAN_CHANGED", message: expect.stringContaining("settings changed") })
    expect(harness.api.requests.filter((request) => request.path === "/api/2.2/jobs/run-now")).toEqual([])
  })

  it("refuses an edit that changes nothing, and one whose cluster bounds cross", async () => {
    expect(await plan({ warehouse: { id: "wh-small", edit: { size: "Small" } }, reason: "same" })).toMatchObject({ error: "INPUT_INVALID", message: expect.stringContaining("changes nothing") })
    expect(await plan({ warehouse: { id: "wh-small", edit: { minClusters: 3, maxClusters: 1 } }, reason: "crossed" })).toMatchObject({ error: "INPUT_INVALID" })
  })
})

describe("drift after a commit", () => {
  it("reports a recorded type outside the category's set as a warning and records it", async () => {
    const harness = changeHarness({ history: [recorded({ statementId: "ddl-1", statementType: "DROP" })] })
    harness.api.state.statements.set("*", () => ({ statement_id: "ddl-1", status: { state: "SUCCEEDED" } }))
    const planned = await plan({ sql: "INSERT INTO main.s.t SELECT 1" }, harness)
    const answer = await commit("write", harness, planned.planId!)
    expect(answer).toMatchObject({ state: "ok", warnings: [{ code: "CLASSIFICATION_DRIFT" }] })
  })
})
