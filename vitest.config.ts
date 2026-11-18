import { readFileSync } from "node:fs"
import { defineConfig } from "vitest/config"

// The build replaces __PLUGIN_VERSION__ (src/version.ts) the same way. test/unit/setup.ts warms the SQL parser in every
// worker before its tests, so its one-time start-up is never billed to a test.
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }

export default defineConfig({ define: { __PLUGIN_VERSION__: JSON.stringify(version) }, test: { include: ["test/unit/**/*.test.ts"], setupFiles: ["test/unit/setup.ts"] } })
