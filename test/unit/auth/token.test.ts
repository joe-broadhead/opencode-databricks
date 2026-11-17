// The token call every Databricks request passes (design §3.1, §3.3, §15.1): the scope check before any call, the role
// and workspace bindings, the sign-in summary, and every refusal's next step.
import { describe, expect, it } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import { readSignIn } from "../../../src/auth/credential.js"
import { DUMMY_TOKEN, FAKE_HOST, authCore, hostCredential, memoryStorage } from "./support.js"

const NOW = 1_800_000_000_000
const signal = () => new AbortController().signal
const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run()
    return "OK"
  } catch (error) {
    return error instanceof DatabricksError ? error.code : "OTHER"
  }
}

describe("an interactive token", () => {
  it("returns the stored access token with the granted scopes and when it expires", async () => {
    const credential = hostCredential({ access: DUMMY_TOKEN, expires: NOW + 3_600_000 })
    const { core } = authCore({ accounts: { work: { warehouse: "wh" } } }, { credential, now: () => NOW })
    const token = await core.token("work", ["sql", "unity-catalog"], signal())
    expect(token).toEqual({ accessToken: DUMMY_TOKEN, expiresAt: NOW + 3_600_000, scopes: readSignIn(credential.metadata)!.grantedScopes })
  })

  it("refuses with AUTH_REQUIRED when no sign-in is stored, before any network call", async () => {
    const { core, reads } = authCore({ accounts: { work: { warehouse: "wh" } } }, { credential: undefined, now: () => NOW })
    const error = (await core.token("work", ["sql"], signal()).catch((caught: unknown) => caught)) as DatabricksError
    expect(error.code).toBe("AUTH_REQUIRED")
    expect(error.message).toContain("/connect")
    expect(reads.count).toBe(1)
  })

  it("refuses a credential the host could not renew as AUTH_REQUIRED", async () => {
    const { core } = authCore({ accounts: { work: { warehouse: "wh" } } }, { read: async () => Promise.reject(new Error("refresh failed")), now: () => NOW })
    expect(await codeOf(() => core.token("work", ["sql"], signal()))).toBe("AUTH_REQUIRED")
  })

  it("stops on an aborted call before reading the credential", async () => {
    const { core, reads } = authCore({ accounts: { work: { warehouse: "wh" } } }, { credential: hostCredential(), now: () => NOW })
    const controller = new AbortController()
    controller.abort()
    expect(await codeOf(() => core.token("work", ["sql"], controller.signal))).toBe("CANCELLED")
    expect(reads.count).toBe(0)
  })
})

describe("the scope check before a call (design §3.3, L2)", () => {
  it("refuses a token without jobs with AUTH_SCOPE_MISSING before any call, naming the feature to enable (L2)", async () => {
    const { core } = authCore(
      { accounts: { work: { warehouse: "wh" } } },
      { credential: hostCredential({ grantedScopes: ["sql", "query-history", "openid", "offline_access"] }), now: () => NOW },
    )
    const error = (await core.token("work", ["sql", "jobs"], signal()).catch((caught: unknown) => caught)) as DatabricksError
    expect(error.code).toBe("AUTH_SCOPE_MISSING")
    expect(error.message).toContain("jobs")
    expect(error.message).toContain("Databricks was not called")
    expect(error.nextStep).toContain('"jobs"')
    expect(error.nextStep).toContain("features")
  })

  it("names the admin's app connection when the feature is enabled but not granted", async () => {
    const { core } = authCore(
      { accounts: { work: { warehouse: "wh", features: ["jobs"] } } },
      { credential: hostCredential({ requestedScopes: ["sql", "jobs"], grantedScopes: ["sql"] }), now: () => NOW },
    )
    const error = (await core.token("work", ["jobs"], signal()).catch((caught: unknown) => caught)) as DatabricksError
    expect(error.code).toBe("AUTH_SCOPE_MISSING")
    expect(error.nextStep).toContain("app connection")
    expect(error.nextStep).toContain("30 minutes")
  })

  it("lets an all-apis sign-in carry every family", async () => {
    const { core } = authCore({ accounts: { work: { warehouse: "wh", features: ["jobs", "files"] } } }, { credential: hostCredential({ choice: "all-apis", grantedScopes: ["all-apis", "offline_access"] }), now: () => NOW })
    await expect(core.token("work", ["sql", "jobs", "files"], signal())).resolves.toMatchObject({ accessToken: DUMMY_TOKEN })
  })
})

