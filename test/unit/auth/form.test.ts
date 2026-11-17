// The sign-in form (design §3.1, §3.2): the fields, the disclosure in the role's help, the hidden relay fields a host
// fills, and an answer read without ever contacting Databricks.
import { describe, expect, it } from "vitest"
import { WRITE_DISCLOSURE } from "../../../src/domain/contract.js"
import { DatabricksError } from "../../../src/domain/errors.js"
import { accountSettings } from "../../../src/auth/accounts.js"
import { readSignInAnswer, signInForm, type IntegerField, type StringField } from "../../../src/auth/form.js"
import { loadOptions } from "../../../src/options.js"

const settings = (raw: Record<string, unknown> = {}) => accountSettings(loadOptions(raw))[0]!
const field = (form: ReturnType<typeof signInForm>, key: string) => form.find((entry) => entry.key === key) as StringField | IntegerField

const codeOf = (run: () => unknown): string => {
  try {
    run()
    return "OK"
  } catch (error) {
    return error instanceof DatabricksError ? error.code : "OTHER"
  }
}

describe("the sign-in form", () => {
  it("asks for the workspace URL, the client ID, the scope set, an optional role, then two hidden relay fields", () => {
    const form = signInForm(settings(), { callbackPort: 8765 })
    expect(form.map((entry) => entry.key)).toEqual(["host", "clientId", "scopes", "role", "redirectUri", "callbackPort"])
    expect(field(form, "host")).toMatchObject({ type: "string", required: true, placeholder: "https://dbc-1234abcd-5678.cloud.databricks.com" })
    expect(field(form, "clientId")).toMatchObject({ type: "string", required: true })
    expect(field(form, "scopes")).toMatchObject({ type: "string", required: true, default: "fine" })
    expect(field(form, "role")).toMatchObject({ type: "string", required: false })
    for (const key of ["redirectUri", "callbackPort"]) expect(field(form, key)).toMatchObject({ hidden: true, required: false })
    expect(field(form, "callbackPort")).toMatchObject({ type: "integer", minimum: 1, maximum: 65_535, default: 8765 })
  })

  it("shows a configured host and client ID hidden, with their values as the default", () => {
    const form = signInForm(
      settings({ accounts: { work: { host: "https://dbc-1.cloud.databricks.com", clientId: "7f3e2a10-5c4b-4d8e-9a1f-2b6c8d0e4f12", warehouse: "wh" } } }),
      { callbackPort: 8765 },
    )
    expect(field(form, "host")).toMatchObject({ hidden: true, required: false, default: "https://dbc-1.cloud.databricks.com" })
    expect(field(form, "clientId")).toMatchObject({ hidden: true, required: false, default: "7f3e2a10-5c4b-4d8e-9a1f-2b6c8d0e4f12" })
  })

  it("lists the exact scopes each choice requests, features included", () => {
    const form = signInForm(settings({ accounts: { work: { warehouse: "wh", features: ["jobs", "workspace"] } } }), { callbackPort: 8765 })
    const choices = (field(form, "scopes") as StringField).options ?? []
    expect(choices[0]).toMatchObject({ value: "fine", description: "Requests: sql unity-catalog query-history openid email profile offline_access jobs workspace" })
    expect(choices[1]).toMatchObject({ value: "all-apis", description: "Requests: all-apis offline_access" })
  })

  it("carries the write disclosure verbatim in the role's help and recommends a numeric read-only role", () => {
    const role = field(signInForm(settings(), { callbackPort: 8765 }), "role") as StringField
    expect(role.description).toContain(WRITE_DISCLOSURE)
    expect(role.description).toContain("numeric ID")
    expect(role.description).toContain("recommended")
    expect(role.placeholder).toBe("1234567890123456")
  })

  it("gives the relay fields the host's values as hidden defaults (L12)", () => {
    const form = signInForm(settings(), { redirectUri: "https://id.example.com/connect/callback", callbackPort: 9999 })
    expect(field(form, "redirectUri")).toMatchObject({ hidden: true, default: "https://id.example.com/connect/callback" })
    expect(field(form, "callbackPort")).toMatchObject({ hidden: true, default: 9999 })
  })
})

