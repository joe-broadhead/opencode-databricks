// The source contract's conformance kit over the sources package.json declares. None is declared yet: `sources`
// arrives with the contract. This placeholder keeps the check gate's conformance stage in place until then.
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { sources?: unknown }

test("declares no source yet", () => {
  expect(pkg.sources).toBeUndefined()
})
