import { describe, expect, it } from "vitest"
import { analyzeRead } from "../../src/provider/sql/analyze.js"

describe("the read path", () => {
  it("accepts one read and names a three-part table", () => {
    const analysis = analyzeRead("SELECT count(*) FROM main.default.orders")
    expect(analysis.ok).toBe(true)
    if (analysis.ok) {
      expect(analysis.sent).toContain("SELECT")
      expect(analysis.tables.map((table) => table.parts.join("."))).toContain("main.default.orders")
    }
  })

  it("refuses a second statement after a semicolon", () => {
    const analysis = analyzeRead("SELECT 1; DROP TABLE main.default.orders")
    expect(analysis.ok).toBe(false)
    if (!analysis.ok) expect(analysis.refusal.code).toBe("STATEMENT_NOT_READ")
  })

  it("refuses a session statement", () => {
    const analysis = analyzeRead("USE CATALOG main")
    expect(analysis.ok).toBe(false)
  })
})
