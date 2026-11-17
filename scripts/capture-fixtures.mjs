#!/usr/bin/env node
// Captures the fixtures of design §15.2 from a real workspace, for the live check only. It is never run by a test or
// by `npm run check`: it refuses to start unless DATABRICKS_HOST is set, and refuses outright inside a test runner.
//
//   DATABRICKS_HOST=https://dbc-xxxx.cloud.databricks.com \
//   DATABRICKS_TOKEN=dapi…                                  \
//   DATABRICKS_WAREHOUSE_ID=abcdef0123456789                \
//   DATABRICKS_TABLE=main.sales.orders                      \
//   DATABRICKS_JOB_ID=11223344                              \
//   node scripts/capture-fixtures.mjs [--dry-run] [--yes]
//
// What it writes: test/fixtures/databricks/*.json — the wire bodies and nothing else. Every answer is sanitised before
// it is written (sanitise() below): the workspace host, tokens, emails, numeric user ids, warehouse/job/run ids,
// statement ids and every external-link URL (whatever host it is on) are replaced, and free text is scrubbed of the
// same. Query History is fetched **only for this capture's own statement ids** (`filter_by.statement_ids`) and its
// per-person fields are dropped, so no other person's statements, lookup keys or UI links reach the repository.
// `--dry-run` prints the plan and writes nothing; `--yes` is required to spend a workspace's time.
//
// Costs: every statement runs on DATABRICKS_WAREHOUSE_ID, which bills while it runs; the capture runs at most six
// statements, all tagged `oc_plugin=livecheck`. A stopped warehouse is started by the first submit, as Databricks does
// (L8), so the capture says what it will do before it starts.
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const OUT = join(ROOT, "test", "fixtures", "databricks")
const EXAMPLE_STATEMENT = "SELECT * FROM (\nSELECT 1\n) AS oc_q"
const EXAMPLE_LINK = "https://fixture-results.s3.amazonaws.com/results/fixture-chunk-0?X-Amz-Signature=fixture-not-a-secret"

if (process.env.VITEST || process.env.NODE_TEST_CONTEXT || process.env.CI || process.env.GITHUB_ACTIONS) {
  console.error("capture-fixtures: this script calls a real workspace and never runs in a test or a workflow.")
  process.exit(2)
}

const args = new Set(process.argv.slice(2))
const host = process.env.DATABRICKS_HOST?.replace(/\/$/u, "") ?? ""
const token = process.env.DATABRICKS_TOKEN ?? ""
const warehouse = process.env.DATABRICKS_WAREHOUSE_ID ?? ""
const table = process.env.DATABRICKS_TABLE ?? ""
const jobId = process.env.DATABRICKS_JOB_ID ?? ""
const dryRun = args.has("--dry-run")

if (!host || !token || !warehouse) {
  console.error("capture-fixtures: set DATABRICKS_HOST, DATABRICKS_TOKEN and DATABRICKS_WAREHOUSE_ID (the live check's workspace).")
  process.exit(2)
}
if (!args.has("--yes") && !dryRun) {
  console.error("capture-fixtures: this runs statements on a warehouse that bills while it runs. Re-run with --yes, or --dry-run to see the plan.")
  process.exit(2)
}
if (!host.startsWith("https://")) {
  console.error("capture-fixtures: DATABRICKS_HOST must be https.")
  process.exit(2)
}

const plan = [
  "GET  /api/2.0/sql/warehouses",
  `POST /api/2.0/sql/statements  (one SELECT of every type, on ${warehouse})`,
  "POST /api/2.0/sql/statements  (EXTERNAL_LINKS + ARROW_STREAM; link metadata only)",
  "POST /api/2.0/sql/statements  (wait_timeout 0s; a PENDING answer, then cancelled)",
  "POST /api/2.0/sql/statements  (a parse error)",
  "POST /api/2.0/sql/statements  (EXPLAIN of the example statement)",
  "GET  /api/2.0/sql/history/queries",
  ...(jobId ? ["GET  /api/2.2/jobs/runs/list"] : []),
  ...(table ? [`GET  /api/2.1/unity-catalog/tables/${table}`, "GET  /api/2.1/unity-catalog/functions (of its schema)"] : []),
]
if (dryRun) {
  console.log(`capture-fixtures: would fetch, and write to ${OUT}:`)
  for (const line of plan) console.log(`  ${line}`)
  process.exit(0)
}

/** Fields that belong to a person or a session and never belong in a fixture: dropped wherever they appear. */
const DROP = new Set(["lookup_key", "spark_ui_url", "error_message", "client_application", "user_name", "executed_as_user_name", "session_id", "query_source", "plans_state", "channel_used", "creator_user_name", "owner_user_name"])

