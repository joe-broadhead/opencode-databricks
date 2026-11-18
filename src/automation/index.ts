/**
 * The plugin's own automation (design §7, layer 2), by consent and never deleting anything:
 *
 * - **Its own orphaned reads.** When OpenCode reports a session `deleted` or `archived`, the read statements this plugin
 *   started for it — tagged `oc_plugin=databricks`, `oc_session=<hash>`, with a read tool in `oc_tool` — are cancelled.
 *   A read has no effects, so this runs at **every** access level, like Stop. A change statement and a job run are never
 *   cancelled here: their effects can be partial. A failed cancel stays queued and is retried on the next sweep, so a
 *   statement that Query History had not recorded yet is still reached; after `PENDING_MAX_MS` it is reported and
 *   dropped, and the database's `STATEMENT_TIMEOUT` is the backstop.
 * - **Idle warehouses, reported and never stopped automatically in v0.1.0.** The sweep keeps a cached list of running
 *   warehouses that no visible statement has used for `autoStopIdleMinutes`; the context hook and status read it. A stop
 *   needs proof that *this plugin* started the warehouse, and this version keeps no such record (see the PR's contract
 *   requests), so automation stops nothing: `/databricks-cleanup` and `databricks_stop` are the person's.
 * - **One owner per machine.** A lock file in the plugin's state folder, with a heartbeat, so several OpenCode processes
 *   do not sweep twice. A process that cannot take the lock reports `not-owner` in its own status and sweeps nothing.
 * - Nothing here deletes a table, file, job, warehouse or result. There is no code that could.
 */
import type { Plugin } from "@opencode/plugin"
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { type Access, DISPLAY_NAME } from "../constants.js"
import { DatabricksError } from "../domain/errors.js"
import { safeText } from "../guards/pattern.js"
import { sessionToken } from "../guards/path.js"
import { kindOf, usdPerHour } from "../guards/warehouse.js"
import type { Options } from "../options.js"
import type { AuthPort, Clock, DatabricksPort, HistoryQuery, Warehouse } from "../ports.js"

/** The tools whose statements are reads: the only ones automation may cancel (design §7 layer 2(c)). */
export const READ_TOOLS: ReadonlySet<string> = new Set(["status", "query", "profile", "explain", "table", "save", "saved_read", "path-check"])
const PLUGIN_TAG = "databricks"
/** How often the sweep runs while OpenCode runs. Free calls only: a warehouse list and one Query History page per account. */
export const SWEEP_MS = 120_000
/** Query History is filtered by start time [24]; two hours is longer than any sweep needs to see an orphan. */
const WINDOW_MS = 2 * 60 * 60_000
const HISTORY_PAGE = 1000
/** How long a cancellation that failed stays queued, before it is reported and dropped. */
export const PENDING_MAX_MS = 10 * 60_000
/** The idle snapshot the context hook reads is stale after this; an older one is no line at all. */
export const SNAPSHOT_TTL_MS = 5 * 60_000
/** A lock older than this belongs to a dead process: longer than two sweeps, so the owner refreshes it in time. */
export const LOCK_STALE_MS = 5 * 60_000

export interface AutomationPorts {
  readonly options: Options
  readonly access: Access
  readonly auth: AuthPort
  readonly databricks: DatabricksPort
  readonly clock: Clock
}

export type IdleWarehouse = {
  readonly account: string
  readonly warehouse: Warehouse
  /** Minutes since the last statement on it that this identity can see, when it has seen one. */
  readonly idleMinutes?: number
  readonly usdPerHour: number
}

export type AutomationState = { readonly mode: Options["automation"]; readonly active: boolean; readonly owner: boolean }

export interface PendingCancel {
  readonly sessionID: string
  readonly at: number
  readonly attempts: number
  /** The account whose Query History matched it, once a sweep has found the statement. */
  readonly account?: string
  readonly statementId?: string
}

/** `$XDG_STATE_HOME/opencode-databricks/automation.lock`, beside the spend ledger. */
export function lockPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_STATE_HOME && env.XDG_STATE_HOME.startsWith("/") ? env.XDG_STATE_HOME : join(homedir(), ".local", "state")
  return join(base, "opencode-databricks", "automation.lock")
}

/** The consent for automation's changes (design §7): `auto` is on at `all` only; `on` is the person's standing yes. */
export function consentOf(options: Options): { mode: Options["automation"]; active: boolean } {
  return { mode: options.automation, active: options.automation === "on" || (options.automation === "auto" && options.access === "all") }
}

