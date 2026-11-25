import { describe, expect, it } from "vitest"
import * as z from "zod"
import { LIST_OPTIONS_SCHEMA, PAGE_SCHEMA, PROBE_SCHEMA } from "@we-the-rebel-alliance/plugin-contract/events"
import { STATUS_SCHEMA } from "@we-the-rebel-alliance/plugin-contract/accounts"
import { createHandlers } from "../../src/handlers/index.js"
import { Inputs, Outputs } from "../../src/handlers/schemas.js"
import { METHOD_NAMES, methodOf } from "../../src/methods.js"
import { manifest, version } from "../../src/manifest.js"
import { readFileSync } from "node:fs"
import type { Deps } from "../../src/handlers/deps.js"

const deps = {} as Deps
const table = createHandlers({ deps, manifest, version, hostVersion: "2.4.1", accountProblems: [] })

describe("the handler table", () => {
  it("has one handler for every declared method and no other", () => {
    expect(Object.keys(table).sort()).toEqual(Object.keys(manifest.methods).sort())
  })

  it("gives every method an object input schema that zod can read", () => {
    for (const [name, handler] of Object.entries(table)) {
      expect(handler.input.type, name).toBe("object")
      expect(() => z.fromJSONSchema(handler.input), name).not.toThrow()
    }
  })

  it("gives every method an answer schema that zod can read", () => {
    for (const [name, handler] of Object.entries(table)) {
      expect(() => z.fromJSONSchema(handler.output), name).not.toThrow()
    }
  })

  it("reuses the contract's page, probe, status and list-options schemas", () => {
    expect(table.events_list?.output).toEqual(PAGE_SCHEMA)
    expect(table.probe?.output).toEqual(PROBE_SCHEMA)
    expect(table.status?.output).toEqual(STATUS_SCHEMA)
    expect(table.saved_list?.output).toEqual(LIST_OPTIONS_SCHEMA)
  })

  it("requires trust on every plugin-owned success answer schema", () => {
    // status and saved_list use the contract's closed STATUS_SCHEMA and LIST_OPTIONS_SCHEMA, which do not define trust.
    const contractOwned = new Set(["status", "saved_list"])
    for (const [name, schema] of Object.entries(Outputs)) {
      if (contractOwned.has(name)) continue
      const json = z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }) as { required?: string[] }
      expect(json.required, name).toContain("trust")
    }
  })

  it("keeps the account selector out of a handler's input, and out of a commit", () => {
    for (const method of METHOD_NAMES.map(methodOf)) {
      const handler = table[method.name]!
      const properties = (handler.input as { properties?: Record<string, unknown> }).properties ?? {}
      if (method.commits !== undefined) expect(properties).toHaveProperty("planId")
      else expect(properties).not.toHaveProperty("planId")
      if (method.commits === undefined) expect(properties).not.toHaveProperty("account")
    }
  })

  it("accepts the recorded snapshot with its own output schema", () => {
    const fixture = JSON.parse(readFileSync(new URL("../../fixtures/conformance.json", import.meta.url), "utf8"))
    const answer = fixture.sources["databricks.saved"].snapshot.answer
    expect(Outputs.saved_read.safeParse(answer).success).toBe(true)
  })

  it("accepts every input and output schema's own defaults", () => {
    for (const schema of Object.values(Inputs)) expect(() => z.toJSONSchema(schema, { unrepresentable: "any" })).not.toThrow()
    for (const schema of Object.values(Outputs)) expect(() => z.toJSONSchema(schema, { unrepresentable: "any" })).not.toThrow()
  })
})