/** The replacements every answer goes through: nothing real survives them. */
function sanitise(value, seen = new Map()) {
  if (typeof value === "string") {
    let text = value
    text = text.split(host).join("https://workspace.example.com")
    text = text.split(token).join("dose00000000000000000000000fixture")
    text = text.replace(/[\w.+-]+@(?!example\.com)[\w.-]+/gu, "user@example.com")
    text = text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, (id) => {
      if (!seen.has(id)) seen.set(id, `00000000-0000-4000-8000-${String(seen.size + 1).padStart(12, "0")}`)
      return seen.get(id)
    })
    text = text.replace(/https:\/\/[^\s"']*amazonaws\.com[^\s"']*/gu, EXAMPLE_LINK)
    text = text.replace(/https:\/\/[^\s"']*\.dfs?\.core\.windows\.net[^\s"']*/gu, EXAMPLE_LINK)
    text = text.replace(/https:\/\/storage\.googleapis\.com[^\s"']*/gu, EXAMPLE_LINK)
    text = text.replace(/\b(?:dapi|dose|dkea)[0-9a-z-]{8,}/giu, "dose00000000000000000000000fixture")
    return text
  }
  if (Array.isArray(value)) return value.map((item) => sanitise(item, seen))
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !DROP.has(key))
        // A presigned URL is replaced whatever its host: a deny-list of storage suffixes would miss one.
        .map(([key, item]) => [key, key === "external_link" ? EXAMPLE_LINK : sanitise(item, seen)]),
    )
  }
  return value
}

/** The ids that are not UUIDs get their own replacements, per kind, so two answers agree on one warehouse. */
function ids(value, map = new Map()) {
  if (typeof value === "string" && /^[0-9a-f]{8,}$/iu.test(value) && !/^00000000-/u.test(value)) {
    if (!map.has(value)) map.set(value, `abcdef0123456${String(map.size).padStart(3, "0")}`)
    return map.get(value)
  }
  if (typeof value === "number" && value > 1_000) return 1000000000000001
  if (Array.isArray(value)) return value.map((item) => ids(item, map))
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, ids(item, map)]))
  return value
}

const WRITE = { "content-type": "application/json", authorization: `Bearer ${token}` }
const TAGS = [{ key: "oc_plugin", value: "livecheck" }]

async function api(method, path, body) {
  const response = await fetch(`${host}${path}`, { method, headers: WRITE, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await response.text()
  const answer = text === "" ? undefined : JSON.parse(text)
  return { status: response.status, body: answer }
}

const submit = (statement, over = {}) => api("POST", "/api/2.0/sql/statements", { statement, warehouse_id: warehouse, query_tags: TAGS, wait_timeout: "50s", on_wait_timeout: "CANCEL", ...over })

const write = (name, body) => {
  mkdirSync(dirname(join(OUT, name)), { recursive: true })
  writeFileSync(join(OUT, name), `${JSON.stringify(ids(sanitise(body)), null, 2)}\n`)
  console.log(`capture-fixtures: wrote ${name}`)
}

const everyType = "SELECT * FROM (\nSELECT CAST(9007199254740993 AS BIGINT) AS id, CAST(1.25 AS DECIMAL(18,2)) AS amount, CAST('NaN' AS DOUBLE) AS ratio,\n  CAST('2026-11-17 09:30:00' AS TIMESTAMP) AS created, CAST('2026-11-17 09:30:00' AS TIMESTAMP_NTZ) AS wall,\n  CAST('2026-11-17' AS DATE) AS day, true AS ok, 'a note, with a comma' AS note, CAST('abc' AS BINARY) AS bin,\n  array(1,2,3) AS arr, map('a', 1) AS m, named_struct('x', 1) AS s, parse_json('{\"v\":1}') AS v,\n  INTERVAL '1' DAY AS gap, CAST(NULL AS STRING) AS missing\n) AS oc_q"

const capture = async () => {
  const warehouses = await api("GET", "/api/2.0/sql/warehouses")
  write("warehouses.json", { warehouses: warehouses.body?.warehouses ?? [] })

  const inline = await submit(everyType)
  write("statement-succeeded-inline.json", inline.body)

  const links = await submit(everyType, { disposition: "EXTERNAL_LINKS", format: "ARROW_STREAM" })
  write("statement-external-links.json", links.body)

  const pending = await submit(everyType, { wait_timeout: "0s" })
  if (pending.body?.statement_id) await api("POST", `/api/2.0/sql/statements/${pending.body.statement_id}/cancel`, {})
  write("statement-pending.json", pending.body)

  const parse = await submit("SELECT * FROM (\nSELECT * FROM\n) AS oc_q")
  write("statement-failed-parse.json", parse.body)

  const explain = await submit(`EXPLAIN ${EXAMPLE_STATEMENT}`)
  write("explain.json", explain.body)

  // Only this capture's own statements: their ids are known, and every other record is someone else's.
  const statementIds = [inline, links, pending, parse, explain].map((answer) => answer.body?.statement_id).filter((id) => typeof id === "string")
  const filter = new URLSearchParams({ max_results: "20" })
  for (const id of statementIds) filter.append("filter_by.statement_ids", id)
  const history = await api("GET", `/api/2.0/sql/history/queries?${filter.toString()}`)
  write("history-queries.json", history.body)

  if (jobId) {
    const runs = await api("GET", `/api/2.2/jobs/runs/list?job_id=${encodeURIComponent(jobId)}&limit=2`)
    write("runs-list.json", runs.body)
  }
  if (table) {
    const detail = await api("GET", `/api/2.1/unity-catalog/tables/${encodeURIComponent(table)}`)
    write("table-view.json", detail.body)
    const [catalog, schema] = table.split(".")
    const functions = await api("GET", `/api/2.1/unity-catalog/functions?catalog_name=${encodeURIComponent(catalog ?? "")}&schema_name=${encodeURIComponent(schema ?? "")}`)
    write("functions.json", functions.body)
  }
  // The token endpoint needs the OAuth code flow (a browser and a PKCE verifier), so `token.json` stays the
  // hand-written example from the reference until package A's live check captures one.
  console.log("capture-fixtures: token.json is not capturable with a PAT; keep the hand-written example.")
}

capture().catch((error) => {
  console.error(`capture-fixtures: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
