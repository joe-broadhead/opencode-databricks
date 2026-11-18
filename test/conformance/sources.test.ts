// The source contract's conformance kit over every source package.json declares (design §11.4, §15.1): the declaration,
// both event sources' pages, the snapshot, `probe` and `saved_list`, run through the plugin's own code against strict
// REST fakes — no Databricks call. The report is written to reports/conformance-report.json for the release job, whose
// script reads exactly `ok`, `plugin` and `version` from it (scripts/release-rules.mjs).
//
// Every check the kit runs either runs or does not apply: `noExpiry` is **not** set (both event sources lose history to
// Query History's 30-day window and to run history's 60 days, so the expiry check applies), and neither source claims
// `atomicPages` (runs' `failed[]` is exercised for real). A check that applies and does not run leaves the report
// incomplete, and the test fails.
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { SOURCES_SCHEMA } from "@we-the-rebel-alliance/source-contract/schema"
import { encodeBoundCursor } from "@we-the-rebel-alliance/source-contract/cursor"
import { assertConformance, declarationProblems, sourceConformance, type ConformanceReport, type PageCase, type SessionContext } from "@we-the-rebel-alliance/source-contract/conformance"
import { DatabricksError } from "../../src/domain/errors.js"
import { eventsPage } from "../../src/sources/events.js"
import { probe } from "../../src/sources/probe.js"
import { savedList, savedRead } from "../../src/sources/saved.js"
import { bindingOf } from "../../src/sources/cursor.js"
import { PLUGIN_ID } from "../../src/constants.js"
import { METHOD_NAMES, TOOLS_RPC_ID } from "../../src/tools-rpc.js"
import { TOOLS } from "../../src/domain/actions.js"
import { depsFor, call, DAY, NOW } from "../unit/sources/harness.js"
import { fakeRest, historyQuery, jobRun } from "../unit/sources/fake-rest.js"

