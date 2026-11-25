/**
 * The plugin's own automation (design §7, layer 2), by consent and never deleting anything:
 *
 * - **Its own orphaned reads.** When OpenCode reports a session `deleted` or `archived`, the read statements this plugin
 *   started for it — tagged `oc_plugin=databricks`, `oc_session=<hash>`, with a read tool in `oc_tool` — are cancelled.
 *   A read has no effects, so this runs at **every** access level, like Stop, and it is **not** gated on the owner lock:
 *   each process cancels its own sessions' reads, and a second cancel is harmless (review of F, M1). A change statement
 *   and a job run are never cancelled here: their effects can be partial.
 * - **Nothing to cancel means no problem.** A session that ended with nothing running is dropped on its first complete
 *   history window, silently; only a cancel that was tried and failed is reported (review of F, M2).
 * - **One owner per machine**, through a token lock that its holder refreshes (`src/automation/lock.ts`); status reports
 *   it. A process that is not the owner still cancels its own sessions' reads and reports `owner: false`.
 * - Nothing here deletes a table, file, job, warehouse or result. There is no code that could.
 */
import type { Plugin } from "@opencode/plugin"
import { homedir } from "node:os"
import { join } from "node:path"
import { DISPLAY_NAME } from "../constants.js"
import { DatabricksError } from "../domain/errors.js"
import { sessionToken } from "../guards/path.js"
import type { Options } from "../options.js"
import type { AuthPort, Clock, DatabricksPort, HistoryQuery } from "../ports.js"
import { OwnerLock } from "./lock.js"

/** The tools whose statements are reads: the only ones automation may cancel (design §7 layer 2(c)). */
export const READ_TOOLS: ReadonlySet<string> = new Set(["status", "query", "profile", "explain", "table", "save", "saved_read", "path-check"])
const PLUGIN_TAG = "databricks"
/** How often the sweep runs while OpenCode runs. Free calls only: one Query History page per signed-in account. */
export const SWEEP_MS = 120_000
/** Query History is filtered by start time [24]; two hours is longer than any sweep needs to see an orphan. */
const WINDOW_MS = 2 * 60 * 60_000
const HISTORY_PAGE = 1000
/** How long a cancellation that was tried and failed stays queued, before it is reported and dropped. */
export const PENDING_MAX_MS = 10 * 60_000

export interface AutomationPorts {
  readonly options: Options
  readonly auth: AuthPort
  readonly databricks: DatabricksPort
  readonly clock: Clock
}

export type AutomationState = { readonly mode: Options["automation"]; readonly active: boolean; readonly owner: boolean }

export interface PendingSession {
  readonly sessionID: string
  readonly at: number
  readonly attempts: number
}

/** `$XDG_STATE_HOME/databricks/automation.lock`, beside the spend ledger. */
export function lockPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_STATE_HOME && env.XDG_STATE_HOME.startsWith("/") ? env.XDG_STATE_HOME : join(homedir(), ".local", "state")
  return join(base, "databricks", "automation.lock")
}

/** The consent for automation's changes (design §7): `auto` is on at `all` only; `on` is the person's standing yes. */
export function consentOf(options: Options): { mode: Options["automation"]; active: boolean } {
  return { mode: options.automation, active: options.automation === "on" || (options.automation === "auto" && options.access === "all") }
}

/** A statement this plugin started that is still running: from Query History, because the plugin keeps no registry. */
function runningPluginStatements(items: readonly HistoryQuery[]): HistoryQuery[] {
  return items.filter((item) => item.queryTags?.oc_plugin === PLUGIN_TAG && (item.status === "RUNNING" || item.status === "QUEUED"))
}

/** What one session's cancellation pass found: whether anything matched, and whether a cancel was tried and failed. */
export interface CancelOutcome {
  readonly found: boolean
  readonly failed: boolean
}

export class Automation {
  private readonly pending = new Map<string, PendingSession>()
  private readonly ports: AutomationPorts
  private readonly lock: OwnerLock
  private timer: ReturnType<typeof setInterval> | undefined
  private sweeping = false
  private current: AutomationState
  private readonly failed = new Set<string>()
  private problem: string | undefined

  constructor(ports: AutomationPorts, lock = lockPath()) {
    this.ports = ports
    this.lock = new OwnerLock(lock)
    this.current = { ...consentOf(ports.options), owner: false }
  }

  state(): AutomationState {
    return this.current
  }

  /** The last cancel that was tried and failed, for status's problems. A session with nothing running is not one. */
  lastProblem(): string | undefined {
    return this.problem
  }

  /** Takes the owner lock where possible and sweeps at once, then every `SWEEP_MS`. */
  start(): void {
    if (this.timer) return
    this.touch()
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.lock.release()
    this.current = { ...consentOf(this.ports.options), owner: false }
  }

  /** OpenCode reported a session deleted or archived (design §7 layer 2(a)). Queued for its own process's sweep. */
  sessionEnded(sessionID: string, now = this.ports.clock.now()): void {
    const existing = this.pending.get(sessionID)
    this.pending.set(sessionID, { sessionID, at: existing?.at ?? now, attempts: existing?.attempts ?? 0 })
    void this.sweep()
  }

