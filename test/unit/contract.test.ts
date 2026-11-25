// The source contract the plugin bundles: one tag, named the same in package.json, the lockfile, NOTICE and the docs,
// and the tools RPC entry points the plugin imports still exported by it.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as toolsRpc from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { PLUGIN_ID } from "../../src/constants.js"
import { TOOLS_RPC_ID } from "../../src/tools-rpc.js"

const root = fileURLToPath(new URL("../..", import.meta.url))
const read = (path: string) => readFileSync(join(root, path), "utf8")
const NAME = "@we-the-rebel-alliance/source-contract"
const TAG = "v0.3.0"

describe("the source contract", () => {
  it(`is pinned to ${TAG} everywhere it is named`, () => {
    const pkg = JSON.parse(read("package.json")) as { devDependencies: Record<string, string> }
    expect(pkg.devDependencies[NAME]).toBe(`github:we-the-rebel-alliance/source-contract#${TAG}`)
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { version?: string }> }
    expect(lock.packages[`node_modules/${NAME}`]?.version).toBe(TAG.slice(1))
    expect(read("NOTICE")).toContain(`## ${NAME} ${TAG.slice(1)} (MIT)`)
    expect(read("src/tools-rpc.ts")).toContain(`tag ${TAG}`)
    expect(read("docs/parser.md")).toContain("antlr4ng")
  })

  it("still exports the tools RPC entry points the plugin imports", () => {
    expect(typeof toolsRpc.registerToolsRpc).toBe("function")
    expect(typeof toolsRpc.toolsRpcId).toBe("function")
    expect(TOOLS_RPC_ID).toBe(`${PLUGIN_ID}.tools`)
  })
})

describe("the tools' schemas amended for packages E and F", () => {
  it("events_list takes since as a date-time with an offset (review of #8, request 5)", async () => {
    const { Inputs } = await import("../../src/domain/contract.js")
    expect(Inputs.events_list.safeParse({ source: "queries", since: "2026-11-18T09:00:00+01:00" }).success).toBe(true)
    expect(Inputs.events_list.safeParse({ source: "queries", since: "2026-11-18T08:00:00Z" }).success).toBe(true)
    expect(Inputs.events_list.safeParse({ source: "queries", since: "yesterday" }).success).toBe(false)
  })

  it("events_list answers the contract's page: source, account, owner, more, scope, plugin and a gap's since", async () => {
    const { Outputs } = await import("../../src/domain/contract.js")
    const page = { state: "ok", trust: "untrusted", source: "queries", account: "work", owner: { id: "databricks:host:user:1", label: "me@example.com" }, events: [], cursor: "c1", more: false, scope: { warehouses: ["wh-small"] }, gap: { reason: "expired", since: "2026-11-18T08:00:00.000Z" }, plugin: PLUGIN_ID }
    expect(Outputs.events_list.parse(page)).toEqual(page)
    expect(Outputs.events_list.safeParse({ ...page, gap: { reason: "expired" } }).success).toBe(false)
  })

  it("status names each running item's account and a reconciliation that is never complete (review of #10, request 3)", async () => {
    const { Outputs } = await import("../../src/domain/contract.js")
    const running = { kind: "statement", account: "work", id: "01ef-statement", startedAt: "2026-11-18T08:00:00Z", tool: "query" }
    const base = { state: "ok", access: "all", accounts: [], automation: { mode: "auto", active: false, owner: false }, disclosure: "d" }
    const spend = { startsToday: 0, dbuHoursToday: 0, dbuHoursSession: 0, estimate: true, budget: { state: "off" } }
    expect(Outputs.status.safeParse({ ...base, running: [running] }).success).toBe(true)
    const { account: _, ...noAccount } = running
    expect(Outputs.status.safeParse({ ...base, running: [noAccount] }).success).toBe(false)
    expect(Outputs.status.safeParse({ ...base, running: [], spend: { ...spend, reconciled: { warehouse: "wh-small", usageDate: "2026-11-18", dbu: 3.5, complete: false } } }).success).toBe(true)
    expect(Outputs.status.safeParse({ ...base, running: [], spend: { ...spend, reconciled: { warehouse: "wh-small", usageDate: "2026-11-18", dbu: 3.5, complete: true } } }).success).toBe(false)
  })
})
