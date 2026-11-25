// The **real** client (package B's `src/process/client.ts`) against the documented fake, for the calls package D relies
// on. A test double of the client's mapping can agree with its own fixtures; this file cannot: every request the client
// builds is handed to `DocumentedApi`, which refuses a wrong method, path, field or documented constraint (the review of
// #7's M3). A wrong field in the client — `notebook_params` where Jobs API 2.2 documents `job_parameters` — fails here.
import { describe, expect, it } from "vitest"
import type { StatementRequest } from "../../../src/ports.js"
import { createDatabricksClient } from "../../../src/process/client.js"
import { call as fakeCall, FakeAuth, FakeReads, MemoryLedger, RecordingPermission } from "../../fake/ports.js"
import { createPlanStore } from "../../../src/domain/plans.js"
import { loadOptions } from "../../../src/options.js"
import type { Deps } from "../../../src/registry.js"
import { HANDLERS } from "../../../src/registry.js"
import { runTool } from "../../../src/tool-spec.js"
import { accountOf, fakeAuth } from "../runtime/support.js"
import { startFakeDatabricks } from "../../fake/databricks-server.js"
import { DocumentedApi, historyRecord } from "./fixtures/api.js"
import { STATEMENT_SUCCEEDED_NO_RESULT } from "./fixtures/workspace.js"

/** A fetch that hands every request to the documented fake, and 404s one no reference page documents. */
function documentedFetch(api: DocumentedApi) {
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? "GET").toUpperCase()
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    const query = Object.fromEntries(url.searchParams.entries())
    const path = url.pathname
    if (method === "POST" && path === "/api/2.2/jobs/run-now") return reply(api.runNow(body ?? {}))
    if (method === "POST" && path === "/api/2.2/jobs/runs/submit") return reply(api.submitRun(body ?? {}))
    if (method === "POST" && path === "/api/2.2/jobs/runs/cancel") return reply(api.cancelRun(Number((body ?? {}).run_id)))
    if (method === "GET" && path === "/api/2.2/jobs/runs/get") return reply(api.getRun(Number(query.run_id)))
    if (method === "GET" && path === "/api/2.2/jobs/list") return reply(api.listJobs({ ...(query.limit ? { limit: Number(query.limit) } : {}), ...(query.page_token ? { page_token: query.page_token } : {}) }))
    if (method === "GET" && path === "/api/2.2/jobs/runs/list") return reply(api.listRuns({ ...(query.job_id ? { job_id: Number(query.job_id) } : {}), ...(query.limit ? { limit: Number(query.limit) } : {}) }))
    if (method === "POST" && path === "/api/2.0/sql/statements") return reply(api.executeStatement(body ?? {}))
    const cancel = /^\/api\/2\.0\/sql\/statements\/([^/]+)\/cancel$/u.exec(path)
    if (method === "POST" && cancel) {
      api.cancelStatement(decodeURIComponent(cancel[1]!))
      return reply(null, 200)
    }
    if (method === "GET" && path === "/api/2.0/sql/history/queries") return reply(api.history({ ...(query.max_results ? { maxResults: Number(query.max_results) } : {}) }))
    api.note(`${method} ${path} is not a route any reference page documents (the real client asked for it)`)
    return reply({ error: { error_code: "NOT_FOUND" } }, 404)
  }
}

/** The real client over the documented fake, and the fake's account (its auth is this repository's fake auth). */
function real() {
  const api = new DocumentedApi({
    jobs: new Map([[100, { name: "nightly" }]]),
    runs: new Map([[7, { run_id: 7, job_id: 100, creator_user_name: "user@example.com", state: { life_cycle_state: "RUNNING" }, start_time: 1_700_000_000_000, tasks: [] }]]),
    workspace: new Map(),
    notebooks: new Map(),
    directories: new Map(),
    statements: new Map([["*", () => STATEMENT_SUCCEEDED_NO_RESULT]]),
    history: [historyRecord({ statementId: "st-1", userId: 42 })],
  })
  // The scopes the calls below need: the fake auth refuses a call whose scope the sign-in does not carry.
  const granted = ["sql", "unity-catalog", "query-history", "jobs", "workspace", "files", "openid", "email", "profile", "offline_access"]
  const auth = new FakeAuth([{ alias: "work", mode: "interactive", host: "https://fake-workspace.cloud.databricks.com", cloud: "aws", features: ["jobs", "workspace", "files"], warehouse: "wh-small", enforcement: "identity" }], granted)
  const port = createDatabricksClient({ auth, fetch: documentedFetch(api) })
  const signal = new AbortController().signal
  return { api, port, signal }
}