  private touch(): void {
    const now = this.ports.clock.now()
    const owner = this.lock.refresh(now)
    this.current = { ...consentOf(this.ports.options), owner }
  }

  /** One sweep: cancel queued orphans in this process (no lock), and refresh the owner lock. */
  async sweep(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
      this.touch()
      const now = this.ports.clock.now()
      for (const [sessionID, item] of [...this.pending]) {
        try {
          const outcome = await this.cancelOrphans(sessionID, new AbortController().signal)
          if (outcome.failed) {
            this.failed.add(sessionID)
            this.problem = `${DISPLAY_NAME} could not cancel a read statement from a session that ended; it is left to the warehouse's statement timeout.`
            if (now - item.at > PENDING_MAX_MS) this.pending.delete(sessionID)
            else this.pending.set(sessionID, { ...item, attempts: item.attempts + 1 })
          } else {
            // Found and cancelled, or a complete window shows nothing running for it: either way there is no work left,
            // and a session that never used the plugin is not a problem (review of F, M2).
            this.pending.delete(sessionID)
            this.failed.delete(sessionID)
            if (this.failed.size === 0) this.problem = undefined
          }
        } catch (error) {
          this.pending.delete(sessionID)
          this.problem = `${DISPLAY_NAME} automation could not check a session that ended (${error instanceof Error ? error.message : "unknown error"}).`
        }
      }
    } finally {
      this.sweeping = false
    }
  }

  /**
   * Cancels the read statements this plugin started for `sessionID`, and only those: matched by the session's tag in
   * Query History, by a read tool in `oc_tool`, and — when `Me` answers a numeric id — to this identity's own
   * statements (review of F, M4). Answers what was found and whether a cancel was tried and failed; a complete window
   * with nothing found is `{ found: false, failed: false }`, not a problem.
   */
  async cancelOrphans(sessionID: string, signal: AbortSignal): Promise<CancelOutcome> {
    const hash = sessionToken(sessionID)
    let found = false
    let failed = false
    for (const account of this.ports.auth.accounts()) {
      let token
      try {
        token = await this.ports.auth.token(account.alias, ["query-history", "sql"], signal)
      } catch {
        continue
      }
      if (!token) continue
      const userIds = await this.userIds(account.alias, signal)
      let items: readonly HistoryQuery[] = []
      try {
        items = (await this.ports.databricks.history(account.alias, { startMs: this.ports.clock.now() - WINDOW_MS, maxResults: HISTORY_PAGE, ...(userIds ? { userIds } : {}) }, signal)).items
      } catch {
        continue
      }
      for (const item of runningPluginStatements(items)) {
        if (item.queryTags?.oc_session !== hash) continue
        if (!READ_TOOLS.has(item.queryTags?.oc_tool ?? "")) continue
        if (!isMineStatement(item, userIds)) continue
        found = true
        try {
          await this.ports.databricks.cancelStatement(account.alias, item.queryId, signal)
        } catch (error) {
          failed = true
          this.problem = `${DISPLAY_NAME} could not cancel a read statement from a session that ended (${error instanceof DatabricksError ? error.code : "UNAVAILABLE"}).`
        }
      }
    }
    return { found, failed }
  }

  /** The identity's numeric id for Query History's `user_ids`, when `Me` answers one; free. */
  private async userIds(account: string, signal: AbortSignal): Promise<readonly number[] | undefined> {
    try {
      const me = await this.ports.databricks.me(account, signal)
      const id = Number(me.id)
      return Number.isSafeInteger(id) && id > 0 ? [id] : undefined
    } catch {
      return undefined
    }
  }
}

/** Whether a history row is this identity's: the API's user filter is trusted when `user_ids` was sent. */
export function isMineStatement(item: HistoryQuery, userIds: readonly number[] | undefined): boolean {
  if (!userIds) return true
  if (item.userId !== undefined && !userIds.includes(item.userId)) return false
  if (item.userId === undefined && item.executedAsUserId !== undefined && !userIds.includes(item.executedAsUserId)) return false
  return true
}

/**
 * Wires the session events and the sweep. `session.deleted` and `session.archived` are the path; the periodic sweep
 * retries a cancel that failed.
 */
export async function registerAutomation(ctx: { readonly event: Pick<Plugin.Context["event"], "subscribe"> }, automation: Automation): Promise<{ dispose(): Promise<void> }> {
  const controller = new AbortController()
  automation.start()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ types: ["session.deleted", "session.archived"], signal: controller.signal })) {
        const sessionID = (event as { data?: { sessionID?: unknown } }).data?.sessionID
        if (typeof sessionID === "string" && sessionID.length > 0) automation.sessionEnded(sessionID)
      }
    } catch {
      // The subscription ends when the plugin is disposed; nothing to report.
    }
  })()
  return {
    async dispose() {
      controller.abort()
      automation.stop()
    },
  }
}

export { LOCK_STALE_MS } from "./lock.js"
