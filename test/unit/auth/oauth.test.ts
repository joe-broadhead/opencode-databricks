// The browser sign-in (design §3.2, §15.1; L1, L2, L12): PKCE S256, the exact authorize URL with assume_group, the one
// code exchange, the granted scopes, and every refusal. The token endpoint is a loopback fake; no request leaves the
// machine.
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import { readSignIn } from "../../../src/auth/credential.js"
import { challengeOf } from "../../../src/auth/pkce.js"
import { authorizeDatabricks, type Authorization } from "../../../src/auth/oauth.js"
import { signInRedirect } from "../../../src/auth/redirect.js"
import { DUMMY_TOKEN, FAKE_HOST, freePort, tokenEndpoint, type FakeTokenEndpoint } from "./support.js"

const CLIENT_ID = "7f3e2a10-5c4b-4d8e-9a1f-2b6c8d0e4f12"
const REFRESH = "doau000000000000000000000000000000000000000000"
const endpoints: FakeTokenEndpoint[] = []

afterEach(async () => {
  for (const endpoint of endpoints.splice(0)) await endpoint.close()
})

async function start(options: { answer?: () => { status: number; body: unknown }; roleGroupId?: string; redirectUri?: string; timeoutMs?: number } = {}): Promise<{ flow: Authorization; endpoint: FakeTokenEndpoint; port: number; redirect: ReturnType<typeof signInRedirect> }> {
  const endpoint = await tokenEndpoint(options.answer ?? (() => ({ status: 200, body: { access_token: DUMMY_TOKEN, refresh_token: REFRESH, scope: "sql unity-catalog offline_access", token_type: "Bearer", expires_in: 3600 } })))
  endpoints.push(endpoint)
  const port = await freePort()
  const redirect = signInRedirect({ ...(options.redirectUri !== undefined ? { redirectUri: options.redirectUri } : {}), callbackPort: port })
  const flow = await authorizeDatabricks({
    alias: "work",
    host: FAKE_HOST,
    clientId: CLIENT_ID,
    scopes: ["sql", "unity-catalog", "offline_access"],
    choice: "fine",
    redirect,
    fetch: globalThis.fetch,
    now: () => 1_800_000_000_000,
    timeoutMs: options.timeoutMs ?? 2000,
    tokenEndpoint: endpoint.url,
    ...(options.roleGroupId !== undefined ? { roleGroupId: options.roleGroupId } : {}),
  })
  return { flow, endpoint, port, redirect }
}

const callbackUrl = (port: number, query: string, path = "/callback") => `http://127.0.0.1:${port}${path}?${query}`

describe("the authorize request", () => {
  it("requests the code with PKCE S256, the exact redirect and assume_group for a role", async () => {
    const { flow, port } = await start({ roleGroupId: "1234567890123456" })
    const url = new URL(flow.url)
    expect(url.origin).toBe(FAKE_HOST)
    expect(url.pathname).toBe("/oidc/v1/authorize")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID)
    expect(url.searchParams.get("redirect_uri")).toBe(`http://localhost:${port}/callback`)
    expect(url.searchParams.get("scope")).toBe("sql unity-catalog offline_access")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(url.searchParams.get("assume_group")).toBe("1234567890123456")
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(flow.mode).toBe("auto")
    expect(flow.expiresAt).toBe(1_800_000_000_000 + 2000)
    expect(flow.instructions).toContain(FAKE_HOST)
    expect(flow.instructions).toContain("sql, unity-catalog, offline_access")
    expect(flow.instructions).not.toContain(DUMMY_TOKEN)
    const response = await fetch(callbackUrl(port, `code=the-code&state=${encodeURIComponent(url.searchParams.get("state")!)}`))
    expect(response.status).toBe(200)
    await flow.callback
  })

  it("sends no assume_group when no role is chosen", async () => {
    const { flow, port } = await start()
    expect(new URL(flow.url).searchParams.has("assume_group")).toBe(false)
    await fetch(callbackUrl(port, `code=the-code&state=${encodeURIComponent(new URL(flow.url).searchParams.get("state")!)}`))
    await flow.callback
  })

  it("requests all-apis offline_access for an app made in the account console with All APIs (L1)", async () => {
    const endpoint = await tokenEndpoint(() => ({ status: 200, body: { access_token: DUMMY_TOKEN, refresh_token: REFRESH, scope: "all-apis offline_access", token_type: "Bearer", expires_in: 3600 } }))
    endpoints.push(endpoint)
    const port = await freePort()
    const flow = await authorizeDatabricks({
      alias: "work",
      host: FAKE_HOST,
      clientId: CLIENT_ID,
      scopes: ["all-apis", "offline_access"],
      choice: "all-apis",
      redirect: signInRedirect({ callbackPort: port }),
      fetch: globalThis.fetch,
      now: () => 1_800_000_000_000,
      timeoutMs: 2000,
      tokenEndpoint: endpoint.url,
    })
    expect(new URL(flow.url).searchParams.get("scope")).toBe("all-apis offline_access")
    const state = new URL(flow.url).searchParams.get("state")!
    await fetch(callbackUrl(port, `code=the-code&state=${encodeURIComponent(state)}`))
    const credential = await flow.callback
    expect(readSignIn(credential.metadata)?.scopes).toBe("all-apis")
    expect(readSignIn(credential.metadata)?.grantedScopes).toEqual(["all-apis", "offline_access"])
  })
})

