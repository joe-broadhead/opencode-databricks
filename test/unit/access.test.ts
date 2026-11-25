import { describe, expect, it } from "vitest"
import { effectFor, rulesFor } from "@we-the-rebel-alliance/plugin-contract/access"
import { manifest } from "../../src/manifest.js"
import { methodOf } from "../../src/methods.js"

describe("the warehouse start", () => {
  it("is a write with effect ask, so it asks even at all and is off at read-only", () => {
    const start = methodOf("start")
    expect(start.class).toBe("write")
    expect(start.effect).toBe("ask")
    expect(effectFor(start, "all")).toBe("ask")
    expect(effectFor(start, "ask-changes")).toBe("ask")
    expect(effectFor(start, "read-only")).toBe("deny")
  })

  it("generates an asking rule for databricks.start at all", () => {
    const rule = rulesFor(manifest, "all").find((entry) => entry.action === "databricks.start")
    expect(rule).toEqual({ action: "databricks.start", resource: "*", effect: "ask" })
  })
})
