// §15.2's recorded shapes: every fixture is the API's own wire form, sanitised, cited in SOURCES.json, and replayed
// through the fake and the client. A fixture that stops matching the client's parser fails here rather than in another
// package's suite.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { StatementAnswer } from "../../../src/ports.js"
import { createDatabricksClient, toFunction, toRun, toTable, toWarehouse } from "../../../src/process/client.js"
import { toChunkAnswer, toHistoryQuery, toStatementAnswer } from "../../../src/process/statements.js"
import { convertRows } from "../../../src/process/values.js"
import { startFakeDatabricks } from "../../fake/databricks-server.js"
import { fakeAuth } from "./support.js"

const DIR = fileURLToPath(new URL("../../fixtures/databricks/", import.meta.url))
const load = (name: string): unknown => JSON.parse(readFileSync(join(DIR, name), "utf8"))
const sources = load("SOURCES.json") as { files: Record<string, { api: string; reference: string; covers: string }> }
const files = readdirSync(DIR).filter((name) => name.endsWith(".json") && name !== "SOURCES.json").sort()

const STATEMENT = "SELECT * FROM (\nSELECT 1\n) AS oc_q"

const stringsOf = (value: unknown): string[] =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(stringsOf) : value && typeof value === "object" ? Object.values(value).flatMap(stringsOf) : []

