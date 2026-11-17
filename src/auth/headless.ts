/**
 * The headless modes: `pat`, `m2m` and `cli` (design §3.2). They are opt-in, one per account, and never a fallback: an
 * interactive account does not try them, and none of them reads a file the plugin owns.
 *
 * - `pat` reads the personal access token from the environment variable `tokenEnv` names. It has no expiry the plugin
 *   can know, and a PAT is the user's own identity, so no role applies.
 * - `m2m` exchanges the service principal's client ID and the OAuth secret `clientSecretEnv` names at the workspace
 *   token endpoint, with HTTP Basic and `grant_type=client_credentials&scope=…`, plus `assume_group=<group-id>` for a
 *   role. That is Databricks' documented M2M request, and `assume_group` is "supported only for workspace-level
 *   tokens" [10], which is what this endpoint issues.
 * - `cli` runs `databricks auth token --profile <profile> -o json` and reads `access_token` and `expiry` from its
 *   answer [14]. The CLI owns refresh and the OS keychain; this plugin never reads `~/.databrickscfg` or the keychain,
 *   and strips every `DATABRICKS_*` variable from the child's environment so an environment token cannot silently
 *   replace the profile's identity.
 *
 * No secret is ever in an option, a message, a result or a log line: the options name variables and a profile, and the
 * values are read here only. The tests use a fake token endpoint and a fake `databricks` executable.
 */
import { spawn } from "node:child_process"
import { DatabricksError } from "../domain/errors.js"
import { reasonOf } from "../redact.js"
import type { AccountSettings } from "./accounts.js"
import { requestToken } from "./token.js"
import type { Token } from "../ports.js"

const CACHE_SKEW_MS = 60_000
const CLI_TIMEOUT_MS = 30_000
const OUTPUT_CAP = 1024 * 1024

/** A token with the moment it stops being usable, shared by the modes that mint one. */
export interface TokenCache {
  get(key: string, now: number): Token | undefined
  set(key: string, token: Token): void
}

export function tokenCache(): TokenCache {
  const entries = new Map<string, Token>()
  return {
    get(key, now) {
      const token = entries.get(key)
      if (!token || token.expiresAt - CACHE_SKEW_MS <= now) return undefined
      return token
    },
    set(key, token) {
      entries.set(key, token)
    },
  }
}

/**
 * The personal access token from `tokenEnv`. A PAT carries whatever its user carries, so its scope is unknown here and
 * treated as every scope; only an interactive sign-in's grants are checked.
 */
export function patToken(alias: string, settings: AccountSettings, env: NodeJS.ProcessEnv): Token {
  const name = settings.tokenEnv
  if (!name) throw new DatabricksError("AUTH_REQUIRED", `Account ${alias} uses mode pat but names no tokenEnv.`, `Set accounts.${alias}.tokenEnv to the environment variable that holds the token.`)
  const value = env[name]?.trim()
  if (!value) {
    throw new DatabricksError("AUTH_REQUIRED", `The environment variable ${name} for ${alias} is not set.`, `Set ${name} to a Databricks personal access token, or sign in interactively with /connect.`)
  }
  return { accessToken: value, expiresAt: Number.MAX_SAFE_INTEGER, scopes: ["all-apis"] }
}

/** What an M2M token asks for: the scopes this call needs, or all of them when the caller named none. */
function m2mScope(scopes: readonly string[]): string {
  const named = scopes.filter((scope) => scope !== "any").sort()
  return named.length > 0 ? named.join(" ") : "all-apis"
}

export interface M2mInput {
  readonly alias: string
  readonly settings: AccountSettings
  readonly env: NodeJS.ProcessEnv
  readonly scopes: readonly string[]
  readonly fetch: typeof globalThis.fetch
  readonly now: () => number
  readonly signal: AbortSignal
  readonly cache: TokenCache
  readonly tokenEndpoint?: string
}

/** The service principal's workspace token, from the client credentials grant [10]. */
export async function m2mToken(input: M2mInput): Promise<Token> {
  if (input.signal.aborted) throw new DatabricksError("CANCELLED", "The call was stopped.")
  const { alias, settings } = input
  const secretName = settings.clientSecretEnv
  const clientId = settings.clientId
  if (!secretName) throw new DatabricksError("AUTH_REQUIRED", `Account ${alias} uses mode m2m but names no clientSecretEnv.`, `Set accounts.${alias}.clientSecretEnv to the environment variable that holds the OAuth secret.`)
  if (!clientId) throw new DatabricksError("AUTH_CLIENT_INVALID", `Account ${alias} uses mode m2m but names no clientId.`, `Set accounts.${alias}.clientId to the service principal's application ID.`)
  const secret = input.env[secretName]
  if (!secret) {
    throw new DatabricksError("AUTH_REQUIRED", `The environment variable ${secretName} for ${alias} is not set.`, `Set ${secretName} to the service principal's OAuth secret, or sign in interactively with /connect.`)
  }
  const host = settings.host
  if (!host) throw new DatabricksError("AUTH_CLIENT_INVALID", `Account ${alias} uses mode m2m but names no workspace host.`, `Set accounts.${alias}.host to the workspace URL.`)
  const scope = m2mScope(input.scopes)
  const key = `m2m:${alias}:${scope}`
  const cached = input.cache.get(key, input.now())
  if (cached) return cached
  const token = await requestToken({
    endpoint: input.tokenEndpoint ?? `${host}/oidc/v1/token`,
    form: {
      grant_type: "client_credentials",
      scope,
      ...(settings.role !== undefined ? { assume_group: settings.role } : {}),
    },
    basic: { user: clientId, secret },
    fetch: input.fetch,
    signal: input.signal,
    invalidScope: "scope",
  })
  const granted = token.scopes ?? scope.split(" ")
  const minted: Token = { accessToken: token.accessToken, expiresAt: input.now() + token.expiresIn * 1000, scopes: granted }
  input.cache.set(key, minted)
  return minted
}

