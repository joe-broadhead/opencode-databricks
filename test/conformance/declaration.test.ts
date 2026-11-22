// package.json's `sources` against source-contract v0.3.0: `assertDeclaration` with the tools RPC's methods as the
// declared tools, the descriptor as a consumer reads it from the install, and the RPC id the plugin registers.
// Package E adds the conformance kit's run over events_list, saved_read and probe (test/conformance/sources.test.ts).
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { assertDeclaration, declarationProblems, operationProblem } from "@we-the-rebel-alliance/source-contract/conformance"
import { readInstalledDescriptor } from "@we-the-rebel-alliance/source-contract/descriptor"
import { OPERATIONS, PROBE_ACTION, TOOLS } from "../../src/domain/actions.js"
import { METHOD_NAMES, TOOLS_RPC_ID } from "../../src/tools-rpc.js"

const ROOT = join(import.meta.dir, "..", "..")
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { sources: { rpc: string; probe: { action: string }; items: { id: string; tool: string; permission: { operations: string[] } }[] } }

/** The tools RPC's methods, as describe lists them: the read tools, probe and saved_list, all read-only. */
const tools = METHOD_NAMES.map((id) => ({ id, readOnly: id === "probe" || id === "saved_list" || TOOLS.find((tool) => tool.name === id)?.readOnly === true }))

test("the sources block passes assertDeclaration with the plugin's methods", () => {
  expect(declarationProblems(pkg.sources, { tools })).toEqual([])
  expect(() => assertDeclaration(pkg.sources, { tools })).not.toThrow()
})

test("a negative control: the validator fires on a write verb and a missing tool", () => {
  const bad = structuredClone(pkg.sources)
  bad.items[2]!.permission.operations.push("sql.statements.execute")
  bad.items[0]!.tool = "nope"
  expect(declarationProblems(bad, { tools }).length).toBeGreaterThan(0)
})

test("names only the plugin's own operations, each a valid read operation", () => {
  for (const item of pkg.sources.items) for (const operation of item.permission.operations) {
    expect((OPERATIONS as readonly string[]).includes(operation), operation).toBe(true)
    expect(operationProblem(operation), operation).toBeUndefined()
  }
})

test("a consumer reads the descriptor from the install", () => {
  const installed = readInstalledDescriptor(ROOT)
  if (!installed.ok) throw new Error(installed.problems.join("; "))
  expect(installed.ok).toBe(true)
})

test("names the RPC the plugin registers, its probe action, and the three v0.1.0 sources", () => {
  expect(pkg.sources.rpc).toBe(TOOLS_RPC_ID)
  expect(pkg.sources.probe.action).toBe(PROBE_ACTION)
  expect(pkg.sources.items.map((item) => [item.id, item.tool])).toEqual([["databricks.queries", "events_list"], ["databricks.runs", "events_list"], ["databricks.saved", "saved_read"]])
})

/**
 * Keys source-contract v0.2.0 added that a v0.1.x consumer refuses. Jelly master and Memory pin v0.1.0, so a declaration
 * with any of them is refused at install (review of #8, H3, the release blocker). They come back once both consumers
 * are on v0.2.0 (CHANGELOG). Returns each held key's path in `sources`.
 */
function heldKeys(sources: unknown): string[] {
  const found: string[] = []
  const isPrice = (value: Record<string, unknown>) => "per" in value && "usd" in value
  const visit = (value: unknown, path: readonly string[]) => {
    if (Array.isArray(value)) return value.forEach((entry, index) => visit(entry, [...path, String(index)]))
    if (value === null || typeof value !== "object") return
    const object = value as Record<string, unknown>
    const parent = path.at(-1)
    for (const [key, entry] of Object.entries(object)) {
      const at = [...path, key].join(".")
      if (key === "removals" || key === "identityRules" || key === "readsIdentity") found.push(at)
      if (key === "server" && parent === "accounts") found.push(at)
      if (key === "verified" && parent === "owner") found.push(at)
      if (key === "identity" && parent === "permission" && Array.isArray(entry) && entry.length === 0) found.push(at)
      if ((key === "conditions" || key === "min") && isPrice(object)) found.push(at)
      visit(entry, [...path, key])
    }
  }
  visit(sources, [])
  return found
}

test("holds every key a v0.1.x consumer refuses (review of #8, H3): none appears in sources", () => {
  expect(heldKeys(pkg.sources)).toEqual([])
})

test("a negative control: each held key is found where v0.2.0 would put it", () => {
  const bad = structuredClone(pkg.sources) as unknown as {
    removals?: unknown[]
    items: { accounts: Record<string, unknown>; permission: Record<string, unknown>; cost: { units?: Record<string, unknown>[]; probe?: Record<string, unknown> }; owner?: Record<string, unknown> }[]
    identityRules?: unknown[]
  }
  bad.removals = []
  bad.identityRules = []
  bad.items[0]!.permission.readsIdentity = true
  bad.items[0]!.accounts.server = true
  bad.items[0]!.owner = { verified: false }
  bad.items[1]!.permission.identity = []
  bad.items[2]!.cost.units![0]!.min = 0.22
  bad.items[2]!.cost.units![0]!.conditions = "Runs only on a running warehouse"
  expect(heldKeys(bad).sort()).toEqual(
    [
      "removals",
      "identityRules",
      "items.0.permission.readsIdentity",
      "items.0.accounts.server",
      "items.0.owner.verified",
      "items.1.permission.identity",
      "items.2.cost.units.0.min",
      "items.2.cost.units.0.conditions",
    ].sort(),
  )
})

test("keeps the saved source's price honest on its own: a DBU price, never zero", () => {
  const saved = pkg.sources.items[2] as unknown as { cost: { class: string; units: { per: string; usd: number }[] }; scope: { describe: string } }
  expect(saved.cost.class).toBe("billed")
  expect(saved.cost.units).toEqual([{ per: "dbu", usd: 0.7 }])
  expect(saved.scope.describe).toContain("Each read runs only on a warehouse that is already running, which then stays up until it auto-stops.")
})
