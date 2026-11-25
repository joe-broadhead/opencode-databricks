// The one build: a self-contained ESM bundle, with the host module left external. No runtime dependency ships.
import { build } from "esbuild"

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: ["@opencode/plugin"],
  logLevel: "info",
  legalComments: "none",
  sourcemap: false,
})
