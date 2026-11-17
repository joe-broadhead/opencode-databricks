/**
 * `databricks_warehouses` (design §4, §6.1–§6.3): the SQL warehouses this identity can see — free, no warehouse needed —
 * with the estimated price per hour, and whether this account may start each one under the start policy.
 *
 * - `dbuPerHour` is the size's DBU rate and `usdPerHour` that times the account's `usdPerDbu` price; both are estimates
 *   from list prices (design §6.1) and the result says so.
 * - `mayStart` and `whyNot` answer the policy without starting anything: serverless only, at most `maxStartSize`, with an
 *   auto-stop of 1 to `maxStartAutoStopMinutes` minutes (§6.2). It says nothing about `Can use`: only a start proves
 *   that, and Databricks refuses it (`WAREHOUSE_FORBIDDEN`).
 * - `warnings` flags a warehouse whose auto-stop is off or longer than 30 minutes: idle warehouses "continue to
 *   accumulate DBU … charges until they are stopped" [16].
 * - The same start policy, the `databricks.start` action and the cost text are what `databricks_query` reads when it is
 *   asked to start one.
 */
import { WARNINGS } from "../../domain/errors.js"
import type { Warning } from "../../guards/dependencies.js"
import { dbuPerHour, startVerdict, usdPerHour } from "../../guards/warehouse.js"
import { assertTool } from "../../registry.js"
import type { Handler } from "../../tool-spec.js"
import { accountOf, estimateWarning } from "./context.js"

const warehouses: Handler<"warehouses"> = async (input, call, deps) => {
  const account = accountOf(input, deps)
  await assertTool("warehouses", account, call, deps)
  const list = await deps.databricks.listWarehouses(account, call.signal)
  const items = list.map((warehouse) => {
    const verdict = startVerdict(warehouse, deps.options)
    return {
      id: warehouse.id,
      name: warehouse.name,
      type: warehouse.serverless ? ("serverless" as const) : warehouse.warehouseType === "PRO" ? ("pro" as const) : ("classic" as const),
      size: warehouse.clusterSize,
      state: warehouse.state,
      autoStopMinutes: warehouse.autoStopMins,
      minClusters: warehouse.minNumClusters,
      maxClusters: warehouse.maxNumClusters,
      ...(warehouse.statementTimeoutSeconds === undefined ? {} : { statementTimeoutSeconds: warehouse.statementTimeoutSeconds }),
      dbuPerHour: dbuPerHour(warehouse),
      usdPerHour: usdPerHour(warehouse, deps.options),
      mayStart: verdict.allowed,
      ...(verdict.allowed ? {} : { whyNot: verdict.reasons.join("; ") }),
    }
  })
  const warnings: Warning[] = [estimateWarning]
  if (list.some((warehouse) => warehouse.autoStopMins < 1)) warnings.push({ code: "AUTO_STOP_OFF", message: WARNINGS.AUTO_STOP_OFF })
  if (list.some((warehouse) => warehouse.autoStopMins > 30)) warnings.push({ code: "AUTO_STOP_LONG", message: WARNINGS.AUTO_STOP_LONG })
  return { state: "ok", items, warnings }
}

export default warehouses
