/**
 * Test support for package A: a fake OAuth token endpoint on loopback (never Databricks), a free callback port, a
 * credential builder, and an in-memory sign-in summary. Invented values only.
 */
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { signInMetadata } from "../../../src/auth/credential.js"
import { AuthCore, type CoreInput } from "../../../src/auth/index.js"
import { SignInSummaries, type SummaryStorage } from "../../../src/auth/store.js"
import type { HostCredential } from "../../../src/auth/types.js"
import type { CliRunner } from "../../../src/auth/headless.js"
import { loadOptions, type Options } from "../../../src/options.js"
import { DUMMY_TOKEN, FAKE_HOST } from "../../fake/ports.js"

export { DUMMY_TOKEN, FAKE_HOST }

export interface RecordedTokenRequest {
  readonly form: URLSearchParams
  readonly authorization?: string
}

export interface FakeTokenEndpoint {
  readonly url: string
  readonly requests: RecordedTokenRequest[]
  close(): Promise<void>
}

/** A loopback token endpoint that answers from `handler` and records every form it received. */
export async function tokenEndpoint(handler: (form: URLSearchParams, index: number) => { readonly status: number; readonly body: unknown }): Promise<FakeTokenEndpoint> {
  const requests: RecordedTokenRequest[] = []
  const server: Server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")))
    request.on("end", () => {
      const form = new URLSearchParams(body)
      requests.push({ form, ...(request.headers.authorization !== undefined ? { authorization: request.headers.authorization } : {}) })
      const answer = handler(form, requests.length - 1)
      response.writeHead(answer.status, { "content-type": "application/json" })
      response.end(JSON.stringify(answer.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/oidc/v1/token`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** A port no listener holds now; the authorize listener takes it a moment later. */
export async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

export interface CredentialInput {
  readonly host?: string
  readonly clientId?: string
  readonly access?: string
  readonly refresh?: string
  readonly expires?: number
  readonly requestedScopes?: readonly string[]
  readonly grantedScopes?: readonly string[]
  readonly choice?: "fine" | "all-apis"
  readonly roleGroupId?: string
  readonly generation?: number
}

/** A stored OAuth credential with a valid sign-in record. */
export function hostCredential(input: CredentialInput = {}): HostCredential {
  return {
    type: "oauth",
    methodID: "databricks",
    refresh: input.refresh ?? "doau-not-a-real-refresh-token",
    access: input.access ?? DUMMY_TOKEN,
    expires: input.expires ?? Date.now() + 3_600_000,
    metadata: signInMetadata({
      host: input.host ?? FAKE_HOST,
      clientId: input.clientId ?? "7f3e2a10-5c4b-4d8e-9a1f-2b6c8d0e4f12",
      scopes: input.choice ?? "fine",
      requestedScopes: input.requestedScopes ?? ["sql", "unity-catalog", "query-history", "offline_access"],
      grantedScopes: input.grantedScopes ?? ["sql", "unity-catalog", "query-history", "offline_access"],
      ...(input.roleGroupId !== undefined ? { roleGroupId: input.roleGroupId } : {}),
      ...(input.generation !== undefined ? { generation: input.generation } : {}),
    }),
  }
}

/** In-memory storage, with the JSON round trip OpenCode does. */
export function memoryStorage(initial?: unknown): SummaryStorage & { readonly value: () => unknown } {
  let stored: unknown = initial
  return {
    async get() {
      return stored
    },
    async set(_key, value) {
      stored = JSON.parse(JSON.stringify(value)) as unknown
    },
    value: () => stored,
  }
}

export interface CoreOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly hosted?: boolean
  readonly fetch?: typeof globalThis.fetch
  readonly runCli?: CliRunner
  readonly cliCommand?: string
  readonly tokenEndpoint?: string
  readonly now?: () => number
  readonly credential?: HostCredential
  readonly read?: (alias: string, signal: AbortSignal) => Promise<HostCredential | undefined>
  readonly storage?: SummaryStorage
}

export interface Core {
  readonly core: AuthCore
  readonly summaries: SignInSummaries
  readonly storage: SummaryStorage
  readonly reads: { count: number }
}

/** An auth core over options-like input, with a credential source a test controls. */
export function authCore(rawOptions: Record<string, unknown>, options: CoreOptions = {}): Core {
  const parsed: Options = loadOptions(rawOptions)
  const storage = options.storage ?? memoryStorage()
  const summaries = new SignInSummaries(storage)
  const reads = { count: 0 }
  const credential = options.credential
  const input: CoreInput = {
    options: parsed,
    summaries,
    credentials: {
      async read(alias, signal) {
        reads.count += 1
        if (options.read) return options.read(alias, signal)
        return credential
      },
    },
    env: options.env ?? {},
    now: options.now ?? Date.now,
    hosted: options.hosted ?? false,
    fetch: options.fetch ?? globalThis.fetch,
    ...(options.runCli !== undefined ? { runCli: options.runCli } : {}),
    ...(options.cliCommand !== undefined ? { cliCommand: options.cliCommand } : {}),
    ...(options.tokenEndpoint !== undefined ? { tokenEndpoint: options.tokenEndpoint } : {}),
  }
  return { core: new AuthCore(input), summaries, storage, reads }
}