/** A statement this plugin started that is still running: from Query History, because the plugin keeps no registry. */
function runningPluginStatements(items: readonly HistoryQuery[]): HistoryQuery[] {
  return items.filter((item) => item.queryTags?.oc_plugin === PLUGIN_TAG && (item.status === "RUNNING" || item.status === "QUEUED"))
}

function idleOf(items: readonly HistoryQuery[], warehouseId: string, now: number): number | undefined {
  const ends = items.filter((item) => item.warehouseId === warehouseId).map((item) => item.queryEndTimeMs ?? item.queryStartTimeMs)
  if (ends.length === 0) return undefined
  const latest = Math.max(...ends)
  return Math.max(0, Math.round((now - latest) / 60_000))
}

export class Automation {
  private readonly pending = new Map<string, PendingCancel>()
  private readonly ports: AutomationPorts
  private timer: ReturnType<typeof setInterval> | undefined
  private sweeping = false
  private snapshot: { readonly at: number; readonly items: readonly IdleWarehouse[] } = { at: 0, items: [] }
  private current: AutomationState
  private problem: string | undefined
  private owner = false

  constructor(ports: AutomationPorts, private readonly lock = lockPath()) {
    this.ports = ports
    this.current = { ...consentOf(ports.options), owner: false }
  }

  state(): AutomationState {
    return this.current
  }

  /** The last thing automation could not do, for status's problems. */
  lastProblem(): string | undefined {
    return this.problem
  }

  /** The idle warehouses the context hook may mention. Empty when the snapshot is stale. */
  burning(now = this.ports.clock.now()): readonly IdleWarehouse[] {
    return now - this.snapshot.at <= SNAPSHOT_TTL_MS ? this.snapshot.items : []
  }