describe("the code exchange", () => {
  it("sends every documented field once, with the verifier that matches the challenge, and stores the grant", async () => {
    const { flow, endpoint, port } = await start()
    const state = new URL(flow.url).searchParams.get("state")!
    const response = await fetch(callbackUrl(port, `code=the-code&state=${encodeURIComponent(state)}`))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("Databricks connected")
    const credential = await flow.callback
    expect(credential).toMatchObject({ type: "oauth", methodID: "databricks", access: DUMMY_TOKEN, refresh: REFRESH, expires: 1_800_000_000_000 + 3_600_000 })
    expect(endpoint.requests).toHaveLength(1)
    const form = endpoint.requests[0]!.form
    expect(form.get("grant_type")).toBe("authorization_code")
    expect(form.get("code")).toBe("the-code")
    expect(form.get("client_id")).toBe(CLIENT_ID)
    expect(form.get("redirect_uri")).toBe(`http://localhost:${port}/callback`)
    expect(form.get("scope")).toBe("sql unity-catalog offline_access")
    expect(form.get("client_secret")).toBeNull()
    const verifier = form.get("code_verifier")!
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/u)
    expect(challengeOf(verifier)).toBe(new URL(flow.url).searchParams.get("code_challenge"))
    const stored = readSignIn(credential.metadata)
    expect(stored).toMatchObject({
      version: 1,
      host: FAKE_HOST,
      clientId: CLIENT_ID,
      scopes: "fine",
      requestedScopes: ["sql", "unity-catalog", "offline_access"],
      grantedScopes: ["sql", "unity-catalog", "offline_access"],
    })
    expect(stored?.roleGroupId).toBeUndefined()
  })

  it("keeps the role binding in the credential's metadata (L3)", async () => {
    const { flow, port } = await start({ roleGroupId: "1234567890123456" })
    const state = new URL(flow.url).searchParams.get("state")!
    await fetch(callbackUrl(port, `code=the-code&state=${encodeURIComponent(state)}`))
    const credential = await flow.callback
    expect(readSignIn(credential.metadata)?.roleGroupId).toBe("1234567890123456")
  })

  it("uses a host relay's redirect exactly and accepts its own callback path (L12)", async () => {
    const { flow, endpoint, port } = await start({ redirectUri: "https://id.example.com/connect/callback" })
    const url = new URL(flow.url)
    expect(url.searchParams.get("redirect_uri")).toBe("https://id.example.com/connect/callback")
    const state = url.searchParams.get("state")!
    // The loopback callback path is refused when the relay registered another one.
    const wrong = await fetch(callbackUrl(port, `code=the-code&state=${encodeURIComponent(state)}`))
    expect(wrong.status).toBe(404)
    const response = await fetch(callbackUrl(port, `code=the-code&state=${encodeURIComponent(state)}`, "/connect/callback"))
    expect(response.status).toBe(200)
    await flow.callback
    expect(endpoint.requests[0]!.form.get("redirect_uri")).toBe("https://id.example.com/connect/callback")
    expect(flow.instructions).toContain("https://id.example.com/connect/callback")
  })

  it("refuses a state that is not the one it issued, without exchanging the code", async () => {
    const { flow, endpoint, port } = await start()
    const failure = flow.callback.catch((error: unknown) => error)
    const response = await fetch(callbackUrl(port, `code=the-code&state=not-the-state`))
    expect(response.status).toBe(400)
    const error = await failure
    expect(error).toBeInstanceOf(DatabricksError)
    expect((error as DatabricksError).code).toBe("AUTH_REQUIRED")
    expect(endpoint.requests).toHaveLength(0)
  })

  it("maps invalid_client and invalid_scope to AUTH_CLIENT_INVALID with a next step and no provider text", async () => {
    for (const code of ["invalid_client", "invalid_scope"]) {
      const { flow, port } = await start({ answer: () => ({ status: 400, body: { error: code, error_description: "a provider sentence that must not be repeated" } }) })
      const failure = flow.callback.catch((error: unknown) => error)
      const state = new URL(flow.url).searchParams.get("state")!
      await fetch(callbackUrl(port, `code=the-code&state=${encodeURIComponent(state)}`))
      const error = (await failure) as DatabricksError
      expect(error.code).toBe("AUTH_CLIENT_INVALID")
      expect(error.message).toContain(code)
      expect(error.message).toContain("Next step:")
      expect(error.message).not.toContain("a provider sentence")
      expect(error.message).not.toContain(DUMMY_TOKEN)
    }
  })

  it("refuses a sign-in Databricks will not let refresh (no offline_access)", async () => {
    const { flow, port } = await start({ answer: () => ({ status: 200, body: { access_token: "dapi000000000000000000000000000000", token_type: "Bearer", expires_in: 3600 } }) })
    const failure = flow.callback.catch((error: unknown) => error)
    const state = new URL(flow.url).searchParams.get("state")!
    await fetch(callbackUrl(port, `code=the-code&state=${encodeURIComponent(state)}`))
    const error = (await failure) as DatabricksError
    expect(error.code).toBe("AUTH_REQUIRED")
    expect(error.message).toContain("offline_access")
  })

  it("refuses an OAuth error at the callback and names only its fixed code", async () => {
    const { flow, port } = await start()
    const failure = flow.callback.catch((error: unknown) => error)
    const state = new URL(flow.url).searchParams.get("state")!
    await fetch(callbackUrl(port, `error=access_denied&state=${encodeURIComponent(state)}`))
    const error = (await failure) as DatabricksError
    expect(error.code).toBe("AUTH_REQUIRED")
    expect(error.message).toContain("access_denied")
  })

  it("times out and closes its listener", async () => {
    const { flow } = await start({ timeoutMs: 50 })
    const error = (await flow.callback.catch((caught: unknown) => caught)) as DatabricksError
    expect(error.code).toBe("AUTH_REQUIRED")
    expect(error.message).toContain("timed out")
  })

  it("refuses a callback port another program holds, before the browser opens", async () => {
    const holder = createServer()
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve))
    const port = (holder.address() as AddressInfo).port
    try {
      const error = (await authorizeDatabricks({
        alias: "work",
        host: FAKE_HOST,
        clientId: CLIENT_ID,
        scopes: ["sql"],
        choice: "fine",
        redirect: { uri: `http://localhost:${port}/callback`, port, paths: ["/callback"] },
        fetch: globalThis.fetch,
        now: Date.now,
      }).catch((caught: unknown) => caught)) as DatabricksError
      expect(error.code).toBe("AUTH_CLIENT_INVALID")
      expect(error.message).toContain(`${port}`)
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()))
    }
  })
})
