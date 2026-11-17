/**
 * The codes the contract adds in its Day 0 follow-up (review `databricks-4.md`, contract requests 5): `INLINE_WITHHELD`,
 * `RUN_SIZE_REFUSED`, and the warnings `BUDGET_OVER` and `PATH_READ`. Until `src/domain/errors.ts` holds them a code
 * cannot be raised — the table is the only place its words come from — so `src/guards/codes.ts` answers the code that
 * means the same thing today and the new one as soon as the entry exists. This test pins that switch, so the Day 0
 * change needs no edit here.
 */
import { describe, expect, it } from "vitest"
import { ERRORS, WARNINGS } from "../../../src/domain/errors.js"
import { addedCode, addedWarning } from "../../../src/guards/codes.js"

describe("the follow-up codes", () => {
  it("answers the new code once the error table has it, and the fallback until then", () => {
    // Today's table has neither; the guards answer FENCED and START_REFUSED, and their suites pin that.
    expect(Object.hasOwn(ERRORS, "INLINE_WITHHELD")).toBe(false)
    expect(addedCode("INLINE_WITHHELD", "FENCED")).toBe("FENCED")
    expect(addedCode("RUN_SIZE_REFUSED", "START_REFUSED")).toBe("START_REFUSED")
    // A code the table does hold comes back as itself, so the same helper works after the Day 0 change.
    expect(addedCode("NOT_FOUND", "FENCED")).toBe("NOT_FOUND")
  })

  it("answers a new warning once the warning table has it, and nothing until then", () => {
    expect(addedWarning("PATH_READ", "x")).toBeUndefined()
    expect(addedWarning("ESTIMATE_ONLY", "x")).toEqual({ code: "ESTIMATE_ONLY", message: "x" })
    expect(Object.hasOwn(WARNINGS, "BUDGET_OVER")).toBe(false)
  })
})