describe("reading the answer", () => {
  const account = settings()
  const defaults = { callbackPort: 8765 }
  const answer = { host: "https://dbc-1.cloud.databricks.com", clientId: "7f3e2a10-5c4b-4d8e-9a1f-2b6c8d0e4f12", scopes: "fine" }

  it("reads the host, client, scope choice and redirect", () => {
    expect(readSignInAnswer(answer, account, defaults, false)).toEqual({
      host: { host: "https://dbc-1.cloud.databricks.com", cloud: "aws" },
      clientId: "7f3e2a10-5c4b-4d8e-9a1f-2b6c8d0e4f12",
      scopes: "fine",
      redirect: { uri: "http://localhost:8765/callback", port: 8765, paths: ["/callback"] },
    })
  })

  it("falls back to the account's scope choice and the redirect's defaults", () => {
    const parsed = readSignInAnswer({ ...answer, scopes: "" }, settings({ accounts: { work: { scopes: "all-apis", warehouse: "wh" } } }), { redirectUri: "https://id.example.com/connect/callback", callbackPort: 8765 }, false)
    expect(parsed.scopes).toBe("all-apis")
    expect(parsed.redirect.uri).toBe("https://id.example.com/connect/callback")
  })

  it("takes a role only as a numeric group ID", () => {
    expect(readSignInAnswer({ ...answer, role: "1234567890123456" }, account, defaults, false).roleGroupId).toBe("1234567890123456")
    expect(readSignInAnswer({ ...answer, role: "" }, account, defaults, false).roleGroupId).toBeUndefined()
    expect(codeOf(() => readSignInAnswer({ ...answer, role: "admins" }, account, defaults, false))).toBe("AUTH_CLIENT_INVALID")
  })

  it("refuses a sign-in whose role differs from the configured one, before the browser opens", () => {
    const configured = settings({ accounts: { work: { warehouse: "wh", role: "1234567890123456" } } })
    expect(readSignInAnswer({ ...answer, role: "" }, configured, defaults, false).roleGroupId).toBe("1234567890123456")
    expect(codeOf(() => readSignInAnswer({ ...answer, role: "999" }, configured, defaults, false))).toBe("AUTH_REQUIRED")
    expect(readSignInAnswer({ ...answer, role: "1234567890123456" }, configured, defaults, false).roleGroupId).toBe("1234567890123456")
  })

  it("refuses a missing or bad host, a bad client ID and an unknown scope choice", () => {
    expect(codeOf(() => readSignInAnswer({ ...answer, host: "" }, account, defaults, false))).toBe("HOST_INVALID")
    expect(codeOf(() => readSignInAnswer({ ...answer, host: "http://dbc-1.cloud.databricks.com" }, account, defaults, false))).toBe("HOST_INVALID")
    expect(codeOf(() => readSignInAnswer({ ...answer, clientId: "" }, account, defaults, false))).toBe("AUTH_CLIENT_INVALID")
    expect(codeOf(() => readSignInAnswer({ ...answer, clientId: "not a client" }, account, defaults, false))).toBe("AUTH_CLIENT_INVALID")
    expect(codeOf(() => readSignInAnswer({ ...answer, scopes: "everything" }, account, defaults, false))).toBe("AUTH_CLIENT_INVALID")
  })

  it("refuses a callback port that is not a port, or a relay this plugin cannot listen on", () => {
    expect(codeOf(() => readSignInAnswer({ ...answer, callbackPort: "0" }, account, defaults, false))).toBe("AUTH_CLIENT_INVALID")
    expect(codeOf(() => readSignInAnswer({ ...answer, callbackPort: "eighty" }, account, defaults, false))).toBe("AUTH_CLIENT_INVALID")
    expect(codeOf(() => readSignInAnswer({ ...answer, redirectUri: "http://id.example.com/connect/callback" }, account, defaults, false))).toBe("AUTH_CLIENT_INVALID")
  })

  it("lets a configured host win, and refuses an answer that names another one", () => {
    const configured = settings({ accounts: { work: { host: "https://dbc-1.cloud.databricks.com", clientId: "7f3e2a10-5c4b-4d8e-9a1f-2b6c8d0e4f12", warehouse: "wh" } } })
    expect(readSignInAnswer({ scopes: "fine" }, configured, defaults, false).host.host).toBe("https://dbc-1.cloud.databricks.com")
    expect(codeOf(() => readSignInAnswer({ ...answer, host: "https://dbc-2.cloud.databricks.com" }, configured, defaults, false))).toBe("HOST_INVALID")
  })

  it("refuses a non-text answer without repeating it", () => {
    expect(codeOf(() => readSignInAnswer({ ...answer, host: { at: "https://dbc-1.cloud.databricks.com" } }, account, defaults, false))).toBe("AUTH_CLIENT_INVALID")
  })
})
