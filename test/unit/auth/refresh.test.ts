// Refresh (design §3.2; L1): the documented request, rotation, invalid_grant, and one request for two concurrent callers.
import { afterEach, describe, expect, it } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import { readSignIn } from "../../../src/auth/credential.js"
import { refreshSignIn, refreshState } from "../../../src/auth/refresh.js"
import { DUMMY_TOKEN, hostCredential, tokenEndpoint, type FakeTokenEndpoint } from "./support.js"

const endpoints: FakeTokenEndpoint[] = []
afterEach(async () => {
  for (const endpoint of endpoints.splice(0)) await endpoint.close()
})

const NOW = 1_800_000_000_000

/** A single-use refresh endpoint: R1 becomes R2, R2 becomes R3, and a token used twice is invalid_grant. */
async function rotationEndpoint(): Promise<FakeTokenEndpoint> {
  const used = new Set<string>()
  const endpoint = await tokenEndpoint((form) => {
    const token = form.get("refresh_token")
    if (token !== null && !used.has(token) && (token === "R1" || token === "R2")) {
      used.add(token)
      return token === "R1"
        ? { status: 200, body: { access_token: "A2", refresh_token: "R2", scope: "sql offline_access", token_type: "Bearer", expires_in: 3600 } }
        : { status: 200, body: { access_token: "A3", refresh_token: "R3", scope: "sql offline_access", token_type: "Bearer", expires_in: 3600 } }
    }
    return { status: 400, body: { error: "invalid_grant", error_description: "free text that must not be repeated" } }
  })
  endpoints.push(endpoint)
  return endpoint
}

