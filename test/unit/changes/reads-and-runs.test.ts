// `databricks_jobs`, `databricks_workspace`, `databricks_cancel` and `databricks_stop` (design §4, §7): free reads over
// the documented Jobs, Workspace, Files and Query History shapes, the two free cancels, and a stop that never ends
// another user's work.
import { describe, expect, it } from "vitest"
import type { Output } from "../../../src/domain/contract.js"
import { DatabricksError } from "../../../src/domain/errors.js"
import { HANDLERS } from "../../../src/registry.js"
import { runTool } from "../../../src/tool-spec.js"
import type { DatabricksPort } from "../../../src/ports.js"
import { NOTEBOOK_PATH, NOTEBOOK_SOURCE, RUNNING_WAREHOUSE, changeHarness, recorded, type ChangeHarness } from "./harness.js"
import { cutBytes, OUTPUT_LIMIT } from "../../../src/tools/changes/jobs.js"

const run = async <T extends "jobs" | "workspace" | "cancel" | "stop">(tool: T, input: Record<string, unknown>, harness: ChangeHarness, deps = harness.deps) =>
  (await runTool(tool, input, harness.call(`call_${tool}`), deps, HANDLERS)) as Output<T>

const withRuns = (harness: ChangeHarness) => {
  harness.api.state.runs.set(7, {
    run_id: 7,
    job_id: 100,
    run_name: "nightly run",
    creator_user_name: "user@example.com",
    run_type: "JOB_RUN",
    state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" },
    start_time: 1_700_000_000_000,
    end_time: 1_700_000_100_000,
    tasks: [{ task_key: "Orders_Ingest", state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" }, run_duration: 100_000 }],
  })
  return harness
}

describe("databricks_jobs", () => {
  it("lists jobs with their latest run's state, in one page of reads", async () => {
    const harness = withRuns(changeHarness())
    const answer = await run("jobs", {}, harness)
    expect(answer).toMatchObject({ state: "ok", trust: "untrusted", jobs: [{ id: 100, name: "nightly", lastRunState: "SUCCESS" }] })
    expect(harness.api.paths()).toEqual(["GET /api/2.2/jobs/list", "GET /api/2.2/jobs/runs/list"])
    harness.settle()
  })

  it("lists one job's runs, and one run's tasks", async () => {
    const harness = withRuns(changeHarness())
    expect(await run("jobs", { jobId: 100 }, harness)).toMatchObject({ runs: [{ id: 7, state: "SUCCESS", durationMs: 100_000 }] })
    expect(await run("jobs", { runId: 7, output: true }, harness)).toMatchObject({
      run: { id: 7, tasks: [{ key: "Orders_Ingest", state: "SUCCESS", durationMs: 100_000 }], output: "Cell 1: 2 rows" },
    })
    expect(harness.api.paths()).toContain("GET /api/2.2/jobs/runs/get-output")
    harness.settle()
  })

  it("cuts run output at 8 KiB, with the marker, because it is untrusted text", async () => {
    const long = "x".repeat(OUTPUT_LIMIT + 10)
    const cut = cutBytes(long, OUTPUT_LIMIT)
    expect(cut.cut).toBe(true)
    expect(cut.text.endsWith(`…[cut at ${OUTPUT_LIMIT} bytes]`)).toBe(true)
    expect(Buffer.byteLength(cut.text, "utf8")).toBeLessThan(OUTPUT_LIMIT + 40)
    expect(cutBytes("short", OUTPUT_LIMIT)).toEqual({ text: "short", cut: false })
  })

  it("needs the jobs API family before any call", async () => {
    const harness = changeHarness({ features: [] })
    expect(await run("jobs", {}, harness)).toMatchObject({ error: "AUTH_SCOPE_MISSING" })
    expect(harness.api.requests).toEqual([])
    expect(harness.calls).toEqual([])
  })
})

describe("databricks_workspace", () => {
  it("lists a folder, exports a notebook as source, and lists a volume path", async () => {
    const harness = changeHarness()
    expect(await run("workspace", { path: "/Shared" }, harness)).toMatchObject({ items: [{ path: NOTEBOOK_PATH, kind: "NOTEBOOK" }] })
    expect(await run("workspace", { path: NOTEBOOK_PATH, export: true }, harness)).toMatchObject({ source: NOTEBOOK_SOURCE, items: [{ path: NOTEBOOK_PATH }] })
    expect(await run("workspace", { path: "/Volumes/main/s/v" }, harness)).toMatchObject({ items: [{ path: "/Volumes/main/s/v/a.parquet", kind: "FILE", size: 12 }] })
    expect(harness.api.paths()).toEqual(expect.arrayContaining(["GET /api/2.0/workspace/list", "GET /api/2.0/workspace/export", "GET /api/2.0/fs/directories/Volumes/main/s/v"]))
    harness.settle()
  })

  it("cuts a notebook's source at 32 KiB and says so", async () => {
    const harness = changeHarness()
    harness.api.state.notebooks.set(NOTEBOOK_PATH, "y".repeat(32 * 1024 + 1))
    const answer = await run("workspace", { path: NOTEBOOK_PATH, export: true }, harness)
    expect(answer.cut).toBe(true)
    expect(answer.source).toMatch(/…\[cut at 32768 bytes\]$/)
  })

  it("refuses an export of something that is not a notebook", async () => {
    const harness = changeHarness()
    expect(await run("workspace", { path: "/Shared", export: true }, harness)).toMatchObject({ error: "INPUT_INVALID", next: expect.stringContaining("notebook's own path") })
    expect(harness.api.requests.filter((request) => request.path === "/api/2.0/workspace/export")).toEqual([])
  })

  it("needs the API family the path uses", async () => {
    const harness = changeHarness({ features: ["jobs"] })
    expect(await run("workspace", { path: "/Users" }, harness)).toMatchObject({ error: "AUTH_SCOPE_MISSING", next: expect.stringContaining("workspace") })
    const files = changeHarness({ features: ["workspace"] })
    expect(await run("workspace", { path: "/Volumes/main/s/v" }, files)).toMatchObject({ error: "AUTH_SCOPE_MISSING", next: expect.stringContaining("files") })
    expect(harness.api.requests).toEqual([])
  })
})

describe("databricks_cancel", () => {
  it("cancels a statement through its own free endpoint", async () => {
    const harness = changeHarness({ history: [recorded({ statementId: "st-1", userId: 42, status: "RUNNING" })] })
    expect(await run("cancel", { statementId: "st-1" }, harness)).toMatchObject({ state: "ok", cancelled: "statement st-1" })
    expect(harness.api.paths()).toEqual(["GET /api/2.0/sql/history/queries", "POST /api/2.0/sql/statements/st-1/cancel"])
    expect(harness.permission.requests[0]).toMatchObject({ action: "databricks.cancel", resource: "work:sql.statements.get" })
    harness.settle()
  })

  it("cancels a run through runs/cancel, with the jobs operation, and says the cancel is asynchronous", async () => {
    const harness = withRuns(changeHarness())
    const answer = await run("cancel", { runId: 7 }, harness)
    expect(answer).toMatchObject({ state: "ok", cancelled: "run 7", next: expect.stringContaining("asynchronously") })
    expect(harness.api.paths()).toEqual(["GET /api/2.2/jobs/runs/get", "POST /api/2.2/jobs/runs/cancel"])
    expect(harness.permission.requests[0]).toMatchObject({ action: "databricks.cancel", resource: "work:jobs.runs.cancel" })
    harness.settle()
  })

  it("refuses a statement that is not this identity's, and never sends the cancel", async () => {
    const harness = changeHarness({ history: [recorded({ statementId: "st-1", userId: 99, status: "RUNNING" })] })
    expect(await run("cancel", { statementId: "st-1" }, harness)).toMatchObject({ error: "STOP_NOT_PERMITTED", next: expect.stringContaining("/databricks-cleanup") })
    expect(harness.api.paths()).toEqual(["GET /api/2.0/sql/history/queries"])
  })

  it("refuses a statement it cannot attribute, and one with no record at all", async () => {
    const unattributable = changeHarness({ history: [recorded({ statementId: "st-1", userId: 42 })].map((record) => ({ ...record, user_id: undefined })) })
    expect(await run("cancel", { statementId: "st-1" }, unattributable)).toMatchObject({ error: "STOP_NOT_PERMITTED" })
    const missing = changeHarness({ history: [] })
    expect(await run("cancel", { statementId: "st-9" }, missing)).toMatchObject({ error: "STOP_NOT_PERMITTED" })
    expect(missing.api.paths()).toEqual(["GET /api/2.0/sql/history/queries"])
  })

  it("refuses a run another user created, and one with no creator", async () => {
    const foreign = withRuns(changeHarness())
    foreign.api.state.runs.set(7, { ...foreign.api.state.runs.get(7)!, creator_user_name: "someone@example.com" })
    expect(await run("cancel", { runId: 7 }, foreign)).toMatchObject({ error: "STOP_NOT_PERMITTED" })
    expect(foreign.api.paths()).not.toContain("POST /api/2.2/jobs/runs/cancel")
    const nameless = withRuns(changeHarness())
    nameless.api.state.runs.set(7, { ...nameless.api.state.runs.get(7)!, creator_user_name: undefined })
    expect(await run("cancel", { runId: 7 }, nameless)).toMatchObject({ error: "STOP_NOT_PERMITTED" })
  })

  it("takes exactly one id, and needs the jobs family for a run", async () => {
    const harness = changeHarness()
    expect(await run("cancel", {}, harness)).toMatchObject({ error: "INPUT_INVALID" })
    expect(await run("cancel", { statementId: "st-1", runId: 7 }, harness)).toMatchObject({ error: "INPUT_INVALID" })
    const noJobs = changeHarness({ features: [] })
    expect(await run("cancel", { runId: 7 }, noJobs)).toMatchObject({ error: "AUTH_SCOPE_MISSING" })
  })
})

describe("databricks_stop", () => {
  it("sends nothing for a warehouse that is already stopped", async () => {
    const harness = changeHarness({ warehouse: { ...RUNNING_WAREHOUSE, state: "STOPPED" } })
    expect(await run("stop", { warehouse: "wh-small" }, harness)).toMatchObject({ state: "ok", stopped: false })
    expect(harness.api.requests).toEqual([])
    expect(harness.calls.filter((entry) => entry.method === "stopWarehouse")).toEqual([])
  })

  it("refuses while another user's statement is running, and names it", async () => {
    const harness = changeHarness({ history: [recorded({ statementId: "other-1", statementType: "SELECT", userId: 99, status: "RUNNING" })] })
    const answer = await run("stop", { warehouse: "wh-small" }, harness)
    expect(answer).toMatchObject({ error: "STOP_NOT_PERMITTED", message: expect.stringContaining("not this identity's") })
    expect(harness.calls.filter((entry) => entry.method === "stopWarehouse")).toEqual([])
  })

  it("stops when only this identity's statements were running", async () => {
    const harness = changeHarness({ history: [recorded({ statementId: "mine-1", statementType: "SELECT", userId: 42, status: "FINISHED" })] })
    expect(await run("stop", { warehouse: "wh-small" }, harness)).toMatchObject({ state: "ok", stopped: true, next: expect.stringContaining("starts it again") })
    expect(harness.calls.filter((entry) => entry.method === "stopWarehouse")).toHaveLength(1)
  })

  it("refuses when Query History has more statements than one call can see", async () => {
    const many = Array.from({ length: 1001 }, (_, index) => recorded({ statementId: `s-${index}`, userId: 42 }))
    const harness = changeHarness({ history: many })
    expect(await run("stop", { warehouse: "wh-small" }, harness)).toMatchObject({ error: "STOP_NOT_PERMITTED", message: expect.stringContaining("more statements") })
    expect(harness.calls.filter((entry) => entry.method === "stopWarehouse")).toEqual([])
  })

  it("maps a refused stop to STOP_NOT_PERMITTED, because Can manage is what stopping needs", async () => {
    const harness = changeHarness()
    const refusing = new Proxy(harness.deps.databricks, {
      get(target, name, receiver) {
        if (name === "stopWarehouse") return async () => Promise.reject(new DatabricksError("PERMISSION_DENIED"))
        return Reflect.get(target, name, receiver)
      },
    }) as DatabricksPort
    expect(await run("stop", { warehouse: "wh-small" }, harness, { ...harness.deps, databricks: refusing })).toMatchObject({ error: "STOP_NOT_PERMITTED", message: expect.stringContaining("Can manage") })
  })
})
