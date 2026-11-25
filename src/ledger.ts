/**
 * The spend ledger (design §6.2): a local, append-only JSONL file of estimated DBU-hours, shared by every OpenCode
 * process of this user, behind `LedgerPort`. Each start the plugin caused is charged `auto_stop × DBU/h`; each statement
 * as `statementDbuHours` (src/domain/cost.ts). Days are local-midnight days. Budgets are opt-in (OD-29): with none
 * configured the ledger still records, so status can show today's estimate.
 *
 * - Atomic appends: each entry is one line, written with O_APPEND in a single write.
 * - A cross-process lock (an exclusive lock file, broken after `staleMs`) makes "check the budget, then charge" one
 *   step, so two processes cannot both pass a budget with one start left.
 * - Lines that do not parse are skipped, never fatal: a torn line from a crash costs one entry, not the ledger.
 */
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Budget, Charge, LedgerPort, SpendTotals } from "./ports.js"

export interface LedgerOptions {
  readonly path?: string
  readonly now?: () => Date
  readonly staleMs?: number
  /** The session the totals call "this session". */
  readonly sessionId?: string
}

/** `$XDG_STATE_HOME/databricks/spend.jsonl`, or `~/.local/state/…` without it. */
export function defaultLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_STATE_HOME && env.XDG_STATE_HOME.startsWith("/") ? env.XDG_STATE_HOME : join(homedir(), ".local", "state")
  return join(base, "databricks", "spend.jsonl")
}

/** The local calendar day of a time, `YYYY-MM-DD`. */
export function localDay(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The `start` lines of one account at or after `sinceMs`, oldest first (`LedgerPort.starts`). */
export function startsOf(entries: readonly Charge[], account: string, sinceMs: number): { warehouseId: string; atMs: number; sessionId: string }[] {
  return entries
    .filter((entry) => entry.kind === "start" && entry.account === account)
    .map((entry) => ({ warehouseId: entry.warehouseId, atMs: Date.parse(entry.at), sessionId: entry.sessionId ?? "" }))
    .filter((start) => Number.isFinite(start.atMs) && start.atMs >= sinceMs)
    .sort((a, b) => a.atMs - b.atMs)
}

export function createLedger(options: LedgerOptions = {}): LedgerPort {
  const path = options.path ?? defaultLedgerPath()
  const now = options.now ?? (() => new Date())
  const staleMs = options.staleMs ?? 10_000
  const lockPath = `${path}.lock`

  async function locked<T>(work: () => T): Promise<T> {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    for (let attempt = 0; ; attempt++) {
      try {
        closeSync(openSync(lockPath, "wx", 0o600))
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > staleMs) unlinkSync(lockPath)
        } catch {
          // Another process removed it first.
        }
        if (attempt > 400) throw new Error("the spend ledger stayed locked")
        await sleep(5 + Math.random() * 20)
      }
    }
    try {
      return work()
    } finally {
      try {
        unlinkSync(lockPath)
      } catch {
        // Broken as stale by another process; nothing to release.
      }
    }
  }

  function entries(): Charge[] {
    let text: string
    try {
      text = readFileSync(path, "utf8")
    } catch {
      return []
    }
    const out: Charge[] = []
    for (const line of text.split("\n")) {
      if (!line) continue
      try {
        const value = JSON.parse(line) as Charge
        if (typeof value.dbuHours === "number" && typeof value.at === "string") out.push(value)
      } catch {
        // A torn line.
      }
    }
    return out
  }

  function totals(account: string, sessionId?: string): SpendTotals {
    const today = localDay(now())
    let startsToday = 0
    let dbuHoursToday = 0
    let startsSession = 0
    let dbuHoursSession = 0
    for (const entry of entries()) {
      if (entry.account !== account) continue
      const isToday = localDay(new Date(entry.at)) === today
      const isSession = sessionId !== undefined && entry.sessionId === sessionId
      if (isToday) {
        dbuHoursToday += entry.dbuHours
        if (entry.kind === "start") startsToday++
      }
      if (isSession) {
        dbuHoursSession += entry.dbuHours
        if (entry.kind === "start") startsSession++
      }
    }
    return { startsToday, dbuHoursToday, startsSession, dbuHoursSession, estimate: true }
  }

  function over(budget: Budget | undefined, current: SpendTotals, charge: Omit<Charge, "at">): string | undefined {
    if (!budget) return undefined
    const day = budget.daily
    const session = budget.session
    const starts = charge.kind === "start" ? 1 : 0
    if (day?.starts !== undefined && current.startsToday + starts > day.starts) return "daily starts"
    if (day?.dbuHours !== undefined && current.dbuHoursToday + charge.dbuHours > day.dbuHours) return "daily DBU-hours"
    if (session?.starts !== undefined && current.startsSession + starts > session.starts) return "session starts"
    if (session?.dbuHours !== undefined && current.dbuHoursSession + charge.dbuHours > session.dbuHours) return "session DBU-hours"
    return undefined
  }

  return {
    totals: async (account, sessionId) => totals(account, sessionId ?? options.sessionId),
    starts: async (account, sinceMs) => startsOf(entries(), account, sinceMs),
    async charge(charge, budget) {
      return locked(() => {
        const current = totals(charge.account, charge.sessionId)
        const exceeded = over(budget, current, charge)
        if (exceeded && budget?.action === "refuse") return { recorded: false, exceeded, totals: current }
        const entry: Charge = { ...charge, at: now().toISOString() }
        const fd = openSync(path, "a", 0o600)
        try {
          writeSync(fd, `${JSON.stringify(entry)}\n`)
        } finally {
          closeSync(fd)
        }
        return { recorded: true, ...(exceeded ? { exceeded } : {}), totals: totals(charge.account, charge.sessionId) }
      })
    },
  }
}
