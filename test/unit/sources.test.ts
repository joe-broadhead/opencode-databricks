import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { acceptAnswer } from "@we-the-rebel-alliance/plugin-contract/read"
import { decodeBoundCursor } from "@we-the-rebel-alliance/plugin-contract/cursor"
import { manifest } from "../../src/manifest.js"

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/conformance.json", import.meta.url), "utf8"))

describe("the recorded sources", () => {
  for (const source of manifest.sources) {
    it(`${source.id} records an answer the contract's reader accepts`, () => {
      const recorded = fixture.sources[source.id]
      if (source.kind === "events") {
        for (const item of recorded.cases) {
          const accepted = acceptAnswer(source, item.answer.account, item.answer)
          expect(accepted.ok, accepted.ok ? "" : JSON.stringify(accepted.failure)).toBe(true)
        }
      } else {
        const accepted = acceptAnswer(source, "work", recorded.snapshot.answer)
        expect(accepted.ok, accepted.ok ? "" : JSON.stringify(accepted.failure)).toBe(true)
      }
    })
  }

  it("refuses one account's cursor under another account", () => {
    const page = fixture.sources["databricks.queries"].cases[0].answer
    const decoded = decodeBoundCursor({ plugin: "databricks", source: "queries", account: "personal" }, page.cursor)
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.reason).toBe("foreign")
  })
})
