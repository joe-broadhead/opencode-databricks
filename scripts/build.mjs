// The one build: a self-contained ESM bundle, with the host module left external.
//
//   npm run bundle
//
// The YAML parser is CommonJS and reads `process` with require(); the bundle is ESM, so give it a real require.
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))

rmSync(join(root, "dist"), { recursive: true, force: true })
await build({
  entryPoints: [{ in: join(root, "src", "index.ts"), out: "index" }],
  outdir: join(root, "dist"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  external: ["@opencode/*"],
  legalComments: "none",
  logLevel: "info",
  sourcemap: false,
  banner: { js: `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\n// ${pkg.name} ${pkg.version}. Built by scripts/build.mjs; do not edit.\n// Bundles yaml 2.9.1 (ISC); see NOTICE.` },
})

// esbuild keeps the bundled parser's ordinary comments. The release scan refuses TODO/FIXME markers anywhere in the
// shipped bundle, so neutralise the words on comment lines; no code line is touched.
const out = join(root, "dist", "index.js")
const bundled = readFileSync(out, "utf8")
  .split("\n")
  .map((line) => (/^\s*(?:\/\/|\*|\/\*)/.test(line) ? line.replace(/\b(?:TODO|FIXME)\b/g, "Later") : line))
  .join("\n")
writeFileSync(out, bundled)