describe("the real client against the documented fake", () => {
  // Jobs API 2.2 `run-now` documents `job_parameters` and has no `notebook_params`
  // (https://docs.databricks.com/api/jobs/v2/run-now.md); a regression to `notebook_params` fails here.
  it("run-now: the job's parameters go in `job_parameters`, with the token", async () => {
    const { api, port, signal } = real()
    const answer = await port.runNow("work", { jobId: 100, params: { day: "2026-11-18" }, idempotencyToken: "pln_8f018174-4792-40d5-bcbc-3e6a527352c8" }, signal)
    expect(answer.runId).toBeTypeOf("number")
    expect(api.requests.filter((request) => request.path === "/api/2.2/jobs/run-now")[0]!.body).toEqual({
      job_id: 100,
      job_parameters: { day: "2026-11-18" },
      idempotency_token: "pln_8f018174-4792-40d5-bcbc-3e6a527352c8",
    })
    api.mustNotReject()
  })

  it("runs/submit: a one-time notebook with its timeout and token", async () => {
    const { api, port, signal } = real()
    const answer = await port.submitRun("work", { notebookPath: "/Shared/Nightly", params: { day: "2026-11-18" }, idempotencyToken: "pln_x", timeoutSeconds: 3600 }, signal)
    expect(answer.runId).toBeTypeOf("number")
    const body = api.requests.filter((request) => request.path === "/api/2.2/jobs/runs/submit")[0]!.body as Record<string, unknown>
    expect(body).toMatchObject({ idempotency_token: "pln_x", timeout_seconds: 3600, tasks: [{ notebook_task: { notebook_path: "/Shared/Nightly", base_parameters: { day: "2026-11-18" } } }] })
    api.mustNotReject()
  })

  it("cancels a run and a statement, and reads a run", async () => {
    const { api, port, signal } = real()
    await port.cancelRun("work", 7, signal)
    await port.cancelStatement("work", "st-1", signal)
    expect((await port.getRun("work", 7, signal)).runId).toBe(7)
    expect(api.paths()).toEqual(["POST /api/2.2/jobs/runs/cancel", "POST /api/2.0/sql/statements/st-1/cancel", "GET /api/2.2/jobs/runs/get"])
    api.mustNotReject()
  })

  it("a change's submit: the exact text, the wait, and the plan's tag", async () => {
    const { api, port, signal } = real()
    const request: StatementRequest = {
      account: "work",
      operation: "sql.statements.change",
      statement: "DELETE FROM main.s.t WHERE id = 1",
      warehouseId: "wh-small",
      byteLimit: 1024 * 1024,
      disposition: "INLINE",
      format: "JSON_ARRAY",
      waitTimeout: 50,
      onWaitTimeout: "CANCEL",
      queryTags: { oc_plugin: "databricks", oc_tool: "delete", oc_session: "s", oc_call: "c", oc_plan: "pln_x" },
    }
    const answer = await port.submit(request, signal)
    expect(answer.state).toBe("SUCCEEDED")
    const body = api.requests.filter((entry) => entry.path === "/api/2.0/sql/statements")[0]!.body as Record<string, unknown>
    expect(body).toMatchObject({ statement: request.statement, warehouse_id: "wh-small", wait_timeout: "50s", on_wait_timeout: "CANCEL", disposition: "INLINE", format: "JSON_ARRAY" })
    // The API documents the tags as an array with "no significance to the order", so compare them as a set.
    expect(Object.fromEntries((body.query_tags as { key: string; value: string }[]).map((tag) => [tag.key, tag.value]))).toEqual({ oc_plugin: "databricks", oc_tool: "delete", oc_session: "s", oc_call: "c", oc_plan: "pln_x" })
    api.mustNotReject()
  })

})

/**
 * The whole change path over package B's loopback fake: a job **plan** (which needs the client's `getJob`) and a
 * warehouse edit's **commit** (which needs `editWarehouse`). Nothing leaves the machine: the fake answers the
 * documented `GET /api/2.2/jobs/get` and `POST /api/2.0/sql/warehouses/{id}/edit`.
 */
