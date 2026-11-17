// The real host: the `databricks-work` integration, its form, the OAuth URL (cancelled before Databricks is contacted),
// the config refusals before any network call, and `/databricks-doctor` over a stored credential. Nothing leaves the
// machine: the harness fails the host if a request is attempted.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { signInMetadata } from "../../src/auth/credential.js"
import { cleanup, startHost, until, type Host } from "./harness.js"

const WORK = "databricks-work"
const HOST = "https://fake-workspace.cloud.databricks.com"
const CLIENT_ID = "7f3e2a10-5c4b-4d8e-9a1f-2b6c8d0e4f12"
const TOKEN = "dapi00000000000000000000000000000000-not-real"

let host: Host

beforeAll(async () => {
  host = await startHost({ options: { accounts: { work: { warehouse: "wh-small" } } } })
})

afterAll(async () => {
  await host?.close()
  cleanup()
})

const at = () => ({ location: host.location })

/** A port nothing holds now; the plugin's own listener takes it when the sign-in starts. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

interface ConnectAnswer {
  readonly attemptID: string
  readonly url: string
  readonly instructions: string
}

const connect = async (answer: { readonly [key: string]: string | number | boolean | readonly string[] }) => (await host.client.integration.oauth.connect({ integrationID: WORK, methodID: "databricks", answer, ...at() })).data

async function cancel(attemptID: string): Promise<void> {
  await host.client.integration.oauth.cancel({ integrationID: WORK, attemptID, ...at() })
}

describe("the Databricks integration", () => {
  test("registers databricks-work with the host, client ID, scope, role and hidden relay fields", async () => {
    const { data } = await host.client.integration.get({ integrationID: WORK, ...at() })
    expect(data.name).toBe("Databricks")
    const method = data.methods.find((entry) => entry.type === "oauth") as { id?: string; label?: string; form?: Array<Record<string, unknown>> } | undefined
    expect(method).toMatchObject({ id: "databricks", label: "Sign in with Databricks" })
    const form = method?.form ?? []
    expect(form.map((field) => field["key"])).toEqual(["host", "clientId", "scopes", "role", "redirectUri", "callbackPort"])
    expect(form[0]).toMatchObject({ type: "string", required: true })
    expect(form[1]).toMatchObject({ type: "string", required: true })
    expect(form[2]).toMatchObject({ type: "string", required: true, default: "fine" })
    expect((form[2]!["options"] as Array<{ description: string }>)[0]!.description).toBe("Requests: sql unity-catalog query-history openid email profile offline_access")
    expect(form[3]).toMatchObject({ type: "string", required: false })
    expect(String(form[3]!["description"])).toContain("At Allowed, the agent can change or delete anything your Databricks identity can")
    for (const field of form.slice(4)) expect(field).toMatchObject({ hidden: true, required: false })
    expect(form[5]).toMatchObject({ type: "integer", minimum: 1, maximum: 65_535, default: 8765 })
  }, 120_000)

  test("starts a sign-in with PKCE S256, the scope set and the loopback redirect", async () => {
    const port = await freePort()
    const answer = await connect({ host: HOST, clientId: CLIENT_ID, scopes: "fine", callbackPort: port })
    try {
      const url = new URL(answer.url)
      expect(url.origin).toBe(HOST)
      expect(url.pathname).toBe("/oidc/v1/authorize")
      expect(url.searchParams.get("client_id")).toBe(CLIENT_ID)
      expect(url.searchParams.get("redirect_uri")).toBe(`http://localhost:${port}/callback`)
      expect(url.searchParams.get("response_type")).toBe("code")
      expect(url.searchParams.get("code_challenge_method")).toBe("S256")
      expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/u)
      expect(url.searchParams.get("scope")).toBe("sql unity-catalog query-history openid email profile offline_access")
      expect(url.searchParams.has("assume_group")).toBe(false)
      expect(answer.instructions).toContain(HOST)
      expect(JSON.stringify(answer)).not.toContain(TOKEN)
    } finally {
      await cancel(answer.attemptID)
    }
  }, 120_000)

  test("passes a role as assume_group and the host's relay exactly (L3, L12)", async () => {
    const port = await freePort()
    const answer = await connect({ host: HOST, clientId: CLIENT_ID, scopes: "fine", role: "1234567890123456", redirectUri: "https://id.example.com/connect/callback", callbackPort: port })
    try {
      const url = new URL(answer.url)
      expect(url.searchParams.get("assume_group")).toBe("1234567890123456")
      expect(url.searchParams.get("redirect_uri")).toBe("https://id.example.com/connect/callback")
      expect(answer.instructions).toContain("https://id.example.com/connect/callback")
    } finally {
      await cancel(answer.attemptID)
    }
  }, 120_000)

  test("refuses a bad host, a missing client ID and a non-numeric role before any network call", async () => {
    // The host's form pattern refuses an http URL before the plugin runs; the unit tests pin the plugin's own HOST_INVALID.
    await expect(connect({ host: "http://dbc-1.cloud.databricks.com", clientId: CLIENT_ID, scopes: "fine" })).rejects.toThrow(/does not match pattern|HOST_INVALID/u)
    await expect(connect({ host: HOST, scopes: "fine" })).rejects.toThrow(/Missing required form field: clientId|AUTH_CLIENT_INVALID/u)
    await expect(connect({ host: HOST, clientId: CLIENT_ID, scopes: "fine", role: "admins" })).rejects.toThrow()
    await expect(connect({ host: HOST, clientId: CLIENT_ID, scopes: "everything" })).rejects.toThrow()
  }, 120_000)
})

describe("/databricks-doctor", () => {
  /** The synthetic message a command posts, polled from the session's inbox (this host emits no event for it). */
  async function runCommand(name: string): Promise<string> {
    const session = await host.client.sessions.create({ location: host.location })
    await host.client.sessions.command({ sessionID: session.id, name, text: "" })
    const item = await until(
      `the ${name} command to post its report`,
      async () => {
        const inbox = await host.client.sessions.inbox.list({ sessionID: session.id })
        return inbox.find((entry) => entry.type === "synthetic" && JSON.stringify(entry).includes("Databricks doctor"))
      },
      30_000,
    )
    return JSON.stringify(item)
  }

  test("is registered and reports a missing sign-in without a request off the machine", async () => {
    const { data } = await host.client.command.list({ ...at() })
    expect(data.map((command) => command.name)).toContain("databricks-doctor")
    const event = await runCommand("databricks-doctor")
    expect(event).toContain("Databricks doctor")
    expect(event).toContain("work (interactive")
    expect(event).toContain("AUTH_REQUIRED")
    expect(event).toContain("Next step:")
  }, 120_000)

  test("reads a stored sign-in through the host's credential store, and no token reaches the report", async () => {
    await host.client.credential.create({
      integrationID: WORK,
      activate: true,
      value: {
        type: "oauth",
        methodID: "databricks",
        refresh: "doau000000000000000000000000000000000000000000",
        access: TOKEN,
        expires: Date.now() + 3_600_000,
        metadata: signInMetadata({
          host: HOST,
          clientId: CLIENT_ID,
          scopes: "fine",
          requestedScopes: ["sql", "unity-catalog", "query-history", "offline_access"],
          grantedScopes: ["sql", "unity-catalog", "query-history", "openid", "email", "profile", "offline_access"],
        }),
      } as never,
    })
    const event = await runCommand("databricks-doctor")
    expect(event).toContain("sign-in: OK")
    expect(event).toContain("UNAVAILABLE")
    expect(event).toContain("not built yet")
    expect(event).not.toContain(TOKEN)
  }, 120_000)
})
