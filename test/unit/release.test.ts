import { describe, expect, it } from "vitest"
import { DatabricksError } from "../../src/domain/errors.js"
import { guardedLiveFetch, WorkspaceHttp } from "../../src/process/http.js"
import { isLoopback, releaseTagIn, vendorCallsAllowed } from "../../src/release.js"
import { fakeAuth } from "./runtime/support.js"

describe("a source install does not call Databricks", () => {
  it("treats a module URL with a release tag as released, and a source path as not", () => {
    expect(releaseTagIn("file:///cache/@v1.2.3/dist/index.js")).toBe("v1.2.3")
    expect(releaseTagIn("github:joe-broadhead/opencode-databricks#v0.1.0")).toBe("v0.1.0")
    expect(vendorCallsAllowed()).toBe(false)
    expect(vendorCallsAllowed({ released: true })).toBe(true)
    expect(vendorCallsAllowed({ moduleUrl: "file:///pkg/@v0.1.0/dist/index.js" })).toBe(true)
    expect(isLoopback(new URL("http://127.0.0.1:9/"))).toBe(true)
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
