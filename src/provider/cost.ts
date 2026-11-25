/**
 * Cost facts and the spend formulas (design §6). Estimates only, labelled as such; the account's own
 * `system.billing.list_prices` and `system.billing.usage` are the authority.
 */

/** SQL Serverless DBU per hour by size (design §6.1 [21]). Pro and classic use the same table, marked an estimate. */
export const DBU_PER_HOUR = {
  "2X-Small": 4,
  "X-Small": 6,
  Small: 12,
  Medium: 24,
  Large: 40,
  "X-Large": 80,
  "2X-Large": 144,
  "3X-Large": 272,
  "4X-Large": 528,
} as const

export type Size = keyof typeof DBU_PER_HOUR
export const SIZES = Object.keys(DBU_PER_HOUR) as Size[]

/** List prices per DBU (AWS US), the `usdPerDbu` option's default. */
export const USD_PER_DBU = { serverless: 0.7, pro: 0.55, classic: 0.22 } as const

export const sizeRank = (size: string) => SIZES.indexOf(size as Size)

/** What a start costs at least: the warehouse runs until it auto-stops (design §6.1's example). */
export function startDbuHours(input: { size: Size; autoStopMinutes: number; clusters?: number }): number {
  return (DBU_PER_HOUR[input.size] * Math.max(1, input.clusters ?? 1) * input.autoStopMinutes) / 60
}

/**
 * The ledger's charge for one statement (design §6.2, review M5): `max(duration, min(auto_stop, time since this
 * plugin's previous statement on that warehouse)) × DBU/h × clusters`, because a statement on an otherwise idle
 * warehouse keeps it up for one more auto-stop period. An upper-bound estimate, not a bill.
 */
export function statementDbuHours(input: { size: Size; durationMs: number; autoStopMinutes: number; sincePreviousMs?: number; clusters?: number }): number {
  const autoStopMs = input.autoStopMinutes * 60_000
  const idleCovered = Math.min(autoStopMs, input.sincePreviousMs ?? autoStopMs)
  const billedMs = Math.max(input.durationMs, idleCovered)
  return (DBU_PER_HOUR[input.size] * Math.max(1, input.clusters ?? 1) * billedMs) / 3_600_000
}