describe("§15.2 fixtures: every recorded shape is cited and sanitised", () => {
  it("cites each file in SOURCES.json with its API and reference page", () => {
    expect(files.length).toBeGreaterThan(0)
    for (const name of files) {
      const entry = sources.files[name]
      expect(entry, name).toBeDefined()
      expect(entry!.api, name).not.toBe("")
      expect(entry!.reference, name).toMatch(/^https:\/\/docs\.databricks\.com\//u)
      expect(entry!.covers.length, name).toBeGreaterThan(20)
    }
    for (const name of Object.keys(sources.files)) expect(files, name).toContain(name)
  })

  it("holds no real workspace, person, id or token", () => {
    for (const name of files) {
      const strings = stringsOf(load(name))
      for (const value of strings) {
        expect(value, name).not.toMatch(/\.cloud\.databricks\.com|\.azuredatabricks\.net|\.gcp\.databricks\.com|dbc-[0-9a-f]{8}/iu)
        expect(value, name).not.toMatch(/\/Users\/|\/home\/[a-z]/u)
        for (const email of value.match(/[\w.+-]+@[\w.-]+/gu) ?? []) expect(email.endsWith("@example.com"), `${name}: ${email}`).toBe(true)
        for (const token of value.match(/\b(?:dapi|dose)[0-9a-z]{8,}/giu) ?? []) expect(token, name).toMatch(/^(?:dapi|dose)[01]+(?:fixture)?$/iu)
      }
    }
  })

  it("keeps the one external link on a storage host, with a placeholder signature", () => {
    const body = load("statement-external-links.json") as { result: { external_links: { external_link: string }[] } }
    const url = new URL(body.result.external_links[0]!.external_link)
    expect(url.protocol).toBe("https:")
    expect(url.hostname.endsWith(".amazonaws.com")).toBe(true)
    expect(url.searchParams.get("X-Amz-Signature")).toBe("fixture-not-a-secret")
  })
})

describe("§15.2 fixtures: replayed through the client and the fake", () => {
  it("reads every statement fixture as a StatementAnswer", () => {
    expect(toStatementAnswer(load("statement-succeeded-inline.json"))).toMatchObject({ state: "SUCCEEDED", statementId: "00000000-0000-4000-8000-000000000001" })
    expect(toStatementAnswer(load("statement-pending.json")).state).toBe("PENDING")
    expect(toStatementAnswer(load("statement-failed-parse.json"))).toMatchObject({ state: "FAILED", error: { errorCode: "BAD_REQUEST", sqlState: "42601" } })
    expect(toStatementAnswer(load("statement-failed-permission.json")).error?.message).toContain("main.sales.orders")
    expect(toStatementAnswer(load("statement-canceled.json")).state).toBe("CANCELED")
    const links = toStatementAnswer(load("statement-external-links.json"))
    expect(links.links?.[0]).toMatchObject({ chunkIndex: 0, rowCount: 100, byteCount: 293, nextChunkIndex: 1 })
    expect(links.nextChunkIndex).toBe(1)
    const explain = toStatementAnswer(load("explain.json"))
    expect(explain.manifest?.columns.map((column) => column.name)).toEqual(["plan"])
    expect(explain.rows).toHaveLength(3)
  })

  it("reads the recorded chunk bodies as the chunk endpoint's top-level shape (H1)", () => {
    const inline = toChunkAnswer(load("statement-chunk-inline.json"))
    expect(inline).toMatchObject({ chunkIndex: 1, rowCount: 2, nextChunkIndex: 2 })
    expect(inline.rows).toEqual([["2"], ["3"]])
    const links = toChunkAnswer(load("statement-chunk-external-links.json"))
    expect(links.links?.[0]).toMatchObject({ chunkIndex: 1, rowCount: 100, byteCount: 294, nextChunkIndex: 2 })
    expect(links.nextChunkIndex).toBe(2)
  })

  it("converts the recorded row to the values the design promises", () => {
    const answer = toStatementAnswer(load("statement-succeeded-inline.json"))
    const values = convertRows(answer.rows ?? [], answer.manifest?.columns ?? [])[0]!
    expect(values).toEqual([
      "9007199254740993",
      "1.25",
      "NaN",
      "2026-11-17T09:30:00.000Z",
      "2026-11-17T09:30:00",
      "2026-11-17",
      true,
      "a note, with a comma",
      "AAECAwQ=",
      "[1,2,3]",
      '{"a":1}',
      '{"x":1}',
      '{"v":1}',
      "INTERVAL '1' DAY",
      null,
    ])
  })

  it("serves the recorded answer through the fake, as another package will", async () => {
    const recorded = toStatementAnswer(load("statement-succeeded-inline.json")) as StatementAnswer
    const fake = await startFakeDatabricks({ statements: new Map([[STATEMENT, recorded]]) })
    try {
      const auth = fakeAuth({ alias: "work", mode: "interactive", host: fake.origin, cloud: "aws", features: [], enforcement: "identity" })
      const client = createDatabricksClient({ auth })
      const answer = await client.submit(
        { account: "work", operation: "sql.statements.query", statement: STATEMENT, warehouseId: "wh-small", disposition: "INLINE", format: "JSON_ARRAY", waitTimeout: 50, onWaitTimeout: "CANCEL", queryTags: { oc_call: "call-fixture" } },
        new AbortController().signal,
      )
      expect(answer.rows).toEqual(recorded.rows)
      expect(answer.manifest?.columns[3]).toMatchObject({ name: "created", typeName: "TIMESTAMP" })
    } finally {
      await fake.close()
    }
  })

  it("reads the recorded Query History page, table, functions, runs and warehouses", async () => {
    const page = load("history-queries.json") as { res: unknown[]; next_page_token?: string }
    const first = toHistoryQuery(page.res[0])
    expect(first).toMatchObject({ queryId: "00000000-0000-4000-8000-000000000001", statementType: "SELECT", durationMs: 3150, rowsProduced: 12, readBytes: 52428800, resultFromCache: true, isFinal: true })
    expect(first.queryTags).toEqual({ oc_plugin: "databricks", oc_call: "call-fixture" })
    expect(toHistoryQuery(page.res[1]).status).toBe("CANCELED")

    const table = toTable(load("table-view.json"))
    expect(table).toMatchObject({ fullName: "main.sales.v_orders", tableType: "VIEW", rowFilter: { functionName: "main.governance.region_filter" } })
    expect(table.columns[1]?.mask).toEqual({ functionName: "main.governance.mask_email" })
    expect(table.viewDependencies?.map((dependency) => dependency.kind)).toEqual(["table", "function", "connection"])

    const functions = (load("functions.json") as { functions: unknown[] }).functions
    expect(toFunction(functions[0]).routineBody).toBe("SQL")
    expect(toFunction(functions[1])).toMatchObject({ routineBody: "EXTERNAL", externalLanguage: "PYTHON" })

    const runs = (load("runs-list.json") as { runs: unknown[] }).runs
    expect(toRun(runs[0])).toMatchObject({ runId: 455644833, jobId: 11223344, state: { lifeCycleState: "TERMINATED", resultState: "SUCCESS" } })
    expect(toRun(runs[1]).state.lifeCycleState).toBe("RUNNING")

    const warehouses = (load("warehouses.json") as { warehouses: unknown[] }).warehouses
    expect(toWarehouse(warehouses[0])).toMatchObject({ state: "RUNNING", serverless: true, clusterSize: "2X-Small", autoStopMins: 5, statementTimeoutSeconds: 0 })
    expect(toWarehouse(warehouses[1])).toMatchObject({ state: "STOPPED", serverless: false, warehouseType: "CLASSIC" })
    expect(toWarehouse(warehouses[2]).state).toBe("STARTING")
  })

  it("keeps the error and token shapes the client's mapping expects", () => {
    const errors = load("errors.json") as Record<string, { error_code: string; message: string }>
    expect(errors.rate_limited?.error_code).toBe("REQUEST_LIMIT_EXCEEDED")
    expect(errors.server_error?.error_code).toBe("TEMPORARILY_UNAVAILABLE")
    expect(errors.not_found?.error_code).toBe("RESOURCE_DOES_NOT_EXIST")
    const token = load("token.json") as { access_token: string; token_type: string; expires_in: number; refresh_token: string }
    expect(token.token_type).toBe("Bearer")
    expect(token.expires_in).toBe(3600)
    expect(token.refresh_token).not.toBe(token.access_token)
  })
})
