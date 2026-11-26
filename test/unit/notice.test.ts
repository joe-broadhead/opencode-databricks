// The release tarball ships NOTICE next to a bundle that inlines third-party code. This test builds the server entry
// with the same externals as scripts/build.mjs, collects the packages that actually end up in the bundle (package name
// and version from each package's own package.json), and requires the verbatim licence text for each in NOTICE.
import { build } from "esbuild"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/u, "")
const PLUGIN = "@we-the-rebel-alliance/databricks-plugin"

interface BundledPackage {
  readonly name: string
  readonly version: string
  readonly license: string
  readonly text: string
}

/** The nearest package.json with a name, for an esbuild input path, or undefined for the plugin's own sources. */
function packageDir(path: string): string | undefined {
  let dir = dirname(join(root, path))
  for (;;) {
    if (dir !== root && dir.startsWith(`${root}${sep}`) && existsSync(join(dir, "package.json"))) {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown }
      if (typeof pkg.name === "string") return pkg.name === PLUGIN ? undefined : dir
    }
    if (dir === root || !dir.startsWith(`${root}${sep}`)) return undefined
    dir = dirname(dir)
  }
}

function readPackage(dir: string): BundledPackage {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string; version: string; license: string }
  const file = readdirSync(dir).find((entry) => /^(licen[cs]e|copying)(\.|$)/i.test(entry))
  if (file === undefined) throw new Error(`${pkg.name} is bundled but ships no licence file`)
  return { name: pkg.name, version: pkg.version, license: pkg.license, text: readFileSync(join(dir, file), "utf8").trim() }
}

/** Every package esbuild actually inlines into the server bundle, in name order. */
async function bundledPackages(): Promise<BundledPackage[]> {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [{ in: join(root, "src/index.ts"), out: "index" }],
    outdir: join(root, "dist"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    external: ["@opencode/*"],
    legalComments: "none",
    sourcemap: false,
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    metafile: true,
    write: false,
    logLevel: "silent",
  })
  const dirs = new Map<string, string>()
  for (const input of Object.keys(result.metafile.inputs)) {
    const dir = packageDir(input)
    if (dir !== undefined) dirs.set(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name, dir)
  }
  return [...dirs.values()].map(readPackage).sort((left, right) => left.name.localeCompare(right.name))
}

function heading(item: BundledPackage): string {
  return `## ${item.name} ${item.version} (${item.license})`
}

describe("the bundled third-party notices", () => {
  test("every bundled package has its verbatim licence in NOTICE", async () => {
    const packages = await bundledPackages()
    expect(packages.map((item) => item.name)).toEqual(
      expect.arrayContaining(["@we-the-rebel-alliance/plugin-contract", "antlr4ng", "yaml", "zod"]),
    )
    const notice = readFileSync(join(root, "NOTICE"), "utf8")
    for (const item of packages) {
      expect(notice, item.name).toContain(heading(item))
      expect(notice, item.name).toContain(item.text)
    }
  })

  test("a missing section is reported", async () => {
    const notice = readFileSync(join(root, "NOTICE"), "utf8")
    const packages = await bundledPackages()
    const withoutAntlr = notice.replace(/^## antlr4ng[\s\S]*?(?=^## |\s*$)/m, "")
    expect(packages.filter((item) => !withoutAntlr.includes(heading(item))).map((item) => item.name)).toContain("antlr4ng")
  })
})
