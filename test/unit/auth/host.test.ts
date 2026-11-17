// Host validation per cloud (design §3.1): https only, the three workspace suffixes, the account consoles refused, and
// a custom host only with allowCustomHost. Nothing leaks the submitted value in the message.
import { describe, expect, it } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import { parseWorkspaceHost } from "../../../src/auth/host.js"

const codeOf = (value: string, allowCustomHost = false): string => {
  try {
    parseWorkspaceHost(value, allowCustomHost)
    return "OK"
  } catch (error) {
    return error instanceof DatabricksError ? error.code : "OTHER"
  }
}

describe("the workspace URL and its cloud", () => {
  it("accepts each cloud's workspace suffix and derives the cloud", () => {
    expect(parseWorkspaceHost("https://dbc-1234abcd-5678.cloud.databricks.com", false)).toEqual({ host: "https://dbc-1234abcd-5678.cloud.databricks.com", cloud: "aws" })
    expect(parseWorkspaceHost("https://adb-1234567890.12.azuredatabricks.net", false).cloud).toBe("azure")
    expect(parseWorkspaceHost("https://1234567890.12.gcp.databricks.com", false).cloud).toBe("gcp")
  })

  it("normalises case and a trailing slash", () => {
    expect(parseWorkspaceHost("  https://DBC-1234ABCD-5678.CLOUD.DATABRICKS.COM/  ", false).host).toBe("https://dbc-1234abcd-5678.cloud.databricks.com")
  })

  it("refuses http, a path, a query, a fragment and credentials", () => {
    expect(codeOf("http://dbc-1.cloud.databricks.com")).toBe("HOST_INVALID")
    expect(codeOf("https://dbc-1.cloud.databricks.com/workspace")).toBe("HOST_INVALID")
    expect(codeOf("https://dbc-1.cloud.databricks.com?x=1")).toBe("HOST_INVALID")
    expect(codeOf("https://dbc-1.cloud.databricks.com#x")).toBe("HOST_INVALID")
    expect(codeOf("https://user:pass@dbc-1.cloud.databricks.com")).toBe("HOST_INVALID")
    expect(codeOf("not a url")).toBe("HOST_INVALID")
    expect(codeOf("")).toBe("HOST_INVALID")
  })

  it("refuses the account console even when a custom host is allowed (account APIs are never called)", () => {
    expect(codeOf("https://accounts.cloud.databricks.com", true)).toBe("HOST_INVALID")
    expect(codeOf("https://accounts.azuredatabricks.net", true)).toBe("HOST_INVALID")
    expect(codeOf("https://accounts.gcp.databricks.com", true)).toBe("HOST_INVALID")
  })

  it("refuses another host without allowCustomHost, and admits it as custom with it", () => {
    expect(codeOf("https://databricks.example.com")).toBe("HOST_INVALID")
    expect(parseWorkspaceHost("https://databricks.example.com", true)).toEqual({ host: "https://databricks.example.com", cloud: "custom" })
    // A suffix match needs the dot: this is not an AWS workspace.
    expect(codeOf("https://evilcloud.databricks.com", true)).toBe("OK")
    expect(codeOf("https://evilcloud.databricks.com", false)).toBe("HOST_INVALID")
    expect(parseWorkspaceHost("https://evilcloud.databricks.com", true).cloud).toBe("custom")
  })

  it("refuses an explicit port on a Databricks workspace and allows one on a custom host", () => {
    expect(codeOf("https://dbc-1.cloud.databricks.com:8443")).toBe("HOST_INVALID")
    expect(parseWorkspaceHost("https://private.example.com:8443", true).host).toBe("https://private.example.com:8443")
  })

  it("P2: refuses lookalikes, backslash tricks, encoded paths, IDN and trailing dots", () => {
    expect(codeOf("https://x.cloud.databricks.com.evil.com")).toBe("HOST_INVALID")
    expect(codeOf("https://xcloud.databricks.com")).toBe("HOST_INVALID")
    expect(codeOf("https://cloud.databricks.com")).toBe("HOST_INVALID")
    expect(codeOf("https://evil.com\\@x.cloud.databricks.com")).toBe("HOST_INVALID")
    expect(codeOf("https://evil.com#@x.cloud.databricks.com")).toBe("HOST_INVALID")
    expect(codeOf("https://x.cloud.databricks.com@evil.com")).toBe("HOST_INVALID")
    expect(codeOf("https://u:p@x.cloud.databricks.com")).toBe("HOST_INVALID")
    expect(codeOf("https://x.cloud.databricks.com.")).toBe("HOST_INVALID")
    expect(codeOf("https://x.cloud.databricks.com%2f.evil.com")).toBe("HOST_INVALID")
    expect(codeOf("https://x.cloud.databricks.co%6d.evil.com")).toBe("HOST_INVALID")
    expect(codeOf("https://x.cloud.databrícks.com")).toBe("HOST_INVALID")
  })

  it("P2: WHATWG folds some characters into a real Databricks name, which stays inside the Databricks zone", () => {
    expect(parseWorkspaceHost("https://x。cloud.databricks.com", false).host).toBe("https://x.cloud.databricks.com")
    expect(parseWorkspaceHost("https://X.CLOUD.DATABRICKS.COM:443/", false).host).toBe("https://x.cloud.databricks.com")
    expect(parseWorkspaceHost("https://x.cloud.databricks.co%6d", false).host).toBe("https://x.cloud.databricks.com")
    expect(parseWorkspaceHost("https://ｘ.cloud.databricks.com", false).host).toBe("https://x.cloud.databricks.com")
  })

  it("never repeats the submitted value, which may carry a credential", () => {
    try {
      parseWorkspaceHost("https://hunter2:secret@dbc-1.cloud.databricks.com", false)
      expect.unreachable("the host should have been refused")
    } catch (error) {
      expect((error as Error).message).not.toContain("hunter2")
      expect((error as Error).message).not.toContain("secret")
    }
  })
})
