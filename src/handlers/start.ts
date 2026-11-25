/**
 * `databricks_start`: the one method that starts a stopped SQL warehouse, and the only place a start's billing
 * permission is asked. The register asks `databricks.start` on the declared operations before this runs, so the ask is
 * not hidden inside a read or a change.
 */
import { startDbuHours } from "../provider/cost.js"
import { DatabricksError } from "../domain/errors.js"
import { chargeStart } from "../provider/guards/budget.js"
import { describe, sizeOf, startRefusal, startVerdict, stateClass, usdPerHour } from "../provider/guards/warehouse.js"
import type { Deps } from "./deps.js"
import type { Handler } from "./types.js"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForRunning(deps: Deps, account: string, warehouseId: string, seconds: number, signal: AbortSignal) {
  const until = deps.clock.now() + Math.max(0, seconds) * 1000
  let current = await deps.databricks.getWarehouse(account, warehouseId, signal)
  while (current.state !== "RUNNING" && deps.clock.now() < until) {
    if (signal.aborted) throw new DatabricksError("CANCELLED")
    await sleep(1000)
    current = await deps.databricks.getWarehouse(account, warehouseId, signal)
    if (current.state !== "STARTING" && current.state !== "RUNNING") return current
  }
  return current
}

const start: Handler<"start"> = async (input, call, deps) => {
  const account = input.account ?? Object.keys(deps.options.accounts ?? {})[0] ?? "default"
  const warehouse = await deps.databricks.getWarehouse(account, input.warehouse, call.signal)
  const state = stateClass(warehouse.state)
  if (state === "ready") return { state: "ok", warehouse: warehouse.id, status: warehouse.state, usdPerHour: usdPerHour(warehouse, deps.options) }
  if (state === "starting") {
    const running = await waitForRunning(deps, account, warehouse.id, input.wait ?? deps.options.wait, call.signal)
    if (running.state !== "RUNNING") throw new DatabricksError("UNAVAILABLE", `The warehouse is starting and did not reach RUNNING within ${input.wait ?? deps.options.wait} seconds.`, "Try again in a few seconds.")
    return { state: "ok", warehouse: running.id, status: running.state, usdPerHour: usdPerHour(running, deps.options) }
  }
  if (state === "hopeless") {
    const refusal = startRefusal(warehouse, deps.options, { allowed: false, reasons: [`it is ${warehouse.state.toLowerCase()}`] })
    throw new DatabricksError(refusal.code, refusal.detail, refusal.next)
  }
  const verdict = startVerdict(warehouse, deps.options)
  if (!verdict.allowed) {
    const refusal = startRefusal(warehouse, deps.options, verdict)
    throw new DatabricksError(refusal.code, refusal.detail, refusal.next)
  }
  const size = sizeOf(warehouse)
  if (!size) throw new DatabricksError("START_REFUSED", `${describe(warehouse, deps.options)} has a size this version's DBU table does not know.`, "Use another warehouse.")
  const charged = await chargeStart(deps.ledger, deps.options, {
    account,
    sessionId: call.sessionID,
    warehouseId: warehouse.id,
    dbuHours: startDbuHours({ size, autoStopMinutes: warehouse.autoStopMins, clusters: Math.max(1, warehouse.numClusters ?? warehouse.minNumClusters ?? 1) }),
  })
  await deps.databricks.startWarehouse(account, warehouse.id, call.signal)
  const running = await waitForRunning(deps, account, warehouse.id, input.wait ?? deps.options.wait, call.signal)
  if (running.state !== "RUNNING") {
    throw new DatabricksError(
      "UNAVAILABLE",
      `${describe(warehouse, deps.options)} was started and did not reach RUNNING within ${input.wait ?? deps.options.wait} seconds.`,
      "Check it with databricks_warehouses; the start already bills until it auto-stops.",
    )
  }
  return { state: "ok", warehouse: running.id, status: running.state, usdPerHour: usdPerHour(running, deps.options), ...(charged.warning ? { warnings: [charged.warning] } : {}) }
}

export default start
