/**
 * `databricks_stop` (design §4, §7, §6.2): stop a SQL warehouse. Free, and it lowers cost: an idle warehouse
 * "continue[s] to accumulate DBU … charges until [it is] stopped" [16].
 *
 * **It refuses rather than ends someone else's work.** Before stopping, it reads Query History for the warehouse
 * (`/api/2.0/sql/history/queries` with `filter_by.warehouse_ids`, scope `query-history`, [24]) and refuses
 * `STOP_NOT_PERMITTED` when a statement that is `RUNNING` or `QUEUED` belongs to another user — or belongs to nobody
 * this call can name, which is the fail-closed reading of a record whose owner it cannot see. There is **no `force`**:
 * ending other people's queries is not this tool's: the warehouse owner or a person with Can manage must do it.
 *
 * **What it cannot prove.** Databricks shows other users' statements only to an identity with Can monitor or above [16],
 * and neither Query History nor the warehouse object says which the identity holds, so a person who sees only their own
 * statements looks exactly like a warehouse nobody is using. Stopping needs Can manage [16] regardless: without it
 * Databricks refuses the stop, and that refusal is `STOP_NOT_PERMITTED` here. A page of history with a
 * `next_page_token` is refused too: this call cannot claim it saw every running statement.
 */
import { DatabricksError } from "../../domain/errors.js"
import type { Deps } from "../deps.js"
import type { Handler } from "../types.js"
import { accountOf } from "./context.js"

/** The window Query History is read over: a statement that started longer ago is still on one page of the newest ones. */
export const STOP_HISTORY_LOOKBACK_MS = 60 * 60 * 1000

const stopNotPermitted = (detail: string, next: string): DatabricksError => new DatabricksError("STOP_NOT_PERMITTED", detail, next)

const stop: Handler<"stop"> = async (input, call, deps) => {
  const account = accountOf(input, deps)
  const warehouse = await deps.databricks.getWarehouse(account, input.warehouse, call.signal)
  if (warehouse.state === "STOPPED") return { state: "ok", warehouse: input.warehouse, stopped: false, next: "It is already stopped: nothing was sent. An idle warehouse that is STOPPED bills nothing." }
  const me = await deps.databricks.me(account, call.signal)
  const mine = Number(me.id)
  let page: Awaited<ReturnType<Deps["databricks"]["history"]>>
  try {
    page = await deps.databricks.history(account, { warehouseIds: [input.warehouse], startMs: deps.clock.now() - STOP_HISTORY_LOOKBACK_MS, maxResults: 1000 }, call.signal)
  } catch (error) {
    const code = error instanceof DatabricksError ? error.code : undefined
    if (code === "PERMISSION_DENIED" || code === "AUTH_SCOPE_MISSING" || code === "UNAVAILABLE" || code === "RATE_LIMITED") {
      throw stopNotPermitted("This call could not read Query History for the warehouse, so it cannot tell whose statements are running on it.", "Ask someone with Can monitor on the warehouse to stop it, or ask the warehouse's owner.")
    }
    throw error
  }
  if (page.nextPageToken) {
    throw stopNotPermitted("The warehouse has more statements this call could read, so it cannot tell whether another user's statement is running.", "Try again when it is quieter, or stop it in Databricks.")
  }
  const foreign = page.items.filter((query) => {
    if (query.status !== "RUNNING" && query.status !== "QUEUED") return false
    const owner = query.executedAsUserId ?? query.userId
    return !Number.isSafeInteger(mine) || owner === undefined || owner !== mine
  })
  if (foreign.length > 0) {
    throw stopNotPermitted(
      `${foreign.length} statement${foreign.length === 1 ? "" : "s"} on the warehouse ${foreign.length === 1 ? "is" : "are"} still running, and ${foreign.length === 1 ? "it is" : "they are"} not this identity's.`,
      "This tool never ends other people's queries; ask them to stop, or ask the warehouse's owner.",
    )
  }
  try {
    await deps.databricks.stopWarehouse(account, input.warehouse, call.signal)
  } catch (error) {
    if (error instanceof DatabricksError && error.code === "PERMISSION_DENIED") {
      throw stopNotPermitted("Stopping a warehouse needs Can manage on it, and this identity does not have it.", "Ask the warehouse's owner to stop it; stopping ends its billing until something starts it again.")
    }
    throw error
  }
  return {
    state: "ok",
    warehouse: input.warehouse,
    stopped: true,
    next: "A later query on it starts it again automatically, so stopping it only ends the idle billing for now.",
  }
}

export default stop
