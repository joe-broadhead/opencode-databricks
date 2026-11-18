/**
 * `databricks_status` (design §4, §14, §7 layer 3). No Databricks call: every answer is from the fake port, and the
 * test asserts which calls a status makes (free control-plane reads only, unless `include: ["spend"]` asks for the one
 * reconciliation statement) and what it shows: identity, role and enforcement, scopes, the default warehouse and its
 * price, this plugin's running statements, the ledger's estimate, the budget, automation and the cleanup list.
 */
import { describe, expect, it } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import { formatStatus, isStatus, statusRows } from "../../../src/rpc.js"
import { automationOf, computeStatus, requestedScopes, statusHandler } from "../../../src/status.js"
import type { HistoryQuery, Token, Warehouse } from "../../../src/ports.js"
import { FakeAuth, FAKE_HOST, RecordingPermission, DUMMY_TOKEN } from "../../fake/ports.js"
import { answerOf, asserted, harness, runningWarehouse } from "../reads/harness.js"
import { recordStart } from "./support.js"
import { loadOptions } from "../../../src/options.js"

const NOW = 1_800_000_000_000
const history = (over: Partial<HistoryQuery> = {}): HistoryQuery => ({ queryId: "q-1", status: "RUNNING", warehouseId: "wh-small", queryStartTimeMs: NOW - 60_000, ...over })
const stopped: Warehouse = { ...runningWarehouse(), id: "wh-stopped", name: "bi-stopped", state: "STOPPED" }

const account = (over: Record<string, unknown> = {}) => ({
  alias: "work",
  mode: "interactive" as const,
  host: FAKE_HOST,
  cloud: "aws" as const,
  features: [],
  warehouse: "wh-small",
  enforcement: "role-requested" as const,
  role: { groupId: "7", name: "readers" },
  ...over,
})

/** A FakeAuth that refuses: the state before a sign-in exists. */
class RefusingAuth extends FakeAuth {
  override accounts() {
    return []
  }
  override account(): never {
    throw new DatabricksError("AUTH_REQUIRED")
  }
  override async token(): Promise<Token> {
    throw new DatabricksError("AUTH_REQUIRED")
  }
}

function setup(input: { options?: Record<string, unknown>; items?: HistoryQuery[]; warehouses?: Warehouse[]; auth?: FakeAuth; submit?: () => unknown } = {}) {
  const h = harness({
    ...(input.options ? { options: input.options } : {}),
    ...(input.auth ? { auth: input.auth } : {}),
    answers: {
      me: () => ({ id: "42", userName: "ada@example.com", displayName: "Ada" }),
      listWarehouses: () => input.warehouses ?? [runningWarehouse(), stopped],
      history: () => ({ items: input.items ?? [] }),
      getWarehouse: () => (input.warehouses ?? [runningWarehouse()]).find((warehouse) => warehouse.id === "wh-small") ?? runningWarehouse(),
      ...(input.submit ? { submit: input.submit } : {}),
    },
  })
  return h
}