describe("the real client's getJob and editWarehouse, end to end", () => {
  const depsOver = async (features: readonly ("jobs" | "workspace" | "files")[] = ["jobs"]) => {
    const fake = await startFakeDatabricks({ jobs: new Map([[10, { name: "nightly", creatorUserName: "user@example.com" }]]) })
    const account = accountOf(fake, { features: [...features], warehouse: "wh-small" })
    const auth = fakeAuth(account)
    const client = createDatabricksClient({ auth })
    const options = loadOptions({ accounts: { work: { warehouse: "wh-small", features: [...features] } } })
    const clock = { now: Date.now, uuid: () => "00000000-0000-4000-8000-000000000001" }
    const deps: Deps = {
      options,
      access: options.access,
      auth,
      databricks: client,
      reads: new FakeReads(),
      ledger: new MemoryLedger(),
      plans: createPlanStore({ ttlSeconds: 300, now: clock.now }),
      permission: new RecordingPermission(),
      clock,
    }
    return { fake, client, deps, signal: new AbortController().signal }
  }

  it("plans a job run from the job's own settings", async () => {
    const { fake, deps, signal } = await depsOver()
    try {
      const planned = (await runTool("plan", { job: { jobId: 10 } }, fakeCall(), deps, HANDLERS)) as Record<string, unknown>
      expect(planned).toMatchObject({ state: "planned", category: "run", commitWith: "databricks_run", preview: { kind: "job" } })
      const notes = ((planned.preview as { notes: string[] }).notes).join(" ")
      expect(notes).toMatch(/`nightly`/)
      expect(notes).toMatch(/`main` on a job cluster shared as `shared_big` of `i3.8xlarge` with 40 workers/)
      expect(notes).toMatch(/timeout_seconds 3600, which stops it/)
      expect(fake.requests.filter((request: { path: string }) => request.path === "/api/2.2/jobs/get")).toHaveLength(1)
      expect(signal.aborted).toBe(false)
    } finally {
      await fake.close()
    }
  })

  it("listModels follows next_page_token across pages", async () => {
    const models = Array.from({ length: 101 }, (_, index) => ({ name: `m${index}` }))
    const fake = await startFakeDatabricks({ models: new Map([["main.hr", models]]) })
    try {
      const account = accountOf(fake, { features: [] })
      const client = createDatabricksClient({ auth: fakeAuth(account) })
      const signal = new AbortController().signal
      const listed = await client.listModels("work", "main", "hr", signal)
      expect(listed).toHaveLength(101)
      expect(listed[0]).toMatchObject({ name: "m0", fullName: "main.hr.m0" })
      const requests = fake.requests.filter((request: { path: string }) => request.path === "/api/2.1/unity-catalog/models")
      expect(requests).toHaveLength(2)
      expect(requests[0]!.query).toMatchObject({ catalog_name: "main", schema_name: "hr", max_results: "100" })
      expect(requests[1]!.query).toMatchObject({ page_token: "p:100" })
    } finally {
      await fake.close()
    }
  })

  it("commits a warehouse edit through the documented body, read back with the change applied", async () => {
    const { fake, client, deps, signal } = await depsOver()
    try {
      const planned = (await runTool("plan", { warehouse: { id: "wh-small", edit: { size: "Medium", autoStopMinutes: 0 } }, reason: "the nightly load needs more" }, fakeCall(), deps, HANDLERS)) as Record<string, unknown>
      expect(planned).toMatchObject({ state: "planned", category: "admin" })
      const answer = (await runTool("admin", { planId: planned.planId }, fakeCall("call_admin"), deps, HANDLERS)) as Record<string, unknown>
      expect(answer).toMatchObject({ state: "ok" })
      const edit = fake.requests.find((request: { path: string }) => request.path === "/api/2.0/sql/warehouses/wh-small/edit")
      expect(edit).toBeDefined()
      expect(edit!.body).toMatchObject({ cluster_size: "Medium", auto_stop_mins: 0 })
      // The body is the warehouse read back, not a partial one: the fields the plan did not change are echoed.
      expect(edit!.body).toMatchObject({ name: expect.any(String) })
      // The read-back keeps the fields the edit did not name, and the change is visible afterwards.
      const after = await client.getWarehouse("work", "wh-small", signal)
      expect(after).toMatchObject({ clusterSize: "Medium", autoStopMins: 0 })
    } finally {
      await fake.close()
    }
  })
})
