/**
 * Shared support for package F's tests: a start line in the spend ledger, the record the context hook and the cleanup
 * suggestions are scoped to (review of F, contract request 4).
 *
 * The Day 0 `MemoryLedger` stamps a charge with its own clock, which in these tests would be epoch 0; the helper writes
 * the same line `createLedger` writes, at the test's own time, so `starts(account, sinceMs)` reads it back.
 */
import type { MemoryLedger } from "../../fake/ports.js"

/** Records one warehouse start this plugin caused, at `atMs`, for `account`. */
export function recordStart(ledger: MemoryLedger, account: string, warehouseId: string, atMs: number, sessionId = "ses_test"): void {
  ledger.charges.push({ at: new Date(atMs).toISOString(), account, warehouseId, kind: "start", dbuHours: 0, sessionId })
}
