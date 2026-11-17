// The one error table (design §12): the family form, and the README and docs rows generated from it.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { CODES, DatabricksError, ERRORS, errorRows, errorText } from "../../src/domain/errors.js"
import { Outputs } from "../../src/domain/contract.js"

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")
const block = (text: string) => /<!-- errors:start -->\n([\s\S]*?)\n<!-- errors:end -->/.exec(text)?.[1]

describe("errors", () => {
  it("are one sentence each, in the family form", () => {
    for (const code of CODES) {
      const { what, next } = ERRORS[code]
      expect(what, code).toMatch(/^[A-Z`a-z].*\.$/)
      expect(next, code).toMatch(/\.$/)
      expect(new DatabricksError(code).message).toBe(errorText(code, what, next))
    }
    expect(new DatabricksError("NEEDS_PLAN").message).toMatch(/^NEEDS_PLAN: .* Next step: Plan it with databricks_plan\(\{ sql \}\)\.$/)
  })

  it("README's Troubleshooting table and docs/errors.md are generated from the table", () => {
    expect(block(read("README.md"))).toBe(errorRows())
    expect(block(read("docs/errors.md"))).toBe(errorRows())
  })

  it("every code is a valid result error", () => {
    for (const code of CODES) expect(Outputs.query.safeParse({ state: ERRORS[code].state, error: code, trust: "untrusted" }).success, code).toBe(true)
  })

  it("include the design's codes and the review's additions", () => {
    for (const code of ["AUTH_REQUIRED", "AUTH_SCOPE_MISSING", "WAREHOUSE_STOPPED", "START_REFUSED", "NEEDS_PLAN", "IDENTIFIER_REFUSED", "SECRET_FUNCTION_REFUSED", "PLAN_CHANGED", "CLASSIFICATION_DRIFT", "PATH_NOT_DEFAULT", "SESSION_STATEMENT_REFUSED"]) expect(CODES).toContain(code)
  })
})
