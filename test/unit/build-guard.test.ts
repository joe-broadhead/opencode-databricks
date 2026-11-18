// The build's guard against a minified TUI bundle (`scripts/build.mjs` `MINIFIED_IMPORT`; review of #10, request 1).
// OpenCode's loader cannot resolve a minified import in a local-path install, so the build throws when `dist/tui.js`
// has one. The regex is read from the build script itself, so this pins the guard that actually runs.
import { readFileSync } from "node:fs"
import { transform } from "esbuild"
import { describe, expect, it } from "vitest"

const source = readFileSync(new URL("../../scripts/build.mjs", import.meta.url), "utf8")
const literal = /^const MINIFIED_IMPORT = \/(.+)\/([a-z]*)$/mu.exec(source)
if (!literal) throw new Error("scripts/build.mjs has no MINIFIED_IMPORT literal")
const MINIFIED_IMPORT = new RegExp(literal[1]!, literal[2])

describe("the build's minified-import guard", () => {
  it("is the corrected regex", () => {
    expect(MINIFIED_IMPORT.source).toBe(String.raw`(?<!["'` + "`" + String.raw`\w$.])(?:from|import)["']`)
  })

  it.each([
    'import*as x from"y"',
    'import"x"',
    "import'x'",
    'export*from"x"',
    'export*as n from"x"',
    'export{a}from"x"',
    'import{a}from"x"',
    'import a from"x"',
    ';import"x";',
  ])("matches a minified import: %s", (text) => {
    expect(MINIFIED_IMPORT.test(text)).toBe(true)
  })

  it.each([
    'const s="from"',
    '{from:"x"}',
    "a['from']",
    'o.from("x")',
    'Array.from("x")',
    'import("x")',
    '`from"`',
    'x.import"',
    '$from"',
    'import { a } from "x"',
    'import "x"',
  ])("does not match: %s", (text) => {
    expect(MINIFIED_IMPORT.test(text)).toBe(false)
  })

  it("matches esbuild's minified output of a module, and not the same module bundled plain", async () => {
    const module = 'import { a } from "x"\nimport "y"\nexport * from "z"\nexport const s = "from" + Array.from("q") + a\n'
    const plain = await transform(module, { format: "esm", loader: "ts", minify: false })
    const minified = await transform(module, { format: "esm", loader: "ts", minify: true })
    expect(MINIFIED_IMPORT.test(plain.code)).toBe(false)
    expect(MINIFIED_IMPORT.test(minified.code)).toBe(true)
  })
})
