// The one build: a self-contained ESM bundle, with the host module left external.
//
//   npm run bundle
//
// The YAML parser is CommonJS and reads `process` with require(); the bundle is ESM, so give it a real require.
import { readFileSync, rmSync } from "node:fs"
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
