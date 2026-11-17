// The redirect: the loopback URL a registered app connection names, and the host's relay (design §3.2, §18.1, L12).
import { describe, expect, it } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import { signInRedirect } from "../../../src/auth/redirect.js"

const codeOf = (input: { redirectUri?: string; callbackPort: number }): string => {
  try {
    signInRedirect(input)
    return "OK"
  } catch (error) {
    return error instanceof DatabricksError ? error.code : "OTHER"
  }
}

describe("the default loopback redirect", () => {
  it("is http://localhost:8765/callback, the URL the admin registers", () => {
    expect(signInRedirect({ callbackPort: 8765 })).toEqual({ uri: "http://localhost:8765/callback", port: 8765, paths: ["/callback"] })
  })

  it("uses the configured callback port", () => {
    expect(signInRedirect({ callbackPort: 9321 }).uri).toBe("http://localhost:9321/callback")
  })
})

describe("a host's relay", () => {
  it("is used exactly as given, and its own path is the one accepted", () => {
    expect(signInRedirect({ redirectUri: "https://id.example.com/connect/callback", callbackPort: 8765 })).toEqual({
      uri: "https://id.example.com/connect/callback",
      port: 8765,
      paths: ["/connect/callback"],
    })
  })

  it("may be a loopback http URL only when it names the callback port", () => {
    expect(signInRedirect({ redirectUri: "http://127.0.0.1:8765/callback", callbackPort: 8765 }).uri).toBe("http://127.0.0.1:8765/callback")
    expect(codeOf({ redirectUri: "http://127.0.0.1:9999/callback", callbackPort: 8765 })).toBe("AUTH_CLIENT_INVALID")
    expect(codeOf({ redirectUri: "http://localhost/callback", callbackPort: 8765 })).toBe("AUTH_CLIENT_INVALID")
  })

  it("refuses http off loopback, a space, credentials and an over-long URL", () => {
    expect(codeOf({ redirectUri: "http://id.example.com/connect/callback", callbackPort: 8765 })).toBe("AUTH_CLIENT_INVALID")
    expect(codeOf({ redirectUri: "https://id.example.com/connect/ callback", callbackPort: 8765 })).toBe("AUTH_CLIENT_INVALID")
    expect(codeOf({ redirectUri: "https://user:pass@id.example.com/connect/callback", callbackPort: 8765 })).toBe("AUTH_CLIENT_INVALID")
    expect(codeOf({ redirectUri: `https://id.example.com/${"a".repeat(300)}`, callbackPort: 8765 })).toBe("AUTH_CLIENT_INVALID")
    expect(codeOf({ redirectUri: "not a url", callbackPort: 8765 })).toBe("AUTH_CLIENT_INVALID")
  })

  it("refuses a callback port outside 1 to 65535", () => {
    expect(codeOf({ callbackPort: 0 })).toBe("AUTH_CLIENT_INVALID")
    expect(codeOf({ callbackPort: 70_000 })).toBe("AUTH_CLIENT_INVALID")
  })
})