describe("databricks_status", () => {
  it("asserts its own action first and answers the account, its identity, the role, scopes and the default warehouse", async () => {
    const h = setup({ auth: new FakeAuth([account()]) })
    const out = await statusHandler({}, h.call(), h.deps)
    expect(out.state).toBe("ok")
    expect(asserted(h.permission)).toEqual(["databricks.status on work:scim.me.get"])
    expect(out.accounts[0]).toMatchObject({
      alias: "work",
      mode: "interactive",
      host: FAKE_HOST,
      cloud: "aws",
      identity: { userName: "ada@example.com", id: "42", displayName: "Ada" },
      enforcement: "role-requested",
      role: "readers (requested)",
      writes: "without asking",
      scopes: ["sql", "unity-catalog", "query-history", "openid", "email", "profile", "offline_access"],
      warehouse: { id: "wh-small", state: "RUNNING", type: "serverless", size: "Small", autoStopMinutes: 10, usdPerHour: 8.4 },
    })
    expect(out.disclosure).toContain("For a hard limit, sign in with a read-only role.")
    expect(out.warnings?.[0]?.code).toBe("ESTIMATE_ONLY")
    // Free control-plane calls only: no statement was submitted.
    expect(h.databricks.calls.map((entry) => entry.method).sort()).toEqual(["history", "listWarehouses", "me"])
  })

  it("shows this plugin's running statements only, and offers a read a cancel but never a change", async () => {
    const h = setup({
      items: [
        history({ queryId: "read-1", queryTags: { oc_plugin: "databricks", oc_tool: "query" } }),
        history({ queryId: "change-1", queryTags: { oc_plugin: "databricks", oc_tool: "write" } }),
        history({ queryId: "other", queryTags: { oc_plugin: "something-else", oc_tool: "query" } }),
        history({ queryId: "done", status: "FINISHED", queryTags: { oc_plugin: "databricks", oc_tool: "query" } }),
      ],
    })
    recordStart(h.ledger, "work", "wh-small", NOW - 60_000)
    const out = await statusHandler({}, h.call(), h.deps)
    // `account` is the accepted Day 0 amendment (review of F, request 3); the cast goes when it lands.
    expect((out.running as unknown as { account: string; id: string }[]).map((item) => [item.account, item.id])).toEqual([["work", "read-1"], ["work", "change-1"]])
    const actions = out.cleanup ?? []
    expect(actions.some((action) => action.next.includes('databricks_cancel({ account: "work", statementId: "read-1" })'))).toBe(true)
    const change = actions.find((action) => action.what.includes("a write statement"))!
    expect(change.what).toContain("not cancelled here")
    expect(change.next).toContain("databricks_statement")
    // The warehouse: $8.40/h, a statement the identity can see is running on it, and one call to stop it.
    const warehouse = actions.find((action) => action.next.includes("databricks_stop"))!
    expect(warehouse.what).toContain("about $8.40/hour")
    expect(warehouse.what).toContain("a statement is running on it (read-1)")
    expect(warehouse.next).toContain('warehouse: "wh-small"')
    // No delete is ever suggested.
    expect(actions.every((action) => !/\bdelet/iu.test(action.next.replace("never deletes", "")))).toBe(true)
  })

  it("reads the ledger for today and this session, and reports the budget", async () => {
    const h = setup()
    await h.ledger.charge({ account: "work", warehouseId: "wh-small", kind: "start", dbuHours: 0.5 })
    await h.ledger.charge({ account: "work", sessionId: "ses_test", warehouseId: "wh-small", kind: "statement", dbuHours: 0.25 })
    const out = await statusHandler({}, h.call(), h.deps)
    expect(out.spend).toEqual({ startsToday: 1, dbuHoursToday: 0.75, dbuHoursSession: 0.25, estimate: true, budget: { state: "off" } })
  })

  it("says when an opt-in budget is reached", async () => {
    const h = setup({ options: { budget: { daily: { dbuHours: 1 }, action: "refuse" } } })
    await h.ledger.charge({ account: "work", warehouseId: "wh-small", kind: "start", dbuHours: 2 })
    expect((await statusHandler({}, h.call(), h.deps)).spend?.budget).toEqual({ state: "reached", limit: 1 })
  })

  it("reconciles the estimate with system.billing.usage through the read path, on a running warehouse only", async () => {
    const h = setup({ submit: () => answerOf({ rows: [["2.5", "2026-11-18"]] }) })
    const out = await statusHandler({ include: ["spend"] }, h.call(), h.deps)
    const sent = h.databricks.calls.find((entry) => entry.method === "submit")!.args[0] as Record<string, unknown>
    expect(String(sent.statement)).toContain("system.billing.usage")
    expect(String(sent.statement)).toContain("usage_metadata.warehouse_id = :warehouse")
    expect(String(sent.statement)).toContain("current_date")
    expect(String(sent.statement)).not.toContain("current_date()")
    expect((sent.parameters as { name: string }[])[0]?.name).toBe("warehouse")
    expect(sent.start).toBeUndefined()
    expect(sent.queryTags).toMatchObject({ oc_plugin: "databricks", oc_tool: "status" })
    expect(out.message).toContain("system.billing.usage reports 2.5 DBU")
    expect(out.message).toContain("within 12 hours")
    expect((out.spend as unknown as { reconciled?: unknown })?.reconciled).toEqual({ warehouse: "wh-small", usageDate: "2026-11-18", dbu: 2.5, complete: false })
    // The reconciliation read is charged like any read.
    expect((await h.ledger.totals("work")).dbuHoursToday).toBeGreaterThan(0)
  })

  it("reports a reconciliation that cannot run as a warning, and still answers the rest", async () => {
    const h = setup({ submit: () => ({ ...answerOf(), state: "FAILED", rows: undefined }) })
    const out = await statusHandler({ include: ["spend"] }, h.call(), h.deps)
    expect(out.state).toBe("ok")
    expect(out.accounts).toHaveLength(1)
    expect(out.message).toContain("did not return a figure")
    expect(out.warnings?.map((warning) => warning.code)).toEqual(["ESTIMATE_ONLY", "SPEND_UNAVAILABLE"])
    expect(out.next).toContain("/databricks-status")
  })

  it("M4: lists only this identity's own statements, never another user's tagged statement", async () => {
    const h = setup({
      items: [
        history({ queryId: "mine", userId: 42, queryTags: { oc_plugin: "databricks", oc_tool: "query" } }),
        history({ queryId: "someone-else", userId: 7, queryTags: { oc_plugin: "databricks", oc_tool: "query" } }),
      ],
    })
    const out = await statusHandler({}, h.call(), h.deps)
    expect((out.running as unknown as { id: string }[]).map((item) => item.id)).toEqual(["mine"])
    const asked = h.databricks.calls.find((entry) => entry.method === "history")!.args[1] as { userIds?: readonly number[] }
    expect(asked.userIds).toEqual([42])
  })

  it("scans and asserts only the account it is given", async () => {
    const h = setup({
      options: { accounts: { work: { warehouse: "wh-small" }, other: { warehouse: "wh-small" } } },
      auth: new FakeAuth([account(), account({ alias: "other" })]),
    })
    const before = h.databricks.calls.length
    const out = await statusHandler({ account: "other" }, h.call(), h.deps)
    expect(out.accounts.map((account) => account.alias)).toEqual(["other"])
    expect(asserted(h.permission)).toEqual(["databricks.status on other:scim.me.get"])
    expect(h.databricks.calls.length).toBeGreaterThan(before)
  })

  it("answers before a sign-in, with the workspace listed and the refusal as a problem", async () => {
    const h = setup({ auth: new RefusingAuth() })
    const out = await statusHandler({}, h.call(), h.deps)
    expect(out.state).toBe("ok")
    expect(out.accounts[0]).toMatchObject({ alias: "work", mode: "interactive", enforcement: "identity" })
    expect(out.accounts[0]?.identity).toBeUndefined()
    expect(out.message).toContain("AUTH_REQUIRED")
    expect(out.message).toContain("Next step")
    expect(h.databricks.calls).toEqual([])
  })

  it("shows a proven role without the requested suffix, and a service principal for m2m", async () => {
    const proven = setup({ auth: new FakeAuth([account({ enforcement: "role" })]) })
    expect((await statusHandler({}, proven.call(), proven.deps)).accounts[0]?.role).toBe("readers")
    const service = setup({
      options: { accounts: { ci: { mode: "m2m", warehouse: "wh-small", clientId: "client-id-example", clientSecretEnv: "DATABRICKS_CLIENT_SECRET" } } },
      auth: new FakeAuth([account({ alias: "ci", mode: "m2m", enforcement: "service-principal", role: undefined, warehouse: "wh-small" })]),
    })
    expect((await statusHandler({}, service.call(), service.deps)).accounts[0]).toMatchObject({ alias: "ci", mode: "m2m", enforcement: "service-principal" })
  })

  it("computes the UI status the command, the RPC and the TUI share, and it is valid", async () => {
    const h = setup({ items: [history({ queryId: "read-1", queryTags: { oc_plugin: "databricks", oc_tool: "query" } })] })
    const ctx = { agent: { list: async () => ({ data: [] }) }, skill: { list: async () => ({ data: [] }) } }
    const status = await computeStatus(ctx as never, h.deps, { hostVersion: "2.2.3", skills: [], problems: () => [] })
    expect(isStatus(status)).toBe(true)
    expect(status).toMatchObject({ state: "ready", access: "all", writes: "without asking", automation: { mode: "auto", active: true } })
    expect(status.running).toHaveLength(1)
    const rows = statusRows(status).map((row) => row.label)
    expect(rows).toEqual(["Connection", "Workspaces", "Access", "Writes", "Masks and filters", "Warehouses", "Running", "Spend", "Automation", "Cleanup", "Agents without default rules", "OpenCode", "Next step"])
    expect(formatStatus(status)).toContain("Databricks status")
    expect(formatStatus(status)).toContain("Cleanup:")
  })

  it("says no workspace configured only when there is none, and sign-in required otherwise", async () => {
    const h = setup({ auth: new RefusingAuth() })
    const ctx = { agent: { list: async () => ({ data: [] }) }, skill: { list: async () => ({ data: [] }) } }
    const status = await computeStatus(ctx as never, h.deps, { hostVersion: "2.2.3", skills: [], problems: () => [] })
    expect(status.state).toBe("sign_in_required")
    expect(status.nextStep).toContain("/connect")
  })

  it("reads the scopes a sign-in will ask for, from the account's choice", () => {
    const options = loadOptions({ accounts: { work: { features: ["jobs"], scopes: "all-apis" }, other: { features: ["files"] } } })
    expect(requestedScopes(options, "work")).toEqual(["all-apis", "offline_access"])
    expect(requestedScopes(options, "other")).toEqual(["sql", "unity-catalog", "query-history", "openid", "email", "profile", "offline_access", "files"])
  })

  it("automation is on at Allowed, off at the other levels, and on when the person says so", () => {
    expect(automationOf(loadOptions({}))).toEqual({ mode: "auto", active: true })
    expect(automationOf(loadOptions({ access: "ask-changes" }))).toEqual({ mode: "auto", active: false })
    expect(automationOf(loadOptions({ access: "read-only", automation: "on" }))).toEqual({ mode: "on", active: true })
    expect(automationOf(loadOptions({ automation: "off" }))).toEqual({ mode: "off", active: false })
  })

  it("never puts a token in a result", async () => {
    const h = setup()
    const out = await statusHandler({}, h.call(), h.deps)
    expect(JSON.stringify(out)).not.toContain(DUMMY_TOKEN)
    const permission = new RecordingPermission()
    expect(asserted(permission)).toEqual([])
  })
})