  /** Queues the session's orphaned reads and sweeps at once, then every `SWEEP_MS`. */
  start(): void {
    if (this.timer) return
    this.touchLock()
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.owner) {
      try {
        rmSync(this.lock, { force: true })
      } catch {
        // Another process broke it as stale.
      }
      this.owner = false
    }
  }

  /** OpenCode reported a session deleted or archived (design §7 layer 2(a)). */
  sessionEnded(sessionID: string, now = this.ports.clock.now()): void {
    const existing = this.pending.get(sessionID)
    this.pending.set(sessionID, { sessionID, at: existing?.at ?? now, attempts: existing?.attempts ?? 0, ...(existing?.account ? { account: existing.account } : {}), ...(existing?.statementId ? { statementId: existing.statementId } : {}) })
    void this.sweep()
  }

  private ownerOf(now: number): boolean {
    try {
      mkdirSync(dirname(this.lock), { recursive: true, mode: 0o700 })
      const text = readFileSync(this.lock, "utf8")
      const at = Number(text.trim())
      if (Number.isFinite(at) && now - at < LOCK_STALE_MS) return false
      // Stale: take it.
    } catch {
      // No lock, or unreadable: take it below.
    }
    try {
      writeFileSync(this.lock, String(now), { mode: 0o600 })
      return true
    } catch {
      return false
    }
  }

  private touchLock(): void {
    const now = this.ports.clock.now()
    this.owner = this.ownerOf(now)
    this.current = { ...consentOf(this.ports.options), owner: this.owner }
  }

  /** One sweep: cancel queued orphans, then refresh the idle snapshot. Free calls only, and never a change. */
  async sweep(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
      this.touchLock()
      if (!this.owner) return
      const now = this.ports.clock.now()
      for (const [sessionID, item] of [...this.pending]) {
        if (now - item.at > PENDING_MAX_MS) {
          this.pending.delete(sessionID)
          this.problem = `${DISPLAY_NAME} could not cancel a read statement from a session that ended; it is left to the warehouse's statement timeout.`
          continue
        }
        try {
          const cancelled = await this.cancelOrphans(sessionID, new AbortController().signal)
          if (cancelled) this.pending.delete(sessionID)
        } catch (error) {
          this.pending.set(sessionID, { ...item, attempts: item.attempts + 1 })
          if (!(error instanceof DatabricksError)) this.problem = `${DISPLAY_NAME} automation could not cancel an orphaned read (${error instanceof Error ? error.message : "unknown error"}).`
        }
      }
      await this.refreshIdle(new AbortController().signal)
    } finally {
      this.sweeping = false
    }
  }

  /**
   * Cancels the read statements this plugin started for `sessionID`, and only those: matched by the session's tag in
   * Query History, and by a read tool in `oc_tool`. Answers whether at least one statement was found (so a queued
   * cancellation that finds nothing yet stays queued).
   */
  async cancelOrphans(sessionID: string, signal: AbortSignal): Promise<boolean> {
    const hash = sessionToken(sessionID)
    let found = false
    let cancelled = true
    for (const account of this.ports.auth.accounts()) {
      let token
      try {
        token = await this.ports.auth.token(account.alias, ["query-history", "sql"], signal)
      } catch {
        continue
      }
      if (!token) continue
      let items: readonly HistoryQuery[] = []
      try {
        items = (await this.ports.databricks.history(account.alias, { startMs: this.ports.clock.now() - WINDOW_MS, maxResults: HISTORY_PAGE }, signal)).items
      } catch {
        continue
      }
      for (const item of runningPluginStatements(items)) {
        if (item.queryTags?.oc_session !== hash) continue
        if (!READ_TOOLS.has(item.queryTags?.oc_tool ?? "")) continue
        found = true
        try {
          await this.ports.databricks.cancelStatement(account.alias, item.queryId, signal)
          this.problem = undefined
        } catch (error) {
          cancelled = false
          this.problem = `${DISPLAY_NAME} could not cancel a read statement from a session that ended (${error instanceof DatabricksError ? error.code : "UNAVAILABLE"}).`
        }
      }
    }
    return found && cancelled
  }

  /** The idle running warehouses, from free calls: the warehouse list and one Query History page per account. */
  async refreshIdle(signal: AbortSignal): Promise<readonly IdleWarehouse[]> {
    const now = this.ports.clock.now()
    const items: IdleWarehouse[] = []
    for (const account of this.ports.auth.accounts()) {
      let token
      try {
        token = await this.ports.auth.token(account.alias, ["sql", "query-history"], signal)
      } catch {
        continue
      }
      if (!token) continue
      let warehouses: readonly Warehouse[] = []
      let history: readonly HistoryQuery[] = []
      try {
        warehouses = await this.ports.databricks.listWarehouses(account.alias, signal)
        history = (await this.ports.databricks.history(account.alias, { startMs: now - 6 * 60 * 60_000, maxResults: HISTORY_PAGE }, signal)).items
      } catch {
        continue
      }
      for (const warehouse of warehouses) {
        if (warehouse.state !== "RUNNING") continue
        const idleMinutes = idleOf(history, warehouse.id, now)
        // Only a warehouse that has been idle for the configured time is worth a line; a busy one is not.
        if (idleMinutes === undefined || idleMinutes < this.ports.options.autoStopIdleMinutes) continue
        items.push({ account: account.alias, warehouse, idleMinutes, usdPerHour: usdPerHour(warehouse, this.ports.options) })
      }
    }
    items.sort((a, b) => b.usdPerHour - a.usdPerHour)
    this.snapshot = { at: now, items }
    return items
  }
}

/** The one-line context hook (design §7 layer 3), at most 200 characters, plugin-built words only. */
export function burningLine(items: readonly IdleWarehouse[], limit = 200): string | undefined {
  const first = items[0]
  if (!first) return undefined
  const name = safeText(first.warehouse.name || first.warehouse.id, 40)
  const idle = first.idleMinutes === undefined ? "idle" : `idle ${first.idleMinutes} min`
  const more = items.length > 1 ? ` and ${items.length - 1} more` : ""
  const line = `${DISPLAY_NAME.toLowerCase()}: warehouse "${name}" is running at ~$${first.usdPerHour.toFixed(2)}/h, ${idle}${more}; nothing here is using it. databricks_stop({ account: ${JSON.stringify(first.account)}, warehouse: ${JSON.stringify(safeText(first.warehouse.id, 64))} }) or say why not.`
  if (line.length <= limit) return line
  const short = `${DISPLAY_NAME.toLowerCase()}: warehouse "${name}" is running at ~$${first.usdPerHour.toFixed(2)}/h, ${idle}${more}. databricks_stop({ warehouse: ${JSON.stringify(safeText(first.warehouse.id, 24))} }) or say why not.`
  return short.length <= limit ? short : `${short.slice(0, limit - 1)}…`
}

/**
 * Wires the session events and the sweep. `session.deleted` and `session.archived` are the fast path; each queued
 * cancellation is retried by the sweep, so a statement Query History had not recorded yet is still found.
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

