// The headless modes (design §3.2, §15.1): pat from the environment, m2m against a fake token endpoint, cli against a
// fake `databricks` executable, and HEADLESS_REFUSED in a simulated Jelly host.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import { isHostedEngine, JELLY_PLUGIN_SECRETS } from "../../../src/auth/jelly.js"
import { DUMMY_TOKEN, FAKE_HOST, authCore, tokenEndpoint, type FakeTokenEndpoint } from "./support.js"

const CLIENT_ID = "7f3e2a10-5c4b-4d8e-9a1f-2b6c8d0e4f12"
const SECRET = "dose-not-a-real-oauth-secret"
const NOW = Date.parse("2026-11-17T12:00:00Z")
const signal = () => new AbortController().signal
const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run()
    return "OK"
  } catch (error) {
    return error instanceof DatabricksError ? error.code : "OTHER"
  }
}

const dirs: string[] = []
const endpoints: FakeTokenEndpoint[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const endpoint of endpoints.splice(0)) await endpoint.close()
})

function fakeCli(body: string): { readonly command: string; readonly dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "dbx-auth-cli-"))
  dirs.push(dir)
  const command = join(dir, "databricks")
  writeFileSync(command, `#!/bin/sh\n${body.replaceAll("$DIR", dir)}\n`)
  chmodSync(command, 0o755)
  return { command, dir }
}

const m2mOptions = { accounts: { ci: { mode: "m2m", host: FAKE_HOST, clientId: CLIENT_ID, clientSecretEnv: "DBX_CLIENT_SECRET" } } }

describe("pat", () => {
  it("reads the token from the environment variable the option names", async () => {
    const { core } = authCore({ accounts: { ci: { mode: "pat", host: FAKE_HOST, tokenEnv: "DBX_TOKEN" } } }, { env: { DBX_TOKEN: DUMMY_TOKEN }, now: () => NOW })
    const token = await core.token("ci", ["sql"], signal())
    expect(token.accessToken).toBe(DUMMY_TOKEN)
    expect(token.scopes).toEqual(["all-apis"])
  })

  it("refuses an unset variable with AUTH_REQUIRED naming it, and no value in the message", async () => {
    const { core } = authCore({ accounts: { ci: { mode: "pat", host: FAKE_HOST, tokenEnv: "DBX_TOKEN" } } }, { env: {}, now: () => NOW })
    const error = (await core.token("ci", ["sql"], signal()).catch((caught: unknown) => caught)) as DatabricksError
    expect(error.code).toBe("AUTH_REQUIRED")
    expect(error.message).toContain("DBX_TOKEN")
    expect(error.message).not.toContain(DUMMY_TOKEN)
  })
})

