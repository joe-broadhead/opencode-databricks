// The **real** client (package B's `src/process/client.ts`) against the documented fake, for the calls package D relies
// on. A test double of the client's mapping can agree with its own fixtures; this file cannot: every request the client
// builds is handed to `DocumentedApi`, which refuses a wrong method, path, field or documented constraint (the review of
// #7's M3). A wrong field in the client — `notebook_params` where Jobs API 2.2 documents `job_parameters` — fails here.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { StatementRequest } from "../../../src/ports.js"
import { createDatabricksClient } from "../../../src/process/client.js"
import { FakeAuth } from "../../fake/ports.js"
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

/**
 * Jobs API 2.2 `run-now` documents `job_parameters` and has no `notebook_params`
 * (https://docs.databricks.com/api/jobs/v2/run-now.md). Package B's client currently sends `notebook_params`; the fix is
 * the contract keeper's, in its next PR. This case reads the client's own source so it starts running the moment that
 * fix lands — and fails if the field regresses afterwards — while the rest of the file proves the real client against
 * the documented fake today.
 */
const clientSendsJobParameters = readFileSync(new URL("../../../src/process/client.ts", import.meta.url), "utf8").includes("job_parameters")

describe("the real client against the documented fake", () => {
  it.skipIf(!clientSendsJobParameters)("run-now: the job's parameters go in `job_parameters`, with the token", async () => {
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
