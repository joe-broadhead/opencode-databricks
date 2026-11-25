import { describe, expect, it } from "vitest"
import { MAX_CURSOR_LENGTH, encodeBoundCursor } from "@we-the-rebel-alliance/plugin-contract/cursor"
import { K_CHARS, Z_CHARS, after as afterLine, bindingOf, decodeState, encodeState } from "../../src/handlers/sources/cursor.js"

const binding = bindingOf("queries", "work", undefined)
const now = Date.UTC(2026, 10, 25, 12, 0, 0)
const external = `dbc-1.cloud.databricks.com:${"x".repeat(40)}`

describe("the cursor's listing line", () => {
  it("orders same-end items by external id", () => {
    expect(afterLine(now, "host:b", now, "host:a")).toBe(true)
    expect(afterLine(now, "host:a", now, "host:a")).toBe(false)
    expect(afterLine(now + 1, "host:a", now, "host:z")).toBe(true)
  })

  it("round-trips an external id in k and stays within the cursor bound", () => {
    const cursor = encodeState(binding, {
      e: now,
      l: now,
      k: external,
      z: "a".repeat(Z_CHARS),
      n: now,
      m: now,
      d: 1,
      t: now,
      r: { at: now, hold: 60_000 },
      h: { hold: 60_000, seen: now },
    })
    expect(cursor.length).toBeLessThanOrEqual(MAX_CURSOR_LENGTH)
    const decoded = decodeState(binding, cursor)
    expect(decoded.ok).toBe(true)
    if (decoded.ok) expect(decoded.state.k).toBe(external)
  })

  it("refuses a k that is not a bounded external id", () => {
    const tooLong = encodeBoundCursor(binding, { e: now, l: now, k: `host:${"x".repeat(K_CHARS)}` })
    const decoded = decodeState(binding, tooLong)
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.code).toBe("CURSOR_INVALID")
  })
})
