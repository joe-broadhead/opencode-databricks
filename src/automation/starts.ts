/**
 * The plugin's own start record, read from the spend ledger (review of F, M5; contract request 4).
 *
 * The ledger already writes one line per warehouse start this plugin caused, with its warehouse, time and session.
 * `LedgerPort.starts(account, sinceMs)` exposes those lines; this module reads them through an optional accessor until
 * the Day 0 amendment lands, and answers an empty list when the port cannot provide it. An empty list means the plugin
 * can prove nothing, so the context hook says nothing and `/databricks-cleanup` offers no stop: never the reverse.
 *
 * A warehouse counts as this plugin's when this plugin started it in `START_RECORD_WINDOW_MS`. A start older than that
 * is not evidence (the warehouse may have been stopped and started by someone else since), and automatic stops are out
 * of v0.1.0 in any case: this record scopes what the hook and the command may name, nothing else.
 */
import type { LedgerPort } from "../ports.js"

/** A start the ledger recorded: the warehouse, when, and the session whose call caused it. */
export interface StartRecord {
  readonly warehouseId: string
  readonly atMs: number
  readonly sessionId: string
}

/** How far back a start still counts as evidence that the plugin started the running warehouse. */
export const START_RECORD_WINDOW_MS = 24 * 60 * 60_000

type LedgerWithStarts = LedgerPort & {
  readonly starts?: (account: string, sinceMs: number) => Promise<readonly StartRecord[]>
}

/** The plugin's recorded starts for one account since `sinceMs`, or an empty list when there is no record. */
export async function startsSince(ledger: LedgerPort, account: string, sinceMs: number): Promise<readonly StartRecord[]> {
  const starts = (ledger as LedgerWithStarts).starts
  if (typeof starts !== "function") return []
  try {
    const records = await starts.call(ledger, account, sinceMs)
    return Array.isArray(records) ? records.filter((record) => typeof record?.warehouseId === "string" && Number.isFinite(record?.atMs)) : []
  } catch {
    return []
  }
}

/** The warehouse ids this plugin started in the window, for the hook and the cleanup suggestions. */
export async function startedWarehouses(ledger: LedgerPort, account: string, now: number): Promise<ReadonlySet<string>> {
  return new Set((await startsSince(ledger, account, now - START_RECORD_WINDOW_MS)).map((record) => record.warehouseId))
}
