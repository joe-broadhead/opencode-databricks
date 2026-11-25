/**
 * The warehouse policy (design §6.2, D4): no call silently starts a stopped warehouse.
 *
 * - Every statement checks the warehouse first (`warehouses.get`, free): a `RUNNING` one is used as it is; a `STARTING`
 *   one is waited for, within the call's wait, before the statement is submitted, so start-up does not eat the server's
 *   `wait_timeout`; anything else is `WAREHOUSE_STOPPED` until the call passes `start: true`.
 * - A start needs **all** of: `start: true`, a serverless warehouse, a size at most `maxStartSize` (default `Small`),
 *   and an auto-stop of 1 to `maxStartAutoStopMinutes` minutes (default 15). Otherwise `START_REFUSED`, with the
 *   warehouse's $/hour and what starting it would cost at least.
 * - A start is its own action (`databricks.start`, design §10.2) and its own ledger charge, before Databricks is asked.
 * - `maxRunSize` (off by default) refuses a warehouse above it for an agent's statements even while it runs.
 * - A source read (`runningOnly`, design §11.3) never starts one: it answers `UNAVAILABLE` when the warehouse is not
 *   already `RUNNING`.
 *
 * **TOCTOU** (design §6.2): a warehouse that stops between this check and the submit is restarted by Databricks, which
 * documents that "running a query against a stopped warehouse starts it automatically" [18]. The window is one round
 * trip, and status counts such a start as ours. The check cannot close it.
 *
 * Cost facts: DBU per hour by size and the list prices are `src/domain/cost.ts` (design §6.1) [21]; the warehouse
 * object's `warehouse_type`, `enable_serverless_compute`, `cluster_size`, `auto_stop_mins` and `num_clusters` are the
 * Warehouses API's [15]. Every figure here is an estimate, and the result says so (`ESTIMATE_ONLY`).
 */
import { DBU_PER_HOUR, sizeRank, type Size } from "../cost.js"
import type { Options } from "../../options.js"
import type { Warehouse, WarehouseState } from "../../ports.js"
import { quoted, safeText } from "./pattern.js"
import type { Refusal } from "./refusal.js"

export type WarehouseKind = "serverless" | "pro" | "classic"

/** The warehouse types the cost table names (design §6.1): serverless, pro and classic. */
export function kindOf(warehouse: Warehouse): WarehouseKind {
  if (warehouse.serverless) return "serverless"
  return warehouse.warehouseType === "PRO" ? "pro" : "classic"
}

/** The size, when it is one the DBU table knows. An unknown size makes a warehouse unstartable and unpriced. */
export function sizeOf(warehouse: Warehouse): Size | undefined {
  return Object.hasOwn(DBU_PER_HOUR, warehouse.clusterSize) ? (warehouse.clusterSize as Size) : undefined
}

/** DBU per hour while it runs; 0 when the size is not one the table knows (the result then says ESTIMATE_ONLY). */
export function dbuPerHour(warehouse: Warehouse): number {
  const size = sizeOf(warehouse)
  return size ? DBU_PER_HOUR[size] : 0
}

/** The estimated list price per hour, from the `usdPerDbu` option (design §6.1, §13). */
export function usdPerHour(warehouse: Warehouse, options: Options): number {
  return dbuPerHour(warehouse) * options.usdPerDbu[kindOf(warehouse)]
}

/** What starting it costs at least: it runs until its auto-stop, at its size and `num_clusters` (design §6.1). */
export function minStartUsd(warehouse: Warehouse, options: Options): number | undefined {
  const size = sizeOf(warehouse)
  if (!size) return undefined
  const clusters = Math.max(1, warehouse.numClusters ?? warehouse.minNumClusters ?? 1)
  return (DBU_PER_HOUR[size] * clusters * Math.max(1, warehouse.autoStopMins) / 60) * options.usdPerDbu[kindOf(warehouse)]
}

/** A one-line description for the plugin's own words: `a Small serverless warehouse "bi" at ~$8.40/hour`. */
export function describe(warehouse: Warehouse, options: Options): string {
  const price = usdPerHour(warehouse, options)
  return `a ${safeText(warehouse.clusterSize, 24)} ${kindOf(warehouse)} warehouse ${quoted(warehouse.name)}${price > 0 ? ` at about $${price.toFixed(2)}/hour` : ""}`
}

export interface StartVerdict {
  readonly allowed: boolean
  /** Why not, in the plugin's words, one per failed condition. */
  readonly reasons: readonly string[]
}

/** The start policy, for `databricks_warehouses` and for the refusal. No call, no side effect. */
export function startVerdict(warehouse: Warehouse, options: Options): StartVerdict {
  const reasons: string[] = []
  if (!warehouse.serverless) reasons.push("only a serverless warehouse may be started")
  const size = sizeOf(warehouse)
  if (!size) reasons.push("its size is not one this version's DBU table knows")
  else if (sizeRank(size) > sizeRank(options.maxStartSize)) reasons.push(`it is ${warehouse.clusterSize}, above maxStartSize ${options.maxStartSize}`)
  if (warehouse.autoStopMins < 1) reasons.push("it never auto-stops")
  else if (warehouse.autoStopMins > options.maxStartAutoStopMinutes) reasons.push(`its auto-stop is ${warehouse.autoStopMins} minutes, above maxStartAutoStopMinutes ${options.maxStartAutoStopMinutes}`)
  return { allowed: reasons.length === 0, reasons }
}

/** The `START_REFUSED` refusal, naming every failed condition and what a start would cost. */
export function startRefusal(warehouse: Warehouse, options: Options, verdict: StartVerdict): Refusal {
  const least = minStartUsd(warehouse, options)
  return {
    code: "START_REFUSED",
    detail: `The start policy refuses ${describe(warehouse, options)}: ${verdict.reasons.join("; ")}.${least === undefined ? "" : ` Starting it would cost at least about $${least.toFixed(2)}, billing until it auto-stops.`}`,
    next: "Use a running warehouse, or one the policy allows; maxStartSize and maxStartAutoStopMinutes are the options that widen it.",
  }
}

/** The `WAREHOUSE_STOPPED` refusal, with the price per hour and the least a start would cost (design §6.2, §6.3). */
export function stoppedRefusal(warehouse: Warehouse, options: Options, state: WarehouseState): Refusal {
  const least = minStartUsd(warehouse, options)
  const stopped = state === "STOPPED" ? "is stopped" : `is ${state.toLowerCase()}`
  return {
    code: "WAREHOUSE_STOPPED",
    detail: `${describe(warehouse, options)} ${stopped}, and this call does not start one.${least === undefined ? "" : ` Starting it would cost at least about $${least.toFixed(2)}, billing until it auto-stops.`}`,
    next: "Use a warehouse that is already running (databricks_warehouses lists them), or call databricks_start for this one.",
  }
}

/** Whether a state may be used for a statement as it is, waited for, or started. */
export function stateClass(state: WarehouseState): "ready" | "starting" | "startable" | "hopeless" {
  if (state === "RUNNING") return "ready"
  if (state === "STARTING") return "starting"
  if (state === "STOPPED") return "startable"
  return "hopeless"
}
