import { describe, expect, it } from "vitest"
import { integrationIdFor } from "../../src/auth/form.js"
import { requestToken } from "../../src/auth/token.js"
import { ERRORS } from "../../src/domain/errors.js"

const refusal = async (alias: string): Promise<string> => {
  const fetch = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch
  try {
    await requestToken({ alias, endpoint: "https://example.cloud.databricks.com/oidc/v1/token", form: {}, fetch, signal: new AbortController().signal })
  } catch (error) {
    return String(error)
  }
  throw new Error("expected a refusal")
}

describe("the integration name of an alias", () => {
  it("uses bare databricks for default and databricks-<alias> otherwise", () => {
    expect(integrationIdFor("default")).toBe("databricks")
    expect(integrationIdFor("work")).toBe("databricks-work")
    expect(integrationIdFor("personal")).toBe("databricks-personal")
  })

  it("names the default and named sign-in commands in auth errors", async () => {
    expect(ERRORS.AUTH_REQUIRED.next).toContain("opencode auth login databricks")
    expect(ERRORS.AUTH_REQUIRED.next).toContain("databricks-<alias>")
    expect(await refusal("default")).toContain("opencode auth login databricks.")
    expect(await refusal("work")).toContain("opencode auth login databricks-work.")
  })
})
