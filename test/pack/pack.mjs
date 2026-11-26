// The pack/start check: build the tarball, load the packed files through the real OpenCode 2.4.1 host, and — when the
// `opencode` CLI is available — install the committed bundle from this repository's git spec in an isolated HOME.
//
// OpenCode 2.4.1 rejects a local tarball path as a plugin target ("Plugin target must be an npm registry package or Git
// package specifier"), so the install proof uses `git+file://<repo>#<head sha>`; the packed tarball is always host-loaded.
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHost } from "@we-the-rebel-alliance/plugin-contract/kit"

const root = new URL("../..", import.meta.url).pathname
const work = mkdtempSync(join(root, "node_modules", ".pack-proof-"))
const isolated = mkdtempSync(join(tmpdir(), "databricks-install-"))
try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", work], { cwd: root, encoding: "utf8" }))[0]
  const files = packed.files.map((file) => file.path).sort()
  const required = ["dist/index.js", "package.json", "README.md", "LICENSE", "NOTICE", "skills/databricks/SKILL.md", "skills/databricks-sql/SKILL.md", "assets/icon.svg"]
  const missing = required.filter((file) => !files.includes(file))
  if (missing.length > 0) throw new Error(`the tarball is missing ${missing.join(", ")}`)
  const forbidden = files.filter((file) => file.startsWith("src/") || file.startsWith("test/") || file.startsWith("scripts/") || file.endsWith(".ts"))
  if (forbidden.length > 0) throw new Error(`the tarball carries source or test files: ${forbidden.join(", ")}`)

  const extract = join(work, "extract")
  execFileSync("mkdir", ["-p", extract])
  execFileSync("tar", ["-xzf", join(work, packed.filename), "-C", extract])
  const packedDir = join(extract, "package")
  const manifest = JSON.parse(readFileSync(join(packedDir, "package.json"), "utf8"))
  if (manifest.exports?.["./server"] !== "./dist/index.js") throw new Error("the packed package does not export ./server from dist/index.js")
  if (manifest.capabilities?.version !== 1 || manifest.capabilities?.plugin?.name !== "databricks") throw new Error("the packed manifest is not the databricks v1 manifest")

  // The packed files, loaded by the same embedded host T1 uses. The package sits under this repository's node_modules,
  // so the host modules resolve exactly as they do for a checkout.
  const run = await createHost({ directory: packedDir, version: "2.4.1", pluginId: "databricks" })
  try {
    if (run.failure !== undefined || run.refusal !== undefined || run.definition?.id !== "databricks") {
      throw new Error(`the packed plugin did not load: ${run.failure ?? run.refusal ?? "wrong id"}`)
    }
    if (run.tools.length !== 31) throw new Error(`the packed plugin loaded ${run.tools.length} tools, not 31`)
  } finally {
    await run.close()
  }

  let installed = "opencode CLI not on PATH"
  if (spawnSync("opencode", ["--version"], { encoding: "utf8" }).status === 0) {
    const home = join(isolated, "home")
    execFileSync("mkdir", ["-p", home])
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_CACHE_HOME: join(home, ".cache") }
    execFileSync("opencode", ["plugin", "add", `git+file://${root}#${sha}`], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    const installedFiles = readdirSync(home, { recursive: true }).map(String)
    const dist = installedFiles.find((file) => file.includes("@we-the-rebel-alliance/databricks-plugin") && file.endsWith("dist/index.js"))
    if (dist === undefined || !existsSync(join(home, dist))) throw new Error("the installed package has no dist/index.js")
    installed = `git install ${sha.slice(0, 9)} in an isolated HOME`
  }

  console.log(`pack: ${files.length} files, packed host load 31 tools, ${installed}`)
} finally {
  rmSync(work, { recursive: true, force: true })
  rmSync(isolated, { recursive: true, force: true })
}
