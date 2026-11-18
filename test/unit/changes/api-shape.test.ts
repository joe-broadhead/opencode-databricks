// The fixtures are only worth what they refuse: `fixtures/api.ts` must reject every request Databricks would not accept,
// so a test cannot pass on an invented shape. Each case below is a documented constraint of the page named in
// `fixtures/jobs.ts` / `fixtures/workspace.ts`.
import { describe, expect, it } from "vitest"
import { DocumentedApi, Rejected } from "./fixtures/api.js"
import { GET_RUN, RUN_NOW } from "./fixtures/jobs.js"
import { historyRecord } from "./fixtures/api.js"
import { STATEMENT_SUCCEEDED_NO_RESULT } from "./fixtures/workspace.js"
import { NOTEBOOK_PATH } from "./harness.js"

const api = () =>
  new DocumentedApi({
    jobs: new Map([[100, { name: "nightly" }]]),
    runs: new Map(),
    workspace: new Map([["/", []]]),
    notebooks: new Map([[NOTEBOOK_PATH, "print(1)"]]),
    directories: new Map([["/Volumes/main/s/v", []]]),
    statements: new Map([["*", () => STATEMENT_SUCCEEDED_NO_RESULT]]),
    history: [historyRecord({ statementId: "st-1" })],
  })

const rejects = (call: () => unknown, pattern: RegExp) => {
  let message = ""
  try {
    call()
  } catch (error) {
    expect(error).toBeInstanceOf(Rejected)
    message = (error as Error).message
  }
  expect(message).toMatch(pattern)
}

describe("the documented-shape fake refuses what the real API would", () => {
  it("refuses a wrong method and a wrong path", () => {
    const fake = api()
    rejects(() => fake.checkRoute(RUN_NOW, "GET", RUN_NOW.path, {}, { job_id: 1 }), /is not POST/)
    rejects(() => fake.checkRoute(RUN_NOW, "POST", "/api/2.2/jobs/runnow", {}, { job_id: 1 }), /is not \/api\/2\.2\/jobs\/run-now/)
    expect(fake.rejections.length).toBeGreaterThanOrEqual(2)
  })

  it("refuses a body field the reference does not have, and a missing required one", () => {
    const fake = api()
    rejects(() => fake.runNow({ job_id: 1, notebook_params: {} }), /has no field notebook_params/)
    rejects(() => fake.runNow({ job_parameters: {} }), /needs job_id/)
  })

  it("enforces the documented constraints", () => {
    const fake = api()
    rejects(() => fake.runNow({ job_id: 1, idempotency_token: "x".repeat(65) }), /longer than 64/)
    rejects(() => fake.listRuns({ limit: 26 }), /limit is 1 to 25/)
    rejects(() => fake.listJobs({ limit: 101 }), /limit is 1 to 100/)
    rejects(() => fake.submitRun({ tasks: Array.from({ length: 101 }, (_, index) => ({ task_key: `t${index}` })) }), /at most 100 items/)
    rejects(() => fake.submitRun({ tasks: [{ task_key: "t", notebook_task: { notebook_path: "/x", unknown: 1 } }] }), /notebook_task has no field unknown/)
    rejects(() => fake.executeStatement({ statement: "select 1", warehouse_id: "wh", wait_timeout: "3s" }), /wait_timeout is 0 or 5\.\.50/)
    rejects(() => fake.executeStatement({ statement: "select 1", warehouse_id: "wh", disposition: "PARTIAL" }), /disposition is one of/)
    rejects(() => fake.executeStatement({ statement: "select 1", warehouse_id: "wh", query_tags: Array.from({ length: 21 }, (_, index) => ({ key: `k${index}` })) }), /at most 20 tags/)
  })

  it("accepts the documented values around each limit", () => {
    const fake = api()
    expect(fake.runNow({ job_id: 1, idempotency_token: "x".repeat(64) }).run_id).toBeTypeOf("number")
    expect(fake.listRuns({ limit: 25 }).runs).toEqual([])
    expect(fake.executeStatement({ statement: "select 1", warehouse_id: "wh", wait_timeout: "0s" }).status).toBeDefined()
    expect(fake.executeStatement({ statement: "select 1", warehouse_id: "wh", wait_timeout: "50s", disposition: "INLINE", format: "JSON_ARRAY" }).status).toBeDefined()
    fake.mustNotReject()
  })

  it("refuses an undocumented query parameter", () => {
    const fake = api()
    rejects(() => fake.checkRoute(GET_RUN, "GET", GET_RUN.path, { run_id: "1", include_libraries: "true" }), /no query parameter include_libraries/)
  })

  it("answers one run per idempotency token, as the reference guarantees", () => {
    const fake = api()
    const first = fake.runNow({ job_id: 1, idempotency_token: "token-1" })
    const second = fake.runNow({ job_id: 1, idempotency_token: "token-1" })
    const other = fake.runNow({ job_id: 1, idempotency_token: "token-2" })
    expect(second.run_id).toBe(first.run_id)
    expect(other.run_id).not.toBe(first.run_id)
    expect(fake.idempotency.size).toBe(2)
  })
})
