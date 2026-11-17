// package.json's `sources` against source-contract v0.2.0: `assertDeclaration` with the tools RPC's methods as the
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
