/**
 * Shared support for package F's tests: the start record the ledger will expose (review of F, contract request 4), and
 * a helper to attach it to the Day 0 `MemoryLedger` until the amendment lands.
 */
import type { LedgerPort } from "../../../src/ports.js"
import type { StartRecord } from "../../../src/automation/starts.js"

/** One start record, as `LedgerPort.starts` answers it. */
export const startOf = (warehouseId: string, atMs: number, sessionId = "ses_test"): StartRecord => ({ warehouseId, atMs, sessionId })

/** Attaches a fake `starts` to a ledger. The amendment adds the method to the port; this fills the gap. */
export function withStarts(ledger: LedgerPort, records: readonly StartRecord[]): LedgerPort {
  Object.defineProperty(ledger, "starts", {
    configurable: true,
    value: async (account: string, sinceMs: number) => records.filter((record) => record.atMs >= sinceMs),
  })
  return ledger
}
