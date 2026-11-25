// Builds the conformance fixture from synthetic accounts. The provider is not reached: the pages and snapshots are the
// shapes the handlers answer, checked by the same `acceptAnswer` a consumer uses. Run with `node`, then
// `npx plugin-kit record` to redact the personal fields the kit detects.
import { readFileSync, writeFileSync } from "node:fs"
import { encodeBoundCursor } from "@we-the-rebel-alliance/plugin-contract/cursor"
import { eventsListResult, makeEvent } from "@we-the-rebel-alliance/plugin-contract/events"
import { accountStatuses, statusAnswer } from "@we-the-rebel-alliance/plugin-contract/accounts"

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
const manifest = pkg.capabilities
const asOf = "2026-11-20T09:00:00.000Z"
const workOwner = { id: "mailto:ana.silva@example.com", label: "Ana Silva" }
const personalOwner = { id: "mailto:ana.silva@personal.example", label: "Ana Silva (personal)" }

const event = (source, account, external_id, kind, occurred_at, title, labels) =>
  makeEvent({
    source,
    account,
    external_id,
    kind,
    occurred_at,
    actors: [{ role: "author", id: account === "work" ? workOwner.id : personalOwner.id, name: account === "work" ? workOwner.label : personalOwner.label }],
    title,
    text: "",
    labels,
  })

const page = (source, account, owner, events) =>
  eventsListResult(
    { source, account, owner },
    events,
    encodeBoundCursor({ plugin: "databricks", source, account }, { e: 1, l: 1 }),
    false,
    { asOf },
  )

const queryEvent = event("queries", "work", "query-work-1", "x-databricks/query", "2026-11-19T10:15:00.000Z", "SELECT count(*) FROM main.default.orders", ["SELECT", "FINISHED"])
const runEvent = event("runs", "work", "run-work-1", "x-databricks/run", "2026-11-19T11:00:00.000Z", "Job nightly-refresh run 1 succeeded", ["SUCCESS"])

const probe = (source, answer) => ({ answer: { ...(source === undefined ? {} : { source }), account: "work", owner: workOwner, trust: "untrusted", ...answer } })

const status = statusAnswer({
  manifest,
  version: pkg.version,
  hostVersion: "2.4.1",
  accounts: accountStatuses(
    [
      { alias: "work", profile: {} },
      { alias: "personal", profile: {} },
    ],
    { work: { state: "ready", owner: workOwner }, personal: { state: "ready", owner: personalOwner } },
  ),
  problems: [],
  unguardedAgents: [],
})

const fixture = {
  $comment: "Recorded from two synthetic accounts; the provider is not reached. The pages and snapshots are the shapes the handlers answer.",
  plugin: pkg.name,
  namespace: manifest.plugin.summary,
  accounts: {
    real: false,
    aliases: ["work", "personal"],
    required: { method: "catalog", code: "ACCOUNT_REQUIRED" },
    unknown: { method: "catalog", account: "nobodyhere", code: "ACCOUNT_UNKNOWN" },
    cursors: [{ method: "events_list", account: "work", other: "personal", code: "CURSOR_INVALID" }],
  },
  sources: {
    "databricks.queries": {
      cases: [{ name: "the work account's own statements", input: { source: "queries", account: "work" }, expect: "page", answer: page("queries", "work", workOwner, [queryEvent]) }],
      probe: probe("queries"),
    },
    "databricks.runs": {
      cases: [{ name: "the work account's finished runs", input: { source: "runs", account: "work" }, expect: "page", answer: page("runs", "work", workOwner, [runEvent]) }],
      probe: probe("runs"),
    },
    "databricks.saved": {
      snapshot: {
        answer: {
          data: { columns: [{ key: "name", label: "name" }, { key: "count", label: "count" }], rows: [{ name: "orders", count: 42 }] },
          asOf,
          cost: { units: [{ per: "statement", count: 1 }] },
          trust: "untrusted",
        },
      },
      probe: probe(undefined),
      suggest: {
        answer: {
          options: [{ id: `query-1#${"0".repeat(64)}`, label: "Orders per day" }],
        },
      },
    },
  },
  events: { emitted: ["changed"], status },
  rpc: {
    inputs: {
      save: { sql: "SELECT 1" },
      start: { warehouse: "wh-small" },
      stop: { warehouse: "wh-small" },
    },
  },
}

writeFileSync(new URL("../../fixtures/conformance.json", import.meta.url), JSON.stringify(fixture, null, 2) + "\n")
console.log("wrote fixtures/conformance.json")
