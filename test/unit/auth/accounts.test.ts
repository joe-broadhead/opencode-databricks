// The mode-specific options checked at setup, and the account the ports see (design §3.1, §3.2).
import { describe, expect, it } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import { accountInfo, accountSettings, DEFAULT_ALIAS, enforcementOf, validateAccounts } from "../../../src/auth/accounts.js"
import { DUMMY_TOKEN, FAKE_HOST } from "./support.js"
import { loadOptions } from "../../../src/options.js"

const codeOf = (raw: Record<string, unknown>): string => {
  try {
    validateAccounts(loadOptions(raw))
    return "OK"
  } catch (error) {
    return error instanceof DatabricksError ? error.code : "OTHER"
  }
}

describe("the configured accounts", () => {
  it("defaults to one interactive account named default", () => {
    expect(accountSettings(loadOptions({}))).toEqual([{ alias: DEFAULT_ALIAS, mode: "interactive", features: [], scopes: "fine" }])
  })

  it("keeps every headless setting by name, never by value", () => {
    const [account] = accountSettings(
      loadOptions({ accounts: { ci: { mode: "m2m", host: FAKE_HOST, clientId: "7f3e2a10-5c4b-4d8e-9a1f-2b6c8d0e4f12", clientSecretEnv: "DBX_CLIENT_SECRET", role: "123" } } }),
    )
    expect(account).toMatchObject({ alias: "ci", mode: "m2m", clientSecretEnv: "DBX_CLIENT_SECRET", role: "123" })
    expect(account).not.toHaveProperty("clientSecret")
  })
})

describe("mode-specific validation at setup", () => {
  it("accepts every complete mode and the interactive defaults", () => {
    expect(codeOf({})).toBe("OK")
    expect(codeOf({ accounts: { a: { mode: "pat", host: FAKE_HOST, tokenEnv: "DBX_TOKEN" } } })).toBe("OK")
    expect(codeOf({ accounts: { a: { mode: "m2m", host: FAKE_HOST, clientId: "7f3e2a10-5c4b-4d8e-9a1f-2b6c8d0e4f12", clientSecretEnv: "DBX_CLIENT_SECRET", role: "123" } } })).toBe("OK")
    expect(codeOf({ accounts: { a: { mode: "cli", host: FAKE_HOST, profile: "DEFAULT" } } })).toBe("OK")
  })

  it("refuses a headless mode without the setting it needs", () => {
    expect(codeOf({ accounts: { a: { mode: "pat", host: FAKE_HOST } } })).toBe("OPTIONS_INVALID")
    expect(codeOf({ accounts: { a: { mode: "pat", tokenEnv: "DBX_TOKEN" } } })).toBe("OPTIONS_INVALID")
    expect(codeOf({ accounts: { a: { mode: "m2m", host: FAKE_HOST, clientSecretEnv: "DBX_CLIENT_SECRET" } } })).toBe("OPTIONS_INVALID")
    expect(codeOf({ accounts: { a: { mode: "m2m", host: FAKE_HOST, clientId: "7f3e2a10-5c4b-4d8e-9a1f-2b6c8d0e4f12" } } })).toBe("OPTIONS_INVALID")
    expect(codeOf({ accounts: { a: { mode: "cli", host: FAKE_HOST } } })).toBe("OPTIONS_INVALID")
  })

  it("refuses a role a personal access token cannot assume, and a role that is not a group ID", () => {
    expect(codeOf({ accounts: { a: { mode: "pat", host: FAKE_HOST, tokenEnv: "DBX_TOKEN", role: "123" } } })).toBe("OPTIONS_INVALID")
    expect(codeOf({ accounts: { a: { warehouse: "wh", role: "admins" } } })).toBe("OPTIONS_INVALID")
    expect(codeOf({ accounts: { a: { mode: "m2m", host: FAKE_HOST, clientId: "7f3e2a10-5c4b-4d8e-9a1f-2b6c8d0e4f12", clientSecretEnv: "DBX_CLIENT_SECRET", role: "admins" } } })).toBe("OPTIONS_INVALID")
  })

  it("validates a configured host now, so a typo fails at startup", () => {
    expect(codeOf({ accounts: { a: { host: "http://dbc-1.cloud.databricks.com" } } })).toBe("HOST_INVALID")
    expect(codeOf({ accounts: { a: { host: "https://databricks.example.com" } } })).toBe("HOST_INVALID")
    expect(codeOf({ allowCustomHost: true, accounts: { a: { host: "https://databricks.example.com" } } })).toBe("OK")
  })

  it("has no option that holds a secret: a token or client secret in the config is refused", () => {
    expect(() => loadOptions({ accounts: { ci: { mode: "pat", host: FAKE_HOST, tokenEnv: "DBX_TOKEN", token: DUMMY_TOKEN } } })).toThrowError(/OPTIONS_INVALID/u)
    expect(() => loadOptions({ accounts: { ci: { mode: "m2m", host: FAKE_HOST, clientId: "7f3e2a10-5c4b-4d8e-9a1f-2b6c8d0e4f12", clientSecretEnv: "DBX_CLIENT_SECRET", clientSecret: "dose-not-a-real-secret" } } })).toThrowError(/OPTIONS_INVALID/u)
  })
})

describe("the account the ports see", () => {
  it("is undefined until a workspace is known, then carries host, cloud, features and the bound role", () => {
    const [account] = accountSettings(loadOptions({ accounts: { work: { features: ["jobs"], warehouse: "wh", role: "123" } } }))
    expect(accountInfo(account!, undefined, false)).toBeUndefined()
    expect(accountInfo(account!, FAKE_HOST, false, "123")).toEqual({ alias: "work", mode: "interactive", host: FAKE_HOST, cloud: "aws", features: ["jobs"], role: { groupId: "123" }, warehouse: "wh" })
  })

  it("shows a role bound at sign-in when the config names none, and none when the two disagree", () => {
    const [unconfigured] = accountSettings(loadOptions({ accounts: { work: { warehouse: "wh" } } }))
    expect(accountInfo(unconfigured!, FAKE_HOST, false, "123")?.role).toEqual({ groupId: "123" })
    const [account] = accountSettings(loadOptions({ accounts: { work: { warehouse: "wh", role: "456" } } }))
    expect(accountInfo(account!, FAKE_HOST, false, "123")?.role).toBeUndefined()
  })

  it("names the base enforcement each mode carries before doctor proves a role", () => {
    const [interactive] = accountSettings(loadOptions({ accounts: { work: { warehouse: "wh" } } }))
    const [role] = accountSettings(loadOptions({ accounts: { work: { warehouse: "wh", role: "123" } } }))
    const [m2m] = accountSettings(loadOptions({ accounts: { ci: { mode: "m2m", host: FAKE_HOST, clientId: "7f3e2a10-5c4b-4d8e-9a1f-2b6c8d0e4f12", clientSecretEnv: "DBX_CLIENT_SECRET" } } }))
    expect(enforcementOf(accountInfo(interactive!, FAKE_HOST, false)!)).toBe("identity")
    expect(enforcementOf(accountInfo(role!, FAKE_HOST, false, "123")!)).toBe("role-requested")
    expect(enforcementOf(accountInfo(m2m!, FAKE_HOST, false)!)).toBe("service-principal")
  })
})
