import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { ERRORS } from "../../src/domain/errors.js"
import { METHOD_NAMES } from "../../src/methods.js"

const registered = new Set(METHOD_NAMES.map((name) => `databricks_${name}`))
const literals = (text: string) => [...text.matchAll(/\bdatabricks_[a-z0-9_]+/g)].map((match) => match[0])

describe("error next steps", () => {
  it("name only registered methods in the shared table", () => {
    const text = Object.values(ERRORS)
      .flatMap((entry) => [entry.what, entry.next])
      .join("\n")
    for (const name of literals(text)) expect(registered.has(name), name).toBe(true)
  })

  it("name only registered methods in the commit and dependency refusals", () => {
    for (const file of ["src/handlers/changes/commit.ts", "src/provider/guards/dependencies.ts"]) {
      const text = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")
      for (const name of literals(text)) expect(registered.has(name), `${file}: ${name}`).toBe(true)
    }
  })
})
