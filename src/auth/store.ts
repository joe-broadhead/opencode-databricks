/**
 * The non-secret summary of each sign-in, so status can name an account's workspace and role at startup (design §3.1).
 *
 * The credentials live in OpenCode's credential store, which this plugin reads asynchronously. `AuthPort.accounts()` is
 * synchronous, and resolving a credential at setup could refresh an expired token, which is a network call setup must
 * not make. So the summary is kept beside it in OpenCode's storage: the workspace host and the bound role group, and
 * nothing else. No token, secret, user name or identity ever goes here.
 *
 * A stale summary can only mislead a display: every token call re-reads the credential's own metadata and compares it,
 * so a host or role that no longer matches answers `AUTH_REQUIRED` rather than being used. A storage failure is
 * ignored: the plugin stays correct, it just cannot show the account before its first call.
 */
import { parseWorkspaceHost } from "./host.js"

export const SIGN_INS_KEY = "sign-ins"

export interface SignInSummary {
  readonly host: string
  readonly roleGroupId?: string
}

/** What OpenCode's storage offers; the plugin passes `ctx.storage`, a test a Map. */
export interface SummaryStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

interface Stored {
  readonly version: 1
  readonly accounts: Readonly<Record<string, SignInSummary>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function read(value: unknown): Readonly<Record<string, SignInSummary>> {
  if (!isRecord(value) || value["version"] !== 1 || !isRecord(value["accounts"])) return {}
  const accounts: Record<string, SignInSummary> = {}
  for (const [alias, entry] of Object.entries(value["accounts"])) {
    if (!isRecord(entry) || typeof entry["host"] !== "string" || entry["host"] === "") continue
    const role = typeof entry["roleGroupId"] === "string" && /^\d{1,40}$/u.test(entry["roleGroupId"]) ? entry["roleGroupId"] : undefined
    accounts[alias] = { host: entry["host"], ...(role !== undefined ? { roleGroupId: role } : {}) }
  }
  return accounts
}

export class SignInSummaries {
  private accounts: Record<string, SignInSummary> = {}
  private readonly storage: SummaryStorage | undefined

  constructor(storage: SummaryStorage | undefined) {
    this.storage = storage
  }

  /** Load the stored summary, dropping any entry that names a host this plugin would refuse. */
  async load(): Promise<void> {
    if (!this.storage) return
    let value: unknown
    try {
      value = await this.storage.get(SIGN_INS_KEY)
    } catch {
      return
    }
    const parsed = read(value)
    const valid: Record<string, SignInSummary> = {}
    for (const [alias, summary] of Object.entries(parsed)) {
      try {
        parseWorkspaceHost(summary.host, true)
        valid[alias] = summary
      } catch {
        // A summary this plugin would refuse is not a workspace; drop it.
      }
    }
    this.accounts = valid
  }

  get(alias: string): SignInSummary | undefined {
    return this.accounts[alias]
  }

  /** Record what a sign-in or a token call proved, and persist it when it changed. */
  async remember(alias: string, summary: SignInSummary): Promise<void> {
    const before = this.accounts[alias]
    if (before?.host === summary.host && before.roleGroupId === summary.roleGroupId) return
    this.accounts = { ...this.accounts, [alias]: summary }
    if (!this.storage) return
    const value: Stored = { version: 1, accounts: this.accounts }
    try {
      await this.storage.set(SIGN_INS_KEY, value)
    } catch {
      // Display only; a failed write changes no decision.
    }
  }
}
