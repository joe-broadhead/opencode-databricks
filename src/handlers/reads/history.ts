/**
 * `databricks_history` (design §4, [24]): the person's own recent statements from Query History — free, no warehouse.
 *
 * - Query History is filtered to the identity's own user id (`Me.id` [30]) and, when `since` is given, to statements
 *   that started after it. One call covers at most 30 days [24], so a longer window is `INPUT_INVALID`.
 * - **No status filter is sent**: "filtering by several statuses is not recommended" [24] (review L2), so the plugin asks
 *   without one and filters here.
 * - `sql` is the first 200 characters of `query_text` and is untrusted, like every other field: a query's text holds
 *   literals, secrets and personal data (design §5.8, §11.1). Nothing from it reaches `message` or `next`.
 * - `since` takes an ISO 8601 date or timestamp, or an age such as `24h` or `7d`; the default is the last 24 hours.
 */
import { DatabricksError } from "../../domain/errors.js"
import type { Handler } from "../types.js"
import { accountOf } from "./context.js"
import { CELL_LIMIT } from "./values.js"

const DAY_MS = 86_400_000
/** Query History answers at most 30 days in one call [24]. */
export const MAX_SINCE_MS = 30 * DAY_MS

/** `since` as a start time in milliseconds. Throws INPUT_INVALID for a window the API cannot answer. */
export function sinceToMs(since: string | undefined, now: number): number {
  if (!since) return now - DAY_MS
  const age = /^(\d{1,3})([hdw])$/u.exec(since.trim())
  if (age) {
    const unit = age[2] === "h" ? 3_600_000 : age[2] === "d" ? DAY_MS : 7 * DAY_MS
    const start = now - Number(age[1]) * unit
    if (now - start > MAX_SINCE_MS) throw new DatabricksError("INPUT_INVALID", `since=${since} is longer than 30 days, which one Query History call cannot cover.`, "Ask for 30 days or less, or call again for an older window.")
    return start
  }
  const parsed = Date.parse(since)
  if (Number.isNaN(parsed)) throw new DatabricksError("INPUT_INVALID", `since=${since.slice(0, 40)} is not an ISO 8601 date, a timestamp, or an age such as 24h or 7d.`, "Pass since as 2026-11-01, 2026-11-01T09:00:00Z, 24h or 7d.")
  if (now - parsed > MAX_SINCE_MS) throw new DatabricksError("INPUT_INVALID", "since is longer than 30 days, which one Query History call cannot cover.", "Ask for 30 days or less, or call again for an older window.")
  return parsed
}

const history: Handler<"history"> = async (input, call, deps) => {
  const account = accountOf(input, deps)
  const limit = input.limit ?? 25
  const me = await deps.databricks.me(account, call.signal)
  const userId = Number(me.id)
  if (!Number.isSafeInteger(userId)) {
    throw new DatabricksError("UNAVAILABLE", "Query History filters by a numeric user id, and this identity's id is not numeric.", "Use the Databricks SQL editor's query history, or sign in as a user.")
  }
  const startMs = sinceToMs(input.since, deps.clock.now())
  const page = await deps.databricks.history(account, { userIds: [userId], startMs, maxResults: limit }, call.signal)
  const items = page.items
    .filter((query) => input.status === undefined || query.status === input.status)
    .sort((left, right) => right.queryStartTimeMs - left.queryStartTimeMs)
    .slice(0, limit)
    .map((query) => ({
      id: query.queryId,
      status: query.status,
      ...(query.statementType ? { statementType: query.statementType } : {}),
      ...(query.warehouseId ? { warehouse: query.warehouseId } : {}),
      ...(query.durationMs === undefined ? {} : { durationMs: query.durationMs }),
      ...(query.rowsProduced === undefined ? {} : { rows: query.rowsProduced }),
      ...(query.readBytes === undefined ? {} : { readBytes: query.readBytes }),
      ...(query.queryTags && Object.keys(query.queryTags).length ? { tags: { ...query.queryTags } } : {}),
      ...(query.queryText ? { sql: query.queryText.slice(0, CELL_LIMIT) } : {}),
    }))
  return { state: "ok", trust: "untrusted", items }
}

export default history