export interface CliResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  /** The executable was not found. */
  readonly missing?: boolean
  readonly timedOut?: boolean
  readonly aborted?: boolean
}

export type CliRunner = (input: { readonly command: string; readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv; readonly signal: AbortSignal; readonly timeoutMs: number }) => Promise<CliResult>

/** Run the CLI without a shell, with a timeout and the caller's cancellation. */
export const runDatabricksCli: CliRunner = (input) =>
  new Promise<CliResult>((resolve) => {
    if (input.signal.aborted) {
      resolve({ code: null, stdout: "", stderr: "", aborted: true })
      return
    }
    let stdout = ""
    let stderr = ""
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const child = spawn(input.command, [...input.args], { shell: false, env: input.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    const finish = (result: Omit<CliResult, "stdout" | "stderr">): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ ...result, stdout, stderr })
    }
    timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish({ code: null, timedOut: true })
    }, input.timeoutMs)
    timer.unref?.()
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += chunk.toString("utf8")
    })
    child.on("error", (error: NodeJS.ErrnoException) => finish({ code: null, ...(error.code === "ENOENT" ? { missing: true } : {}) }))
    child.on("close", (code) => finish({ code }))
    input.signal.addEventListener(
      "abort",
      () => {
        child.kill("SIGTERM")
        const force = setTimeout(() => child.kill("SIGKILL"), 1000)
        force.unref?.()
        finish({ code: null, aborted: true })
      },
      { once: true },
    )
  })

export interface CliInput {
  readonly alias: string
  readonly settings: AccountSettings
  readonly env: NodeJS.ProcessEnv
  readonly now: () => number
  readonly signal: AbortSignal
  readonly cache: TokenCache
  readonly run?: CliRunner
  /** Tests run a fake `databricks`; production looks it up on PATH. */
  readonly command?: string
}

/** The child's environment: the parent's, minus every DATABRICKS_* variable, so `--profile` is the only identity. */
function cliEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) if (!key.startsWith("DATABRICKS_")) cleaned[key] = value
  return cleaned
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The token `databricks auth token --profile <profile>` reports: `{ access_token, token_type, expiry }` [14]. */
export async function cliToken(input: CliInput): Promise<Token> {
  if (input.signal.aborted) throw new DatabricksError("CANCELLED", "The call was stopped.")
  const { alias, settings } = input
  const profile = settings.profile
  if (!profile) throw new DatabricksError("AUTH_REQUIRED", `Account ${alias} uses mode cli but names no profile.`, `Set accounts.${alias}.profile to a profile \`databricks auth login\` created.`)
  const cached = input.cache.get(`cli:${alias}`, input.now())
  if (cached) return cached
  const runner = input.run ?? runDatabricksCli
  const result = await runner({
    command: input.command ?? "databricks",
    args: ["auth", "token", "--profile", profile, "-o", "json"],
    env: cliEnvironment(input.env),
    signal: input.signal,
    timeoutMs: CLI_TIMEOUT_MS,
  })
  if (result.aborted) throw new DatabricksError("CANCELLED", "The call was stopped.")
  if (result.missing) {
    throw new DatabricksError("AUTH_REQUIRED", "The Databricks CLI is not installed or not on PATH.", `Install the CLI and run databricks auth login --profile ${profile}, or sign in interactively with /connect.`)
  }
  if (result.timedOut) throw new DatabricksError("UNAVAILABLE", `The Databricks CLI did not answer within ${CLI_TIMEOUT_MS / 1000} seconds for profile ${profile}.`, "Run databricks auth token --profile " + profile + " in a terminal to see why.")
  if (result.code !== 0) {
    const reason = reasonOf(result.stderr, "no reason given")
    throw new DatabricksError("AUTH_REQUIRED", `The Databricks CLI could not get a token for profile ${profile}: ${reason}.`, `Run databricks auth login --profile ${profile} again, or sign in interactively with /connect.`)
  }
  let answer: unknown
  try {
    answer = JSON.parse(result.stdout)
  } catch {
    throw new DatabricksError("AUTH_REQUIRED", `The Databricks CLI's answer for profile ${profile} is not JSON.`, "Update the Databricks CLI, or sign in interactively with /connect.")
  }
  const access = isRecord(answer) && typeof answer["access_token"] === "string" ? answer["access_token"] : ""
  const expiry = isRecord(answer) && typeof answer["expiry"] === "string" ? Date.parse(answer["expiry"]) : Number.NaN
  if (!access) throw new DatabricksError("AUTH_REQUIRED", `The Databricks CLI returned no access token for profile ${profile}.`, `Run databricks auth login --profile ${profile} again.`)
  if (Number.isNaN(expiry)) throw new DatabricksError("AUTH_REQUIRED", `The Databricks CLI returned no usable expiry for profile ${profile}.`, "Update the Databricks CLI, then run databricks auth login again.")
  if (expiry <= input.now()) throw new DatabricksError("AUTH_REQUIRED", `The Databricks CLI's cached token for profile ${profile} has expired.`, `Run databricks auth login --profile ${profile} again.`)
  const token: Token = { accessToken: access, expiresAt: expiry, scopes: ["all-apis"] }
  input.cache.set(`cli:${alias}`, token)
  return token
}
