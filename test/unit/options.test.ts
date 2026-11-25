import { describe, expect, it } from "vitest"
import { bytesOf, loadOptions } from "../../src/options.js"

describe("options (design §13)", () => {
  it("defaults to the design's values", () => {
    const options = loadOptions(undefined)
    expect(options).toMatchObject({
      access: "all",
      callbackPort: 8765,
      allowCustomHost: false,
      maxStartSize: "Small",
      maxStartAutoStopMinutes: 15,
      maxRunSeconds: 600,
      wait: 50,
      usdPerDbu: { serverless: 0.7, pro: 0.55, classic: 0.22 },
      maxRows: 50,
      maxInlineBytes: "32KiB",
      maxSaveRows: 1_000_000,
      maxSaveBytes: "256MiB",
      resultsDir: ".databricks/results",
      inlinePii: "warn",
      dependencyDepth: 4,
      runTimeoutSeconds: 3600,
      automation: "auto",
      planTtlSeconds: 300,
      admin: { enabled: true, requireReason: true },
      allowUntestedHost: false,
    })
    expect(options.budget).toBeUndefined()
    expect(loadOptions({})).toEqual(options)
  })

  it("takes an account with every documented field, and defaults its mode and scopes", () => {
    const options = loadOptions({ accounts: { work: { host: "https://x.cloud.databricks.com", warehouse: "abc", features: ["jobs"], fence: { allow: ["main.*"] } } } })
    expect(options.accounts?.work).toMatchObject({ mode: "interactive", scopes: "fine", features: ["jobs"] })
  })

  it("refuses an unknown option, inside an account too, with OPTIONS_INVALID naming it", () => {
    expect(() => loadOptions({ acess: "all" })).toThrow(/^OPTIONS_INVALID: Invalid plugin option "acess": this option does not exist\. Next step: /)
    expect(() => loadOptions({ accounts: { work: { token: "x" } } })).toThrow(/OPTIONS_INVALID: Invalid plugin option "accounts\.work\.token"/)
  })

  it("never holds a secret: headless modes take variable names only", () => {
    expect(() => loadOptions({ accounts: { ci: { mode: "pat", tokenEnv: "dapi0123456789abcdef" } } })).toThrow(/OPTIONS_INVALID/)
    expect(loadOptions({ accounts: { ci: { mode: "pat", tokenEnv: "DATABRICKS_TOKEN" } } }).accounts?.ci?.tokenEnv).toBe("DATABRICKS_TOKEN")
  })

  it("reads sizes", () => {
    expect(bytesOf("32KiB")).toBe(32 * 1024)
    expect(bytesOf("256MiB")).toBe(256 * 1024 ** 2)
    expect(bytesOf(10)).toBe(10)
  })
})
