/**
 * The TUI build guard (review of F, request 1; the corrected regex from the review of boxd #31, LOW 1). `scripts/build.mjs`
 * bundles `dist/tui.js` unminified and fails if the output carries a minified import, because OpenCode's loader cannot
 * resolve one from a local-path install. This test pins the regex's behaviour on the forms the reviews named, and on a
 * real minified esbuild bundle, so a later simplification cannot quietly weaken it.
 */
import { readFileSync } from "node:fs"
import { build } from "esbuild"
import { describe, expect, it } from "vitest"

/** The guard as `scripts/build.mjs` declares it; the file is the one source of truth. */
function guard(): RegExp {
  const source = readFileSync(new URL("../../../scripts/build.mjs", import.meta.url), "utf8")
  const match = /^const MINIFIED_IMPORT = \/(.*)\/([a-z]*)$/mu.exec(source)
  if (!match) throw new Error("scripts/build.mjs no longer declares MINIFIED_IMPORT on one line")
  return new RegExp(match[1]!, match[2]!)
}

const MATCHES = [
  'import{a}from"x"',
  'import*as a from"x"',
  'import a from"x"',
  'import a,{b}from"x"',
  'import"x"',
  "import'x'",
  'export{a}from"x"',
  'export*from"x"',
  'export*as n from"x"',
  ';import"x";',
]

const NON_MATCHES = [
  'const s="from"',
  '{from:"x"}',
  "a['from']",
  'a["import"]',
  'o.from("x")',
  'Array.from("x")',
  'import("x")',
  '`from"`',
  'x.import"',
  '$from"',
  'import x from "y"',
  'import "x"',
  'export {a} from "x"',
]

describe("the TUI guard", () => {
  it("matches every minified import form", () => {
    const pattern = guard()
    for (const sample of MATCHES) expect(pattern.test(sample), sample).toBe(true)
  })

  it("does not match a string, a property, a call or the plain spaced form", () => {
    const pattern = guard()
    for (const sample of NON_MATCHES) expect(pattern.test(sample), sample).toBe(false)
  })

  it("matches a real minified esbuild bundle and not the same one unminified", async () => {
    const source = 'import { createSignal } from "solid-js"\nimport { render } from "@opentui/solid"\nconsole.log(createSignal, render)\n'
    const bundle = async (minify: boolean) => {
      const result = await build({
        stdin: { contents: source, loader: "js" },
        bundle: true,
        write: false,
        format: "esm",
        external: ["solid-js", "@opentui/solid"],
        minify,
        logLevel: "silent",
      })
      return result.outputFiles[0]!.text
    }
    const plain = await bundle(false)
    const minified = await bundle(true)
    expect(minified).toContain('from"solid-js"')
    expect(guard().test(plain), plain).toBe(false)
    expect(guard().test(minified), minified).toBe(true)
  })
})