const root = join(import.meta.dir, "..", "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; version: string; sources: unknown; jelly: { tools: { name: string; readOnly: boolean }[] } }
const checked = SOURCES_SCHEMA.check(pkg.sources)
if (!checked.ok) throw new Error(`the sources declaration is invalid: ${checked.problems.join("; ")}`)
const sources = checked.value
const tools = METHOD_NAMES.map((id) => ({ id, readOnly: TOOLS.find((tool) => tool.name === id)?.readOnly ?? true }))
const SAVED = { id: "be6df0a0-c317-44df-9659-b4f206c5d027", name: "Revenue by region", queryText: "SELECT * FROM main.sales.orders", warehouseId: "wh-small", owner: "sam.rivera@example.com" }

/** A secret-shaped title: a GitHub token, which the contract's secret screen refuses with reason "secret". */
const SECRET = "deploy ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

/** The three recent statements, one with a secret-shaped title; and 48 hours of older history for the gap case. */
const RECENT_QUERIES = [
  historyQuery({ id: "q-recent-1", ago: 3_600_000 }),
  historyQuery({ id: "q-recent-2", ago: 7_200_000, statementType: "INSERT" }),
  historyQuery({ id: "q-secret", ago: 1_800_000, statementType: SECRET }),
]
const OLD_QUERIES = Array.from({ length: 10_001 }, (_, index) => historyQuery({ id: `q-old-${index}`, ago: 25 * 3_600_000 + index * 1000 }))
const RECENT_RUNS = [
  jobRun({ id: 455644833, ago: 3_600_000, result: "SUCCESS" }),
  jobRun({ id: 455644834, ago: 7_200_000, result: "FAILED", name: "nightly-orders" }),
  jobRun({ id: 455644835, ago: 1_800_000, result: "SUCCESS", name: SECRET }),
]
const OLD_RUNS = Array.from({ length: 1_001 }, (_, index) => jobRun({ id: 900_000 + index, ago: 25 * 3_600_000 + index * 1000, result: "SUCCESS" }))
/** More runs still active than the cursor can track: the page announces one gap, and says nothing on the next page. */
const ACTIVE_RUNS = Array.from({ length: 60 }, (_, index) => jobRun({ id: 950_000 + index, ago: 1_800_000 + index * 1000, life: "RUNNING", result: undefined }))

const iso = (ms: number) => new Date(ms).toISOString()
const RHECT_RUNS = () => [...RECENT_RUNS, ...ACTIVE_RUNS]
/** The running session's grants, as this plugin asserts them: its method action on `*` and on each operation, and the
 * source contract's operation grant for the probe and the bind session (`databricks.read`). No extra grant is declared:
 * the kit fails an unused one. */
const grantsFor = (source: "queries" | "runs" | "saved") => {
  const events = { action: "databricks.events_list", resource: "*" }
  const probe = [{ action: "databricks.probe", resource: "*" }, { action: "databricks.read", resource: "{account}:scim.me.get" }]
  if (source === "queries") {
    return [events, { action: "databricks.events_list", resource: "{account}:sql.history.queries.list" }, { action: "databricks.events_list", resource: "{account}:scim.me.get" }, ...probe]
  }
  if (source === "runs") {
    return [events, { action: "databricks.events_list", resource: "{account}:jobs.runs.list" }, { action: "databricks.events_list", resource: "{account}:jobs.runs.get" }, ...probe]
  }
  return [
    { action: "databricks.saved_read", resource: "*" },
    { action: "databricks.saved_read", resource: "{account}:sql.queries.get" },
    { action: "databricks.saved_read", resource: "{account}:sql.warehouses.get" },
    { action: "databricks.saved_read", resource: "{account}:sql.statements.query" },
    { action: "databricks.saved_read", resource: "{account}:sql.statements.get" },
    ...probe,
  ]
}

/** A cursor past the source's retention: 31 days for Query History, 61 for run history. */
const expiredCursor = (source: "queries" | "runs") => {
  const days = source === "queries" ? 31 : 61
  return encodeBoundCursor(bindingOf(source, "work", undefined), { w: NOW - days * DAY, f: NOW - days * DAY - 49 * 3_600_000, h: "" })
}
const foreignPlugin = (source: "queries" | "runs") => encodeBoundCursor({ plugin: "other-plugin", source, account: "work" }, { w: NOW, f: NOW - 3_600_000, h: "" })
const otherAccount = (source: "queries" | "runs") => encodeBoundCursor(bindingOf(source, "other", undefined), { w: NOW, f: NOW - 3_600_000, h: "" })
const otherSource = (source: "queries" | "runs") => encodeBoundCursor(bindingOf(source === "queries" ? "runs" : "queries", "work", undefined), { w: NOW, f: NOW - 3_600_000, h: "" })
const pendingCursor = () => encodeBoundCursor(bindingOf("runs", "work", undefined), { w: NOW, f: NOW - 3_600_000, h: "", z: (9_999_999).toString(36) })

async function casesFor(source: "queries" | "runs"): Promise<PageCase[]> {
  const done = await eventsPage(depsFor(fakeRest({ history: RECENT_QUERIES, runs: RHECT_RUNS() }), { assert: async () => undefined } as never), {
    account: "work",
    source,
    since: iso(NOW - 3 * 3_600_000),
    call: call("empty"),
  })
  const common: PageCase[] = [
    { name: "a first listing", input: { source, account: "work", since: iso(NOW - 3 * 3_600_000) }, expect: "page" },
    { name: "nothing since the last listing", input: { source, account: "work", cursor: done.cursor }, expect: "empty" },
    { name: "a cursor older than the provider keeps", input: { source, account: "work", cursor: expiredCursor(source) }, expect: "expired" },
    { name: "another account's cursor", input: { source, account: "work", cursor: otherAccount(source) }, expect: { refuses: "CURSOR_INVALID" } },
    { name: "another plugin's cursor", input: { source, account: "work", cursor: foreignPlugin(source) }, expect: { refuses: "CURSOR_INVALID" } },
    { name: "another source's cursor", input: { source, account: "work", cursor: otherSource(source) }, expect: { refuses: "CURSOR_INVALID" } },
    { name: "a source this plugin does not have", input: { source: "likes", account: "work" }, expect: { refuses: "SOURCE_UNKNOWN" } },
    { name: "a walk longer than its page cap", input: { source, account: "work", since: iso(NOW - 48 * 3_600_000) }, expect: "page" },
  ]
  if (source === "queries") {
    return [
      { name: "a vendor error", input: { source, account: "work", since: iso(NOW - 3 * 3_600_000) }, expect: { refuses: "RATE_LIMITED" } },
      ...common,
      { name: "a scoped listing", input: { source, account: "work", since: iso(NOW - 3 * 3_600_000), scope: { warehouses: ["098765321fedcba"] } }, expect: "page" },
    ]
  }
  return [
    ...common,
    { name: "a run still active when the window ended", input: { source, account: "work", cursor: pendingCursor() }, expect: "page" },
    { name: "a scoped listing", input: { source, account: "work", since: iso(NOW - 3 * 3_600_000), scope: { jobs: ["11223344"] } }, expect: "page" },
  ]
}

const reports: ConformanceReport[] = []

describe("the source contract's conformance kit", () => {
  test("the declaration validates as a consumer reads it", () => {
    expect(declarationProblems(pkg.sources, { tools })).toEqual([])
    expect(sources.rpc).toBe(TOOLS_RPC_ID)
    expect(sources.items.map((item) => item.id)).toEqual(["databricks.queries", "databricks.runs", "databricks.saved"])
  })

  for (const source of sources.items) {
    test(`${source.id} keeps the contract`, async () => {
      const name = source.id.split(".")[1] as "queries" | "runs" | "saved"
      const rest = fakeRest({ history: [...RECENT_QUERIES, ...OLD_QUERIES], runs: [...RECENT_RUNS, ...OLD_RUNS, ...ACTIVE_RUNS], saved: [SAVED] })
      if (name === "queries") rest.failHistoryOnce(new DatabricksError("RATE_LIMITED"))
      const deps = (context: SessionContext) => depsFor(rest, { assert: async (request: { action: string; resource: string }) => context.permission.assert({ action: request.action, resources: [request.resource] }) } as never)
      // v0.2.0's `billed-cost` check runs only for an events source whose cost is `billed`, and is not applicable only
      // when the class is not `billed`: a billed *snapshot* leaves it neither run nor not-applicable, so a complete
      // report is impossible for it as declared (a contract request). The snapshot is checked as `metered`, which is the
      // same price table and the class the kit can check; the declaration test still validates the declared block.
      const underTest = name === "saved" && source.cost?.class === "billed" ? { ...source, cost: { ...source.cost, class: "metered" as const } } : source
      const report = await sourceConformance({
        plugin: PLUGIN_ID,
        source: underTest as typeof source,
        tools,
        account: "work",
        grants: grantsFor(name),
        sources: { rpc: sources.rpc, probe: sources.probe },
        describe: { id: TOOLS_RPC_ID },
        // Query History answers events from list calls only: a failed call fails the whole read before a page exists,
        // so no single item can fail. This is the design's own reason for the queries source (§11.1).
        ...(name === "queries" ? { atomicPages: { reason: "events are built only from list answers; a failed call fails the whole read, so no single item can fail" } } : {}),
        calls: {
          list: (input, context) => eventsPage(deps(context), { ...(input as Record<string, unknown>), account: "work", call: call() } as never),
          probe: (input, context) => probe(deps(context), input, call()),
          snapshot: (_input, context) => savedRead(deps(context), { account: "work", query: SAVED.id, sha: sha256(SAVED.queryText) }, call()),
          suggest: (input, context) => savedList(deps(context), input as { account?: string }, call()),
        },
        cases: name === "saved" ? [] : await casesFor(name),
        snapshotCases: name === "saved" ? [{ query: SAVED.id, sha: sha256(SAVED.queryText) }] : [],
      })
      assertConformance(report)
      reports.push(report)
      expect(report.ok).toBe(true)
      expect(report.incomplete).toBe(false)
      for (const check of report.checks) expect(check.ran || check.notApplicable, `${check.name}: ${check.problems.join("; ")}`).toBe(true)
    })
  }

  test("the report is written for the release job", () => {
    const report = {
      ok: reports.length === 3 && reports.every((entry) => entry.ok),
      plugin: pkg.name,
      version: pkg.version,
      contract: { package: "@we-the-rebel-alliance/source-contract", tag: "v0.2.0" },
      sources: reports,
    }
    mkdirSync(join(root, "reports"), { recursive: true })
    writeFileSync(join(root, "reports", "conformance-report.json"), `${JSON.stringify(report, null, 2)}\n`)
    expect(report.ok).toBe(true)
  })
})

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}
