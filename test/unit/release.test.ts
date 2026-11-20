import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabricksError } from "../../src/domain/errors.js"
import { guardedLiveFetch, WorkspaceHttp } from "../../src/process/http.js"
import { exactGitTag, installAllows, isLoopback, releaseTagIn, simulateTaggedRelease, vendorCallsAllowed, type InstallSource } from "../../src/release.js"
import { fakeAuth } from "./runtime/support.js"

// The host's own report, as stock OpenCode 2.3.2 sends it: the tag is in the spec, and `version` is the resolved commit.
const SHA = "8fa625bce989ff7c47a586eaa39340374ba43434"
const packageSource = (ref: string): InstallSource => ({ type: "package", target: `git+file:///cache/opencode-databricks#${ref}`, version: SHA })

describe("a source install does not call Databricks", () => {
  it("reads the tag from a package install's spec, not its commit version", () => {
    expect(installAllows(packageSource("v0.1.0"))).toBe(true)
    expect(installAllows(packageSource("v0.1.0-rc.1"))).toBe(true)
    expect(installAllows(packageSource("main"))).toBe(false)
    expect(installAllows({ type: "package", target: "github:joe-broadhead/opencode-databricks" })).toBe(false)
    expect(installAllows({ type: "local" })).toBe(false)
    expect(installAllows({ type: "builtin" })).toBe(false)
    expect(installAllows({ type: "sdk" })).toBe(false)
    expect(releaseTagIn("github:joe-broadhead/opencode-databricks#v0.1.0")).toBe("v0.1.0")
    expect(releaseTagIn("file:///cache/@v1.2.3/dist/index.js")).toBe("v1.2.3")
    expect(releaseTagIn(import.meta.url)).toBeUndefined()
    expect(isLoopback(new URL("http://127.0.0.1:9/"))).toBe(true)
  })

  it("treats a module URL with a release tag as released, and a source path as not", async () => {
    await expect(vendorCallsAllowed()).resolves.toBe(false)
    await expect(vendorCallsAllowed({ released: true })).resolves.toBe(true)
    await expect(vendorCallsAllowed({ moduleUrl: "file:///pkg/@v0.1.0/dist/index.js" })).resolves.toBe(true)
    simulateTaggedRelease(true)
    await expect(vendorCallsAllowed()).resolves.toBe(true)
    simulateTaggedRelease(undefined)
  })

  it("refuses the live fetch before it sends anything", async () => {
    const http = new WorkspaceHttp({
      auth: fakeAuth({ alias: "work", mode: "interactive", host: "https://workspace.example", cloud: "aws", features: [], enforcement: "identity" }),
    })
    const error = await http
      .request({ account: "work", method: "GET", operation: "sql.warehouses.list", path: "/api/2.0/sql/warehouses", idempotent: true, signal: new AbortController().signal })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DatabricksError)
    expect((error as DatabricksError).code).toBe("NOT_RELEASED")
    await expect(guardedLiveFetch("https://workspace.example/api/2.0/sql/warehouses")).rejects.toThrow(/^NOT_RELEASED: /)
  })
})

describe("the git-tag fallback", () => {
  it("accepts a checkout at a semver tag and refuses a source checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "databricks-release-"))
    try {
      const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      git("init", "--quiet")
      git("-c", "user.name=release test", "-c", "user.email=release@example.invalid", "commit", "--allow-empty", "-qm", "checkout")
      expect(exactGitTag(dir)).toBe(false)
      git("tag", "v0.0.1")
      expect(exactGitTag(dir)).toBe(true)
      git("-c", "user.name=release test", "-c", "user.email=release@example.invalid", "commit", "--allow-empty", "-qm", "later")
      git("tag", "0.0.2")
      expect(exactGitTag(dir)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