describe("renewing a sign-in", () => {
  it("sends grant_type=refresh_token, the token and the client ID, with no secret, no scope and no assume_group", async () => {
    const endpoint = await rotationEndpoint()
    const state = refreshState()
    const renewed = await refreshSignIn({
      alias: "work",
      name: "Databricks",
      credential: hostCredential({ refresh: "R1", expires: NOW }),
      fetch: globalThis.fetch,
      now: () => NOW,
      state,
      tokenEndpoint: endpoint.url,
    })
    expect(endpoint.requests).toHaveLength(1)
    const form = endpoint.requests[0]!.form
    expect([...form.keys()].sort()).toEqual(["client_id", "grant_type", "refresh_token"])
    expect(form.get("grant_type")).toBe("refresh_token")
    expect(form.get("refresh_token")).toBe("R1")
    expect(form.get("client_id")).toBe("7f3e2a10-5c4b-4d8e-9a1f-2b6c8d0e4f12")
    expect(renewed.access).toBe("A2")
    expect(renewed.refresh).toBe("R2")
    expect(renewed.expires).toBe(NOW + 3_600_000)
    expect(readSignIn(renewed.metadata)?.grantedScopes).toEqual(["sql", "offline_access"])
  })

  it("returns the rotated token, and a caller that brings the stale one gets the newest without a second request", async () => {
    const endpoint = await rotationEndpoint()
    const state = refreshState()
    const first = hostCredential({ refresh: "R1", expires: NOW })
    const renewed = await refreshSignIn({ alias: "work", name: "Databricks", credential: first, fetch: globalThis.fetch, now: () => NOW, state, tokenEndpoint: endpoint.url })
    const stale = await refreshSignIn({ alias: "work", name: "Databricks", credential: first, fetch: globalThis.fetch, now: () => NOW + 1, state, tokenEndpoint: endpoint.url })
    expect(stale.access).toBe("A2")
    expect(endpoint.requests).toHaveLength(1)
    // The next renewal uses the rotated token, as a single-use endpoint requires.
    const next = await refreshSignIn({ alias: "work", name: "Databricks", credential: renewed, fetch: globalThis.fetch, now: () => NOW + 2, state, tokenEndpoint: endpoint.url })
    expect(next.refresh).toBe("R3")
    expect(endpoint.requests.map((request) => request.form.get("refresh_token"))).toEqual(["R1", "R2"])
  })

  it("sends one request for two concurrent refreshes of the same sign-in (single-use rotation)", async () => {
    const endpoint = await rotationEndpoint()
    const state = refreshState()
    const credential = hostCredential({ refresh: "R1", expires: NOW })
    const [left, right] = await Promise.all([
      refreshSignIn({ alias: "work", name: "Databricks", credential, fetch: globalThis.fetch, now: () => NOW, state, tokenEndpoint: endpoint.url }),
      refreshSignIn({ alias: "work", name: "Databricks", credential, fetch: globalThis.fetch, now: () => NOW, state, tokenEndpoint: endpoint.url }),
    ])
    expect(endpoint.requests).toHaveLength(1)
    expect(left.access).toBe("A2")
    expect(right.access).toBe("A2")
  })

  it("two processes: the rotated token the store holds renews, and the stale one is refused (L1, single-use rotation)", async () => {
    const endpoint = await rotationEndpoint()
    const original = hostCredential({ refresh: "R1", expires: NOW })
    // Process A renews and the host stores the rotated credential; process B reads it and renews again.
    const a = await refreshSignIn({ alias: "work", name: "Databricks", credential: original, fetch: globalThis.fetch, now: () => NOW, state: refreshState(), tokenEndpoint: endpoint.url })
    const b = await refreshSignIn({ alias: "work", name: "Databricks", credential: a, fetch: globalThis.fetch, now: () => NOW + 1, state: refreshState(), tokenEndpoint: endpoint.url })
    expect(b.refresh).toBe("R3")
    // A process that did not see the rotation brings the old token, which a single-use endpoint has invalidated.
    const stale = (await refreshSignIn({ alias: "work", name: "Databricks", credential: original, fetch: globalThis.fetch, now: () => NOW + 2, state: refreshState(), tokenEndpoint: endpoint.url }).catch((caught: unknown) => caught)) as DatabricksError
    expect(stale.code).toBe("AUTH_REQUIRED")
    // A refresh token that has expired answers invalid_grant: the same AUTH_REQUIRED with the sign-in-again step.
    expect(stale.nextStep).toContain("/connect")
  })

  it("M1: an older latest never replaces a newer sign-in; the newer one is refreshed and keeps its role", async () => {
    const endpoint = await tokenEndpoint(() => ({ status: 200, body: { access_token: "NEW-A", refresh_token: "NEW-R2", scope: "sql", expires_in: 3600 } }))
    endpoints.push(endpoint)
    const state = refreshState()
    // This process once held sign-in 1 (no role) and is holding its credential as `latest`.
    state.latest.set("work", { credential: hostCredential({ refresh: "OLD-R", access: "OLD-A", generation: 1 }), generation: 1 })
    // The person signed in again in another process (role 999); the host hands this process the new credential.
    const newer = hostCredential({ refresh: "NEW-R1", access: "NEW-A0", roleGroupId: "999", generation: 2 })
    const renewed = await refreshSignIn({ alias: "work", name: "Databricks", credential: newer, fetch: globalThis.fetch, now: () => NOW, state, tokenEndpoint: endpoint.url })
    expect(endpoint.requests).toHaveLength(1)
    expect(renewed.refresh).toBe("NEW-R2")
    expect(readSignIn(renewed.metadata)?.roleGroupId).toBe("999")
    expect(state.latest.get("work")?.credential.refresh).toBe("NEW-R2")
  })

  it("M1: a newer sign-in is returned to an older caller, so no older identity is ever restored", async () => {
    const endpoint = await tokenEndpoint(() => ({ status: 200, body: { access_token: "WHY", refresh_token: "WHY", expires_in: 3600 } }))
    endpoints.push(endpoint)
    const state = refreshState()
    const newer = hostCredential({ refresh: "NEW-R1", roleGroupId: "999", generation: 3 })
    state.latest.set("work", { credential: newer, generation: 3, rotatedFrom: "NEW-R0" })
    const older = hostCredential({ refresh: "OLD-R", generation: 1 })
    const renewed = await refreshSignIn({ alias: "work", name: "Databricks", credential: older, fetch: globalThis.fetch, now: () => NOW, state, tokenEndpoint: endpoint.url })
    expect(endpoint.requests).toHaveLength(0)
    expect(renewed.refresh).toBe("NEW-R1")
    expect(readSignIn(renewed.metadata)?.roleGroupId).toBe("999")
  })

  it("LOW 3: validates the stored workspace again before sending a refresh token to it", async () => {
    const endpoint = await rotationEndpoint()
    const error = (await refreshSignIn({
      alias: "work",
      name: "Databricks",
      credential: hostCredential({ host: "http://dbc-1.cloud.databricks.com", refresh: "R1", expires: NOW }),
      fetch: globalThis.fetch,
      now: () => NOW,
      state: refreshState(),
      tokenEndpoint: endpoint.url,
    }).catch((caught: unknown) => caught)) as DatabricksError
    expect(error.code).toBe("HOST_INVALID")
    expect(endpoint.requests).toHaveLength(0)
  })

  it("maps invalid_grant to AUTH_REQUIRED with the sign-in-again step, and repeats no provider text", async () => {
    const endpoint = await rotationEndpoint()
    const error = (await refreshSignIn({
      alias: "work",
      name: "Databricks",
      credential: hostCredential({ refresh: "R9", expires: NOW }),
      fetch: globalThis.fetch,
      now: () => NOW,
      state: refreshState(),
      tokenEndpoint: endpoint.url,
    }).catch((caught: unknown) => caught)) as DatabricksError
    expect(error.code).toBe("AUTH_REQUIRED")
    expect(error.message).toContain("invalid_grant")
    expect(error.message).toContain("/connect")
    expect(error.message).not.toContain("free text")
    expect(error.message).not.toContain("R9")
  })

  it("refuses a sign-in with no record or no refresh token", async () => {
    const endpoint = await rotationEndpoint()
    const withoutRecord = { ...hostCredential({ refresh: "R1", expires: NOW }), metadata: undefined }
    const error = (await refreshSignIn({ alias: "work", name: "Databricks", credential: withoutRecord, fetch: globalThis.fetch, now: () => NOW, state: refreshState(), tokenEndpoint: endpoint.url }).catch((caught: unknown) => caught)) as DatabricksError
    expect(error.code).toBe("AUTH_REQUIRED")
    expect(error.message).not.toContain(DUMMY_TOKEN)
  })
})
