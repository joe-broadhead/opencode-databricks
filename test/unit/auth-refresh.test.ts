import { describe, expect, it } from "vitest"
import { HOST_HELD_REFRESH, signInMetadata } from "../../src/auth/credential.js"
import { refreshSignIn, refreshState } from "../../src/auth/refresh.js"
import type { HostCredential } from "../../src/auth/types.js"

const NOW = 1_700_000_000_000
const credential = (refresh: string): HostCredential => ({
  type: "oauth",
  methodID: "databricks",
  refresh,
  access: "A",
  expires: NOW + 3_600_000,
  metadata: signInMetadata({
    host: "https://dbc-1.cloud.databricks.com",
    clientId: "client-id",
    scopes: "fine",
    requestedScopes: [],
    grantedScopes: [],
  }),
})

const noNetwork = () => {
  let fetches = 0
  const fetch = (async () => {
    fetches += 1
    throw new Error("no network")
  }) as unknown as typeof globalThis.fetch
  return { fetch, fetches: () => fetches }
}

describe("a sign-in refresh", () => {
  it("refuses a sign-in with no refresh token, before any request", async () => {
    const network = noNetwork()
    const error = (await refreshSignIn({
      alias: "work",
      name: "Databricks",
      credential: credential(""),
      fetch: network.fetch,
      now: () => NOW,
      state: refreshState(),
    }).catch((caught: unknown) => caught)) as { code: string; message: string }
    expect(error.code).toBe("AUTH_REQUIRED")
    expect(error.message).toContain("no refresh token")
    expect(network.fetches()).toBe(0)
  })

  it("refuses a host-held sign-in before any request", async () => {
    const network = noNetwork()
    const state = refreshState()
    const error = (await refreshSignIn({
      alias: "work",
      name: "Databricks",
      credential: credential(HOST_HELD_REFRESH),
      fetch: network.fetch,
      now: () => NOW,
      state,
    }).catch((caught: unknown) => caught)) as { code: string; message: string }
    expect(error.code).toBe("AUTH_REQUIRED")
    expect(error.message).toContain("held by the host")
    expect(network.fetches()).toBe(0)
    expect(state.chains.size).toBe(0)
  })
})
