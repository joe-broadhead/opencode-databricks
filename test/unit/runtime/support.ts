// Shared setup for the runtime's tests: the fake workspace, an auth port that points at it, and the ways a test
// reaches the two. Nothing here contacts anything but 127.0.0.1.
import type { AccountInfo, AuthPort, Token } from "../../../src/ports.js"
import { DUMMY_TOKEN } from "../../fake/ports.js"
import type { FakeDatabricks } from "../../fake/databricks.js"
import { startFakeDatabricks } from "../../fake/databricks-server.js"

/** The fake's account: a loopback host, so the whole suite stays on this machine. */
export const accountOf = (fake: FakeDatabricks, overrides: Partial<AccountInfo> = {}): AccountInfo => ({
  alias: "work",
  mode: "interactive",
  host: fake.origin,
  cloud: "aws",
  features: [],
  warehouse: "wh-small",
  enforcement: "identity",
  ...overrides,
})

/** An auth port that answers the fake's token, or refuses the scopes a test withholds. */
export function fakeAuth(account: AccountInfo, granted: readonly string[] = ["sql", "unity-catalog", "query-history", "jobs", "workspace", "files"]): AuthPort & { readonly asked: { scopes: readonly string[] }[] } {
  const asked: { scopes: readonly string[] }[] = []
  return {
    asked,
    accounts: () => [account],
    account: (alias?: string) => {
      if (alias && alias !== account.alias) throw new Error(`no account ${alias}`)
      return account
    },
    async token(_account: string, scopes: readonly string[]): Promise<Token> {
      asked.push({ scopes })
      const missing = scopes.filter((scope) => !granted.includes(scope) && !granted.includes("all-apis"))
      if (missing.length) throw new Error(`the sign-in lacks ${missing.join(", ")}`)
      return { accessToken: DUMMY_TOKEN, expiresAt: Date.now() + 3_600_000, scopes: granted, host: account.host }
    },
  }
}

/** Starts the fake and the account that points at it. */
export async function workspace(seed?: Parameters<typeof startFakeDatabricks>[0], overrides: Partial<AccountInfo> = {}) {
  const fake = await startFakeDatabricks(seed)
  const account = accountOf(fake, overrides)
  const auth = fakeAuth(account)
  return { fake, account, auth }
}

/** A fetch that sends the storage hosts' links to the fake's `/results/<key>`, as a workspace's egress reaches S3. */
export const routedLinks = (fake: FakeDatabricks, host = /\.amazonaws\.com$/u) => async (input: string, init?: RequestInit): Promise<Response> => {
  const url = new URL(input)
  if (url.protocol === "https:" && host.test(url.hostname)) {
    const key = url.pathname.split("/").filter(Boolean).pop() ?? ""
    return fetch(`${fake.origin}/results/${key}`, init)
  }
  return fetch(input, init)
}

/** The sleeps a retry or a poll made, in milliseconds. No test waits for a real backoff. */
export function recordedSleeps() {
  const waits: number[] = []
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms)
    },
  }
}

/** Waits until a condition holds, for a test that must act while a request is in flight. */
export async function until(what: string, check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Bytes as a string, for a link's stream. */
export async function streamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) parts.push(value)
  }
  return Buffer.concat(parts.map((part) => Buffer.from(part))).toString("utf8")
}