describe("m2m", () => {
  it("sends HTTP Basic with client_credentials and the scopes the call needs, and caches until it nears expiry", async () => {
    const endpoint = await tokenEndpoint(() => ({ status: 200, body: { access_token: "A-m2m", token_type: "Bearer", expires_in: 3600 } }))
    endpoints.push(endpoint)
    const { core } = authCore(m2mOptions, { env: { DBX_CLIENT_SECRET: SECRET }, now: () => NOW, tokenEndpoint: endpoint.url, fetch: globalThis.fetch })
    const token = await core.token("ci", ["sql", "unity-catalog"], signal())
    expect(token.accessToken).toBe("A-m2m")
    expect(token.expiresAt).toBe(NOW + 3_600_000)
    expect(endpoint.requests).toHaveLength(1)
    expect(endpoint.requests[0]!.authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64")}`)
    const form = endpoint.requests[0]!.form
    expect(form.get("grant_type")).toBe("client_credentials")
    expect(form.get("scope")).toBe("sql unity-catalog")
    expect(form.get("assume_group")).toBeNull()
    await core.token("ci", ["unity-catalog", "sql"], signal())
    expect(endpoint.requests).toHaveLength(1)
  })

  it("adds assume_group for a role (L3)", async () => {
    const endpoint = await tokenEndpoint(() => ({ status: 200, body: { access_token: "A-m2m", token_type: "Bearer", expires_in: 3600 } }))
    endpoints.push(endpoint)
    const { core } = authCore({ accounts: { ci: { mode: "m2m", host: FAKE_HOST, clientId: CLIENT_ID, clientSecretEnv: "DBX_CLIENT_SECRET", role: "1234567890123456" } } }, { env: { DBX_CLIENT_SECRET: SECRET }, now: () => NOW, tokenEndpoint: endpoint.url })
    await core.token("ci", ["sql"], signal())
    expect(endpoint.requests[0]!.form.get("assume_group")).toBe("1234567890123456")
  })

  it("P3: builds the endpoint from the normalised host, so a trailing slash or other case cannot double the path", async () => {
    const seen: string[] = []
    const fetch = (async (url: string | URL | Request) => {
      seen.push(String(url))
      return new Response(JSON.stringify({ access_token: "A", expires_in: 3600 }), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const { core } = authCore(
      { accounts: { ci: { mode: "m2m", host: "https://X.cloud.databricks.com/", clientId: CLIENT_ID, clientSecretEnv: "DBX_CLIENT_SECRET" } } },
      { env: { DBX_CLIENT_SECRET: SECRET }, now: () => NOW, fetch },
    )
    await core.token("ci", ["sql"], signal())
    expect(seen).toEqual(["https://x.cloud.databricks.com/oidc/v1/token"])
  })

  it("maps invalid_client to AUTH_CLIENT_INVALID and invalid_scope to AUTH_SCOPE_MISSING", async () => {
    for (const [oauth, expected] of [
      ["invalid_client", "AUTH_CLIENT_INVALID"],
      ["invalid_scope", "AUTH_SCOPE_MISSING"],
    ] as const) {
      const endpoint = await tokenEndpoint(() => ({ status: 400, body: { error: oauth, error_description: "provider text" } }))
      endpoints.push(endpoint)
      const { core } = authCore(m2mOptions, { env: { DBX_CLIENT_SECRET: SECRET }, now: () => NOW, tokenEndpoint: endpoint.url })
      const error = (await core.token("ci", ["sql"], signal()).catch((caught: unknown) => caught)) as DatabricksError
      expect(error.code).toBe(expected)
      expect(error.message).toContain(oauth)
      expect(error.message).not.toContain("provider text")
      expect(error.message).not.toContain(SECRET)
    }
  })

  it("refuses an unset secret, naming its variable and never its value", async () => {
    const { core } = authCore(m2mOptions, { env: {}, now: () => NOW })
    const error = (await core.token("ci", ["sql"], signal()).catch((caught: unknown) => caught)) as DatabricksError
    expect(error.code).toBe("AUTH_REQUIRED")
    expect(error.message).toContain("DBX_CLIENT_SECRET")
  })
})

describe("cli", () => {
  it("runs databricks auth token --profile <profile> -o json and reads access_token and expiry", async () => {
    const { command, dir } = fakeCli(
      `printf '%s\\n' "$@" > $DIR/args.txt\nenv > $DIR/env.txt\nprintf '%s' '{"access_token":"${DUMMY_TOKEN}","token_type":"Bearer","expiry":"2027-01-01T00:00:00Z"}'`,
    )
    const { core } = authCore({ accounts: { lap: { mode: "cli", host: FAKE_HOST, profile: "work" } } }, { env: { PATH: process.env.PATH ?? "", DATABRICKS_TOKEN: DUMMY_TOKEN, DATABRICKS_HOST: "https://elsewhere.example.com", DATABRICKS_CONFIG_FILE: "/tmp/profiles" }, now: () => NOW, cliCommand: command })
    const token = await core.token("lap", ["sql"], signal())
    expect(token.accessToken).toBe(DUMMY_TOKEN)
    expect(token.expiresAt).toBe(Date.parse("2027-01-01T00:00:00Z"))
    expect(readFileSync(join(dir, "args.txt"), "utf8").trim().split("\n")).toEqual(["auth", "token", "--profile", "work", "-o", "json"])
    const environment = readFileSync(join(dir, "env.txt"), "utf8")
    expect(environment).not.toMatch(/^DATABRICKS_TOKEN=/mu)
    expect(environment).not.toMatch(/^DATABRICKS_HOST=/mu)
    expect(environment).toContain("DATABRICKS_CONFIG_FILE=/tmp/profiles")
  })

  it("caches until the reported expiry", async () => {
    let runs = 0
    const { core } = authCore(
      { accounts: { lap: { mode: "cli", host: FAKE_HOST, profile: "work" } } },
      {
        now: () => NOW,
        runCli: async () => {
          runs += 1
          return { code: 0, stdout: JSON.stringify({ access_token: "A-cli", expiry: "2026-11-17T13:00:00Z" }), stderr: "" }
        },
      },
    )
    await core.token("lap", ["sql"], signal())
    await core.token("lap", ["jobs"], signal())
    expect(runs).toBe(1)
  })

  it("refuses a CLI that is missing, that fails, that answers no JSON, or whose token has expired", async () => {
    const missing = authCore({ accounts: { lap: { mode: "cli", host: FAKE_HOST, profile: "work" } } }, { now: () => NOW, cliCommand: "/nonexistent/databricks-for-tests" }).core
    expect(await codeOf(() => missing.token("lap", ["sql"], signal()))).toBe("AUTH_REQUIRED")

    const failing = fakeCli(`echo "the CLI failed for ${DUMMY_TOKEN}" >&2\nexit 1`)
    const failed = authCore({ accounts: { lap: { mode: "cli", host: FAKE_HOST, profile: "work" } } }, { now: () => NOW, cliCommand: failing.command }).core
    const failure = (await failed.token("lap", ["sql"], signal()).catch((caught: unknown) => caught)) as DatabricksError
    expect(failure.code).toBe("AUTH_REQUIRED")
    expect(failure.message).toContain("profile work")
    expect(failure.message).not.toContain(DUMMY_TOKEN)
    expect(failure.message).not.toContain("the CLI failed for")
    // The CLI's own text is provider data: it goes to providerError, redacted, and never to the message.
    expect(failure.providerError?.message).toContain("the CLI failed for")
    expect(failure.providerError?.message).not.toContain(DUMMY_TOKEN)
    expect(failure.providerError?.trust).toBe("untrusted")

    const nonsense = fakeCli(`printf '%s' 'not json'`)
    const bad = authCore({ accounts: { lap: { mode: "cli", host: FAKE_HOST, profile: "work" } } }, { now: () => NOW, cliCommand: nonsense.command }).core
    expect(await codeOf(() => bad.token("lap", ["sql"], signal()))).toBe("AUTH_REQUIRED")

    const stale = fakeCli(`printf '%s' '{"access_token":"A-old","expiry":"2020-01-01T00:00:00Z"}'`)
    const expired = authCore({ accounts: { lap: { mode: "cli", host: FAKE_HOST, profile: "work" } } }, { now: () => NOW, cliCommand: stale.command }).core
    expect(await codeOf(() => expired.token("lap", ["sql"], signal()))).toBe("AUTH_REQUIRED")
  })
})

describe("a Jelly-hosted engine", () => {
  it("P5: any of the three handoff globals Jelly installs marks a hosted engine", () => {
    expect(isHostedEngine({ [JELLY_PLUGIN_SECRETS]: { get: () => undefined } })).toBe(true)
    expect(isHostedEngine({ [Symbol.for("jelly.engine-seal")]: {} })).toBe(true)
    expect(isHostedEngine({ [Symbol.for("jelly.action-key")]: {} })).toBe(true)
    expect(isHostedEngine({})).toBe(false)
    expect(isHostedEngine({ [Symbol.for("another.host")]: {} })).toBe(false)
  })

  it("refuses pat, m2m and cli with HEADLESS_REFUSED, before an environment read, a request or a process", async () => {
    const pat = authCore({ accounts: { ci: { mode: "pat", host: FAKE_HOST, tokenEnv: "DBX_TOKEN" } } }, { env: { DBX_TOKEN: DUMMY_TOKEN }, hosted: true, now: () => NOW }).core
    expect(await codeOf(() => pat.token("ci", ["sql"], signal()))).toBe("HEADLESS_REFUSED")

    const m2m = authCore(m2mOptions, {
      env: { DBX_CLIENT_SECRET: SECRET },
      hosted: true,
      now: () => NOW,
      fetch: (async () => {
        throw new Error("a hosted m2m token must not reach the network")
      }) as unknown as typeof globalThis.fetch,
    }).core
    expect(await codeOf(() => m2m.token("ci", ["sql"], signal()))).toBe("HEADLESS_REFUSED")

    const cli = authCore(
      { accounts: { lap: { mode: "cli", host: FAKE_HOST, profile: "work" } } },
      {
        hosted: true,
        now: () => NOW,
        runCli: async () => {
          throw new Error("a hosted cli token must not spawn a process")
        },
      },
    ).core
    expect(await codeOf(() => cli.token("lap", ["sql"], signal()))).toBe("HEADLESS_REFUSED")
  })

  it("allows a headless mode with allowHeadlessInHost, the person's explicit choice", async () => {
    const { core } = authCore({ allowHeadlessInHost: true, accounts: { ci: { mode: "pat", host: FAKE_HOST, tokenEnv: "DBX_TOKEN" } } }, { env: { DBX_TOKEN: DUMMY_TOKEN }, hosted: true, now: () => NOW })
    await expect(core.token("ci", ["sql"], signal())).resolves.toMatchObject({ accessToken: DUMMY_TOKEN })
  })
})