describe("the workspace and role bindings (design §3.1)", () => {
  it("accepts a role that matches the one bound at sign-in and reports it on the account", async () => {
    const { core } = authCore({ accounts: { work: { warehouse: "wh", role: "1234567890123456" } } }, { credential: hostCredential({ roleGroupId: "1234567890123456" }), now: () => NOW })
    await core.token("work", ["sql"], signal())
    expect(core.account("work").role).toEqual({ groupId: "1234567890123456" })
  })

  it("refuses a configured role that differs from the bound one, and a role added to config", async () => {
    const mismatch = authCore({ accounts: { work: { warehouse: "wh", role: "456" } } }, { credential: hostCredential({ roleGroupId: "123" }), now: () => NOW }).core
    const error = (await mismatch.token("work", ["sql"], signal()).catch((caught: unknown) => caught)) as DatabricksError
    expect(error.code).toBe("AUTH_REQUIRED")
    expect(error.message).toContain("456")
    expect(error.message).toContain("123")
    expect(error.nextStep).toContain("sign in again")

    const added = authCore({ accounts: { work: { warehouse: "wh", role: "123" } } }, { credential: hostCredential({ grantedScopes: ["sql"] }), now: () => NOW }).core
    expect(await codeOf(() => added.token("work", ["sql"], signal()))).toBe("AUTH_REQUIRED")

    // A role bound on the sign-in form with no role option stays the bound identity: removing the option cannot
    // silently change what the token is, and the token still runs as the role the person chose.
    const removed = authCore({ accounts: { work: { warehouse: "wh" } } }, { credential: hostCredential({ roleGroupId: "123" }), now: () => NOW }).core
    await expect(removed.token("work", ["sql"], signal())).resolves.toMatchObject({ accessToken: DUMMY_TOKEN })
    expect(removed.account("work").role).toEqual({ groupId: "123" })
  })

  it("refuses a sign-in for another workspace than the configured one", async () => {
    const { core } = authCore(
      { accounts: { work: { host: "https://dbc-2222.cloud.databricks.com", warehouse: "wh" } } },
      { credential: hostCredential({ host: FAKE_HOST }), now: () => NOW },
    )
    const error = (await core.token("work", ["sql"], signal()).catch((caught: unknown) => caught)) as DatabricksError
    expect(error.code).toBe("AUTH_REQUIRED")
    expect(error.message).toContain("dbc-2222")
  })
})

describe("the account list and the sign-in summary", () => {
  it("lists only an account whose workspace is known, and explains an unknown one", () => {
    const { core } = authCore({ accounts: { work: { warehouse: "wh" } } }, { credential: hostCredential(), now: () => NOW })
    expect(core.accounts()).toEqual([])
    expect(() => core.account("work")).toThrowError(/AUTH_REQUIRED/u)
    expect(() => core.account("other")).toThrowError(/AUTH_REQUIRED/u)
  })

  it("lists a configured workspace at once", () => {
    const { core } = authCore({ accounts: { work: { host: FAKE_HOST, warehouse: "wh" } } }, { now: () => NOW })
    expect(core.accounts()).toEqual([{ alias: "work", mode: "interactive", host: FAKE_HOST, cloud: "aws", features: [], warehouse: "wh" }])
  })

  it("remembers the workspace and role across a restart without storing a token", async () => {
    const storage = memoryStorage()
    const first = authCore({ accounts: { work: { warehouse: "wh", role: "123" } } }, { storage, credential: hostCredential({ roleGroupId: "123" }), now: () => NOW })
    await first.core.load()
    await first.core.token("work", ["sql"], signal())
    expect(JSON.stringify(storage.value())).not.toContain(DUMMY_TOKEN)
    expect(JSON.stringify(storage.value())).not.toContain("refresh")
    const second = authCore({ accounts: { work: { warehouse: "wh", role: "123" } } }, { storage, now: () => NOW })
    await second.core.load()
    expect(second.core.accounts()).toEqual([{ alias: "work", mode: "interactive", host: FAKE_HOST, cloud: "aws", features: [], role: { groupId: "123" }, warehouse: "wh" }])
    expect(await codeOf(() => second.core.token("work", ["sql"], signal()))).toBe("AUTH_REQUIRED")
  })

  it("reports an invalid configured host as HOST_INVALID when the account is asked for", () => {
    const { core } = authCore({ accounts: { work: { host: "http://dbc-1.cloud.databricks.com", warehouse: "wh" } } }, { now: () => NOW })
    expect(core.accounts()).toEqual([])
    expect(() => core.account("work")).toThrowError(/HOST_INVALID/u)
  })
})
