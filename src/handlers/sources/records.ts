/**
 * What `probe` learns about an account, kept for the content reads (the source contract's rule: identity reads belong
 * to probe). `databricks.queries` lists only the signed-in person's statements, so it filters Query History by their
 * user id; that id comes from SCIM `Me`, which only `probe` reads. `probe` records it here per account and workspace
 * host; a queries read without a record answers `UNAVAILABLE` ("probe this source first"), which a consumer's bind
 * always does first.
 *
 * The record is the user id, user name and display name `Me` answered, written to
 * `$XDG_STATE_HOME/databricks/sources.json` (or `~/.local/state/…`), mode 0600, atomically (a temporary file
 * renamed into place). It holds no token. Signing in to the same alias as someone else keeps the old record until the
 * next probe; a consumer probes again at every bind.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export interface IdentityRecord {
  readonly userId: string
  readonly userName: string
  readonly displayName?: string
  /** When probe recorded it, ms. */
  readonly at: number
}

export interface RecordStore {
  get(account: string, host: string): IdentityRecord | undefined
  put(account: string, host: string, record: IdentityRecord): void
}

const keyOf = (account: string, host: string) => `${account}\u0000${host}`

/** A store in memory: tests, and a fallback when the state folder cannot be written. */
export function memoryRecords(seed: readonly { readonly account: string; readonly host: string; readonly record: IdentityRecord }[] = []): RecordStore {
  const map = new Map<string, IdentityRecord>(seed.map((entry) => [keyOf(entry.account, entry.host), entry.record]))
  return { get: (account, host) => map.get(keyOf(account, host)), put: (account, host, record) => void map.set(keyOf(account, host), record) }
}

/** `$XDG_STATE_HOME/databricks/sources.json`, or `~/.local/state/…` without it (the ledger's folder). */
export function defaultRecordsPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_STATE_HOME && env.XDG_STATE_HOME.startsWith("/") ? env.XDG_STATE_HOME : join(homedir(), ".local", "state")
  return join(base, "databricks", "sources.json")
}

const plainRecord = (value: unknown): IdentityRecord | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const entry = value as Record<string, unknown>
  if (typeof entry.userId !== "string" || typeof entry.userName !== "string" || typeof entry.at !== "number") return undefined
  return { userId: entry.userId, userName: entry.userName, at: entry.at, ...(typeof entry.displayName === "string" ? { displayName: entry.displayName } : {}) }
}

/** A store in one JSON file, read on every `get` (it is small) so several OpenCode processes see one another's probes. */
export function fileRecords(path: string = defaultRecordsPath()): RecordStore {
  const read = (): Record<string, unknown> => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  const memory = memoryRecords()
  return {
    get: (account, host) => plainRecord(read()[keyOf(account, host)]) ?? memory.get(account, host),
    put: (account, host, record) => {
      memory.put(account, host, record)
      try {
        const all = { ...read(), [keyOf(account, host)]: record }
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        const temporary = `${path}.${process.pid}.tmp`
        writeFileSync(temporary, `${JSON.stringify(all)}\n`, { mode: 0o600 })
        renameSync(temporary, path)
      } catch {
        // An unwritable state folder keeps the record for this process only; the next probe tries again.
      }
    },
  }
}

const injected = new WeakMap<object, RecordStore>()
let fallback: RecordStore | undefined

/** Give one dependency set its own store (tests, the conformance kit). */
export function useRecords(deps: object, store: RecordStore): void {
  injected.set(deps, store)
}

/** The store a dependency set reads: its own, or the state file. */
export function recordsOf(deps: object): RecordStore {
  const store = injected.get(deps)
  if (store !== undefined) return store
  if (fallback === undefined) fallback = fileRecords()
  return fallback
}
