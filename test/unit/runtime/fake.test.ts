// The fake workspace itself: the behaviours every later package turns on (design §15.2) and the OAuth endpoints package
// A signs in against. A fake that lies about these would fail those packages, so they are tested here, in package B.
import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import type { StatementAnswer } from "../../../src/ports.js"
import { FAKE_ACCESS_TOKEN, startFakeDatabricks } from "../../fake/databricks-server.js"

const STATEMENT = "SELECT * FROM (\nSELECT 1 AS n\n) AS oc_q"
const answer = (over: Partial<StatementAnswer> = {}): StatementAnswer => ({
  statementId: "stmt-fake",
  state: "SUCCEEDED",
  manifest: { columns: [{ name: "n", typeName: "INT", typeText: "INT", position: 0 }], totalRowCount: 2, totalChunkCount: 1 },
  rows: [["1"], ["2"]],
  ...over,
})

const post = (origin: string, path: string, body: unknown, token = FAKE_ACCESS_TOKEN) =>
  fetch(`${origin}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) })

describe("the fake: the API's own behaviour", () => {
  it("refuses a call with no bearer token, and records whether there was one", async () => {
    const fake = await startFakeDatabricks()
    try {
      const response = await fetch(`${fake.origin}/api/2.0/sql/warehouses`)
      expect(response.status).toBe(401)
      expect(((await response.json()) as { error_code: string }).error_code).toBe("UNAUTHENTICATED")
      const authorized = await fetch(`${fake.origin}/api/2.0/sql/warehouses`, { headers: { authorization: `Bearer ${FAKE_ACCESS_TOKEN}` } })
      expect(authorized.status).toBe(200)
      expect(fake.requests.map((entry) => entry.authorized)).toEqual([false, true])
      expect(fake.requests[0]).toMatchObject({ method: "GET", path: "/api/2.0/sql/warehouses", query: {} })
    } finally {
      await fake.close()
    }
  })

  it("answers 429 with Retry-After for the count it was given, and then recovers", async () => {
    const fake = await startFakeDatabricks()
    try {
      fake.behave({ rateLimit: { count: 2, retryAfterSec: 4 } })
      const headers = { authorization: `Bearer ${FAKE_ACCESS_TOKEN}` }
      for (const expected of [429, 429, 200]) {
        const response = await fetch(`${fake.origin}/api/2.0/sql/warehouses`, { headers })
        expect(response.status).toBe(expected)
        if (expected === 429) expect(response.headers.get("retry-after")).toBe("4")
      }
    } finally {
      await fake.close()
    }
  })

  it("runs a statement, truncates at row_limit, and carries a failure's error and sql_state", async () => {
    const fake = await startFakeDatabricks({
      statements: new Map([
        [STATEMENT, answer()],
        ["SELECT * FROM (\nSELECT broken\n) AS oc_q", answer({ statementId: "stmt-broken", state: "FAILED", rows: undefined, error: { errorCode: "BAD_REQUEST", sqlState: "42000", message: "boom", trust: "untrusted" } })],
      ]),
    })
    try {
      const limited = await post(fake.origin, "/api/2.0/sql/statements", { statement: STATEMENT, warehouse_id: "wh-small", row_limit: 1 })
      const limitedBody = (await limited.json()) as { manifest: { truncated: boolean; total_row_count: number }; result: { data_array: unknown[][] } }
      expect(limitedBody.manifest.truncated).toBe(true)
      expect(limitedBody.manifest.total_row_count).toBe(2)
      expect(limitedBody.result.data_array).toHaveLength(1)

      const failed = await post(fake.origin, "/api/2.0/sql/statements", { statement: "SELECT * FROM (\nSELECT broken\n) AS oc_q", warehouse_id: "wh-small" })
      const failedBody = (await failed.json()) as { status: { state: string; error: { error_code: string; message: string }; sql_state: string } }
      expect(failedBody.status).toMatchObject({ state: "FAILED", error: { error_code: "BAD_REQUEST", message: "boom" }, sql_state: "42000" })

      const unknown = await post(fake.origin, "/api/2.0/sql/statements", { statement: "SELECT * FROM (\nSELECT other\n) AS oc_q", warehouse_id: "wh-small" })
      const unknownBody = (await unknown.json()) as { status: { state: string }; manifest: { total_row_count: number } }
      expect(unknownBody.status.state).toBe("SUCCEEDED")
      expect(unknownBody.manifest.total_row_count).toBe(0)
    } finally {
      await fake.close()
    }
  })

  it("fails one chunk mid-stream, once", async () => {
    const fake = await startFakeDatabricks({
      statements: new Map([[STATEMENT, answer({ manifest: { columns: [{ name: "n", typeName: "INT", typeText: "INT", position: 0 }], totalChunkCount: 2 }, rows: [["1"], ["2"]] })]]),
    })
    try {
      fake.behave({ failChunk: 1 })
      const headers = { authorization: `Bearer ${FAKE_ACCESS_TOKEN}` }
      const first = (await (await post(fake.origin, "/api/2.0/sql/statements", { statement: STATEMENT, warehouse_id: "wh-small" })).json()) as { statement_id: string }
      const failed = await fetch(`${fake.origin}/api/2.0/sql/statements/${first.statement_id}/result/chunks/1`, { headers })
      expect(failed.status).toBe(500)
      const refetched = await fetch(`${fake.origin}/api/2.0/sql/statements/${first.statement_id}/result/chunks/1`, { headers })
      expect(refetched.status).toBe(200)
    } finally {
      await fake.close()
    }
  })

  it("answers with the bounded state a test seeded, including a warehouse it started", async () => {
    const fake = await startFakeDatabricks()
    try {
      expect(fake.state.warehouses.get("wh-stopped")?.state).toBe("STOPPED")
      fake.behave({ autoStartOnSubmit: true })
      await post(fake.origin, "/api/2.0/sql/statements", { statement: STATEMENT, warehouse_id: "wh-stopped" })
      expect(fake.state.warehouses.get("wh-stopped")?.state).toBe("RUNNING")
      // The statement appears in Query History with its tags, which is what a recovery reads.
      expect(fake.state.history).toHaveLength(1)
      expect(fake.state.history[0]?.queryText).toBe(STATEMENT)
    } finally {
      await fake.close()
    }
  })

  it("stops answering once closed", async () => {
    const fake = await startFakeDatabricks()
    await fake.close()
    await expect(fetch(`${fake.origin}/api/2.0/sql/warehouses`)).rejects.toThrow()
  })
})

describe("the fake: OAuth (package A's target)", () => {
  const verifier = "a-very-long-pkce-verifier-for-the-fake-0123456789"
  const challenge = createHash("sha256").update(verifier).digest("base64url")

  it("redirects with a code and the caller's state, and exchanges it once", async () => {
    const fake = await startFakeDatabricks()
    try {
      const redirect = "http://127.0.0.1:8765/callback"
      const authorize = new URL(`${fake.origin}/oidc/v1/authorize`)
      authorize.searchParams.set("client_id", "oc-client")
      authorize.searchParams.set("redirect_uri", redirect)
      authorize.searchParams.set("response_type", "code")
      authorize.searchParams.set("code_challenge", challenge)
      authorize.searchParams.set("code_challenge_method", "S256")
      authorize.searchParams.set("scope", "sql unity-catalog offline_access")
      authorize.searchParams.set("state", "state-123")
      const response = await fetch(authorize, { redirect: "manual" })
      expect(response.status).toBe(302)
      const location = new URL(response.headers.get("location") ?? "")
      expect(location.origin + location.pathname).toBe(redirect)
      expect(location.searchParams.get("state")).toBe("state-123")
      const code = location.searchParams.get("code") ?? ""

      const exchange = () =>
        fetch(fake.tokenEndpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: "oc-client", redirect_uri: redirect, code_verifier: verifier }),
        })
      const token = (await (await exchange()).json()) as { access_token: string; refresh_token: string; expires_in: number }
      expect(token.access_token).toBe(FAKE_ACCESS_TOKEN)
      expect(token.expires_in).toBe(3600)
      expect(token.refresh_token).toMatch(/^dose/u)
      // A code is single use.
      expect(((await (await exchange()).json()) as { error: string }).error).toBe("invalid_grant")
    } finally {
      await fake.close()
    }
  })

  it("refuses a verifier that does not hash to the challenge", async () => {
    const fake = await startFakeDatabricks()
    try {
      const authorize = new URL(`${fake.origin}/oidc/v1/authorize`)
      authorize.searchParams.set("client_id", "oc-client")
      authorize.searchParams.set("redirect_uri", "http://127.0.0.1:8765/callback")
      authorize.searchParams.set("code_challenge", challenge)
      authorize.searchParams.set("code_challenge_method", "S256")
      const response = await fetch(authorize, { redirect: "manual" })
      const code = new URL(response.headers.get("location") ?? "").searchParams.get("code") ?? ""
      const token = await fetch(fake.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: "oc-client", redirect_uri: "http://127.0.0.1:8765/callback", code_verifier: "wrong" }),
      })
      expect(token.status).toBe(400)
      expect(((await token.json()) as { error: string }).error).toBe("invalid_grant")
    } finally {
      await fake.close()
    }
  })

  it("rotates the refresh token, and refuses the old one", async () => {
    const fake = await startFakeDatabricks()
    try {
      const authorize = new URL(`${fake.origin}/oidc/v1/authorize`)
      authorize.searchParams.set("client_id", "oc-client")
      authorize.searchParams.set("redirect_uri", "http://127.0.0.1:8765/callback")
      authorize.searchParams.set("code_challenge", challenge)
      authorize.searchParams.set("code_challenge_method", "S256")
      const code = new URL((await fetch(authorize, { redirect: "manual" })).headers.get("location") ?? "").searchParams.get("code") ?? ""
      const refreshOf = async (body: URLSearchParams) => (await fetch(fake.tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body })).json() as Promise<{ refresh_token?: string; error?: string }>
      const first = await refreshOf(new URLSearchParams({ grant_type: "authorization_code", code, client_id: "oc-client", redirect_uri: "http://127.0.0.1:8765/callback", code_verifier: verifier }))
      const second = await refreshOf(new URLSearchParams({ grant_type: "refresh_token", refresh_token: first.refresh_token ?? "" }))
      expect(second.refresh_token).toMatch(/^dose/u)
      expect(second.refresh_token).not.toBe(first.refresh_token)
      const reused = await refreshOf(new URLSearchParams({ grant_type: "refresh_token", refresh_token: first.refresh_token ?? "" }))
      expect(reused.error).toBe("invalid_grant")
      const unsupported = await refreshOf(new URLSearchParams({ grant_type: "password" }))
      expect(unsupported.error).toBe("unsupported_grant_type")
    } finally {
      await fake.close()
    }
  })

  it("refuses invalid_scope and a missing PKCE challenge", async () => {
    const fake = await startFakeDatabricks()
    try {
      const scope = new URL(`${fake.origin}/oidc/v1/authorize`)
      scope.searchParams.set("client_id", "oc-client")
      scope.searchParams.set("redirect_uri", "http://127.0.0.1:8765/callback")
      scope.searchParams.set("code_challenge", challenge)
      scope.searchParams.set("code_challenge_method", "S256")
      scope.searchParams.set("scope", "unsupported-scope")
      expect(((await (await fetch(scope)).json()) as { error: string }).error).toBe("invalid_scope")
      const plain = new URL(`${fake.origin}/oidc/v1/authorize`)
      plain.searchParams.set("client_id", "oc-client")
      plain.searchParams.set("redirect_uri", "http://127.0.0.1:8765/callback")
      expect((await fetch(plain)).status).toBe(400)
      const noClient = new URL(`${fake.origin}/oidc/v1/authorize`)
      noClient.searchParams.set("redirect_uri", "http://127.0.0.1:8765/callback")
      noClient.searchParams.set("code_challenge", challenge)
      noClient.searchParams.set("code_challenge_method", "S256")
      expect(((await (await fetch(noClient)).json()) as { error: string }).error).toBe("invalid_client")
    } finally {
      await fake.close()
    }
  })
})
