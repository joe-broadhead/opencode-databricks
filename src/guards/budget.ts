/**
 * The budget ledger's use on the read path (design §6.2, Q4/OD-29): opt-in, DBU-hour estimates, never a bill.
 *
 * - **A start** is charged before Databricks is asked, as `auto_stop × DBU/h × clusters` (`startDbuHours`), through
 *   `LedgerPort.charge` with the account's budget: the ledger's cross-process lock makes "check the budget, then charge"
 *   one step, so two OpenCode processes cannot both pass a budget with one start left. A `refuse` budget that the charge
 *   would exceed answers `BUDGET_REACHED` and nothing is started.
 * - **A statement** is charged after it finishes, as
 *   `max(duration, min(auto_stop, time since this plugin's previous statement on that warehouse)) × DBU/h × clusters`
 *   (`statementDbuHours`), because a statement on an otherwise idle warehouse keeps it up for one more auto-stop period.
 *   The "previous statement" time is this process's memory, so the estimate is slightly low across processes: the ledger
 *   is an estimate (review M5), and `databricks_status({ include: ["spend"] })` reconciles it with
 *   `system.billing.usage` (design §6.2) [25].
 * - **Before a statement**, with `action: "refuse"`, a limit the ledger already reports as spent answers
 *   `BUDGET_REACHED`. A statement's own charge never discards a result the person has already paid for: it records what
 *   it can and reports the excess, which status shows.
 * - `action: "warn"` records the charge and continues. This version has no warning code for a budget, so the overflow
 *   is visible only through status's totals: see the PR's contract requests.
 */
import { statementDbuHours, type Size } from "../domain/cost.js"
import { DatabricksError } from "../domain/errors.js"
import type { Options } from "../options.js"
import type { Budget, Clock, LedgerPort, SpendTotals } from "../ports.js"

/** The budget the person set, if any (design §13: `budget` is the plugin's top-level option, not per account). */
export function budgetOf(options: Options): Budget | undefined {
  return options.budget
}

const gigabytes = (value: number) => (Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : "0")

interface Spent {
  /** `daily starts`, `session DBU-hours`, … */
  readonly name: string
  readonly limit: number
  readonly unit: string
}

/** The first limit `totals` has already reached, in the order the ledger checks them. */
export function reachedLimit(budget: Budget, totals: SpendTotals): Spent | undefined {
  const day = budget.daily
  const session = budget.session
  if (day?.starts !== undefined && totals.startsToday >= day.starts) return { name: "daily starts", limit: day.starts, unit: "starts" }
  if (day?.dbuHours !== undefined && totals.dbuHoursToday >= day.dbuHours) return { name: "daily DBU-hours", limit: day.dbuHours, unit: "DBU-hours" }
  if (session?.starts !== undefined && totals.startsSession >= session.starts) return { name: "session starts", limit: session.starts, unit: "starts" }
  if (session?.dbuHours !== undefined && totals.dbuHoursSession >= session.dbuHours) return { name: "session DBU-hours", limit: session.dbuHours, unit: "DBU-hours" }
  return undefined
}

const budgetError = (spent: Spent, totals: SpendTotals): DatabricksError =>
  new DatabricksError(
    "BUDGET_REACHED",
    `The ${spent.name} budget is spent: today ${gigabytes(totals.dbuHoursToday)} DBU-hours in ${totals.startsToday} starts, this session ${gigabytes(totals.dbuHoursSession)} in ${totals.startsSession}; the limit is ${spent.limit} ${spent.unit}.`,
    "Wait for the reset (local midnight for the daily budget), or raise the budget option.",
  )

/** Refuses when a `refuse` budget is already spent. Called before a statement, and after a warehouse check. */
export async function assertBudgetRoom(ledger: LedgerPort, options: Options, account: string, sessionId?: string): Promise<SpendTotals> {
  const totals = await ledger.totals(account, sessionId)
  const budget = budgetOf(options)
  if (budget?.action !== "refuse") return totals
  const spent = reachedLimit(budget, totals)
  if (spent) throw budgetError(spent, totals)
  return totals
}

export interface StartCharge {
  readonly account: string
  readonly sessionId?: string
  readonly warehouseId: string
  readonly dbuHours: number
}

/** Charges a start before it happens; a `refuse` budget that this start would exceed throws and nothing is started. */
export async function chargeStart(ledger: LedgerPort, options: Options, charge: StartCharge): Promise<void> {
  const result = await ledger.charge({ account: charge.account, ...(charge.sessionId ? { sessionId: charge.sessionId } : {}), warehouseId: charge.warehouseId, kind: "start", dbuHours: charge.dbuHours }, budgetOf(options))
  if (result.recorded) return
  const limit = result.exceeded ?? "the budget"
  throw new DatabricksError(
    "BUDGET_REACHED",
    `The ${limit} budget would be exceeded by starting this warehouse: today ${gigabytes(result.totals.dbuHoursToday)} DBU-hours in ${result.totals.startsToday} starts, this session ${gigabytes(result.totals.dbuHoursSession)} in ${result.totals.startsSession}.`,
    "Wait for the reset (local midnight for the daily budget), raise the budget option, or use a warehouse that is already running.",
  )
}

/**
 * This process's last statement on each `<account>|<warehouse>`, for the idle cover of `statementDbuHours`. Module-wide,
 * because the estimate is about the account's warehouses, not one call; `deps.clock` keeps it testable.
 */
const lastStatementAt = new Map<string, number>()

/** Test seam: forget what this process ran. */
export function forgetStatementTimes(): void {
  lastStatementAt.clear()
}

export interface StatementCharge {
  readonly account: string
  readonly sessionId?: string
  readonly warehouseId: string
  readonly statementId?: string
  readonly size: Size
  readonly autoStopMinutes: number
  readonly clusters?: number
  readonly durationMs: number
}

/** Records one finished statement's estimated DBU-hours. Never throws: the result is already paid for. */
export async function chargeStatement(ledger: LedgerPort, clock: Clock, options: Options, charge: StatementCharge): Promise<{ readonly recorded: boolean; readonly exceeded?: string }> {
  const key = `${charge.account}|${charge.warehouseId}`
  const now = clock.now()
  const previous = lastStatementAt.get(key)
  lastStatementAt.set(key, now)
  const dbuHours = statementDbuHours({
    size: charge.size,
    durationMs: charge.durationMs,
    autoStopMinutes: charge.autoStopMinutes,
    ...(previous === undefined ? {} : { sincePreviousMs: now - previous }),
    ...(charge.clusters === undefined ? {} : { clusters: charge.clusters }),
  })
  const result = await ledger.charge(
    {
      account: charge.account,
      ...(charge.sessionId ? { sessionId: charge.sessionId } : {}),
      warehouseId: charge.warehouseId,
      kind: "statement",
      dbuHours,
      ...(charge.statementId ? { statementId: charge.statementId } : {}),
    },
    budgetOf(options),
  )
  return { recorded: result.recorded, ...(result.exceeded ? { exceeded: result.exceeded } : {}) }
}
