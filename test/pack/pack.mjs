// The pack check: the tarball OpenCode would install carries the server bundle, the skills and the manifest, and no
// source or test files. T1 loads the same built bundle on the real host.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = new URL("../..", import.meta.url).pathname
const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--dry-run"], { cwd: root, encoding: "utf8" }))[0]
const files = packed.files.map((file) => file.path).sort()
const required = ["dist/index.js", "package.json", "README.md", "LICENSE", "skills/databricks/SKILL.md", "skills/databricks-sql/SKILL.md", "assets/icon.svg"]
const missing = required.filter((file) => !files.includes(file))
if (missing.length > 0) throw new Error(`the tarball is missing ${missing.join(", ")}`)
const forbidden = files.filter((file) => file.startsWith("src/") || file.startsWith("test/") || file.startsWith("scripts/") || file.endsWith(".ts"))
if (forbidden.length > 0) throw new Error(`the tarball carries source or test files: ${forbidden.join(", ")}`)
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
if (manifest.exports?.["./server"] !== "./dist/index.js") throw new Error("the package does not export ./server from dist/index.js")
if (manifest.capabilities?.version !== 1 || manifest.capabilities?.plugin?.name !== "databricks") throw new Error("the manifest is not the databricks v1 manifest")
console.log(`pack: ${files.length} files, ./server -> dist/index.js, manifest v1`)
