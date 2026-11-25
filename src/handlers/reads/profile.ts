/**
 * `databricks_profile` (design §4): one aggregate query that summarises chosen columns of a table — or of a query given
 * as a subquery — instead of returning rows.
 *
 * Per column it reports, in one statement (`src/tools/reads/sql.ts`):
 *
 * - `nulls`: `count_if(<column> IS NULL)`;
 * - `distinct`: `approx_count_distinct`, an estimate;
 * - `min` and `max`;
 * - `percentiles`: `percentile_approx(<column>, array(0.25, 0.5, 0.75), 10000)`, so the quartiles and the median;
 * - `top`: `approx_top_k(<column>, 5)`, which Databricks returns as an ARRAY of STRUCTs with an `item` and a `count`,
 *   sorted by count [Databricks: `approx_top_k` aggregate function] — read here as data, and only mapped when it has that
 *   shape.
 * And once: `rows`, the row count, and `TABLESAMPLE (<p> PERCENT)` when `samplePercent` is set.
 *
 * The whole statement goes through the read path: its calls are the allowlist's, its table is resolved and fenced, and
 * the warehouse policy applies. A column of a type `min` or `max` cannot order (ARRAY, MAP, STRUCT, BINARY) makes the
 * warehouse answer `STATEMENT_FAILED` with its own message in `providerError`; the plugin does not guess a cast.
 */
import { DatabricksError } from "../../domain/errors.js"
import { prepareRead } from "../../provider/guards/read.js"
import type { Handler } from "../types.js"
import { accountOf, failureOf, submitRead, warehouseUse } from "./context.js"
import { PROFILE_PERCENTILES, PROFILE_TOP, profileQuery } from "./sql.js"
import { cellValue } from "./values.js"

interface TopValue {
  readonly value: unknown
  readonly count: number
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** `approx_top_k`'s array of `{ item, count }` structs, mapped defensively: anything else is left out. */
export function topValuesOf(raw: string | null | undefined): TopValue[] | undefined {
  if (!raw) return undefined
  const parsed = parseJson(raw)
  if (!Array.isArray(parsed)) return undefined
  const mapped: TopValue[] = []
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) return undefined
    const record = entry as Record<string, unknown>
    const value = record.item ?? record.value
    const count = record.count
    if (value === undefined || typeof count !== "number") return undefined
    mapped.push({ value, count })
  }
  return mapped.length ? mapped : undefined
}

/** `percentile_approx`'s array of values, mapped defensively. */
export function percentilesOf(raw: string | null | undefined): unknown[] | undefined {
  if (!raw) return undefined
  const parsed = parseJson(raw)
  return Array.isArray(parsed) ? parsed : undefined
}

/** A count cell as a number: the manifest types it BIGINT, and a string of digits is that same count. */
function asCount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && /^\d+$/u.test(value)) return Number(value)
  return undefined
}

const profile: Handler<"profile"> = async (input, call, deps) => {
  const account = accountOf(input, deps)
  if (!input.table && !input.sql) throw new DatabricksError("INPUT_INVALID", "A profile needs a table or a sql to profile.", "Pass table with columns, or sql with columns.")
  if (input.table && input.sql) throw new DatabricksError("INPUT_INVALID", "A profile takes a table or a sql, not both.", "Pass table, or sql.")
  const sql = profileQuery({
    ...(input.table ? { table: input.table } : {}),
    ...(input.sql ? { sql: input.sql } : {}),
    columns: input.columns,
    ...(input.samplePercent === undefined ? {} : { samplePercent: input.samplePercent }),
  })
  const prepared = await prepareRead(
    deps,
    {
      account,
      sql,
      ...(input.warehouse ? { warehouse: input.warehouse } : {}),
      wait: deps.options.wait,
      tool: "profile",
      sessionID: call.sessionID,
      messageID: call.messageID,
      callID: call.id,
    },
    call.signal,
  )
  const wait = deps.options.wait
  const { answer } = await submitRead(deps, { account, tool: "profile", call, prepared, rowLimit: 1, wait })
  const failure = failureOf(answer, wait)
  if (failure) throw failure
  const types = (answer.manifest?.columns ?? []).map((column) => column.typeName)
  const row = answer.rows?.[0] ?? []
  const cells = row.map((raw, index) => cellValue(raw, types[index]))
  const rowsSeen = asCount(cells[0])
  const perColumn = input.columns.map((name, index) => {
    const at = 1 + index * 6
    const percentiles = percentilesOf(row[at + 4])
    const top = topValuesOf(row[at + 5])
    return {
      name,
      ...(asCount(cells[at]) === undefined ? {} : { nulls: asCount(cells[at]) }),
      ...(asCount(cells[at + 1]) === undefined ? {} : { distinct: asCount(cells[at + 1]) }),
      ...(cells[at + 2] === null || cells[at + 2] === undefined ? {} : { min: cells[at + 2] }),
      ...(cells[at + 3] === null || cells[at + 3] === undefined ? {} : { max: cells[at + 3] }),
      ...(percentiles ? { percentiles } : {}),
      ...(top ? { top } : {}),
    }
  })
  const warnings = [...prepared.warnings]
  return {
    state: "ok",
    trust: "untrusted",
    ...(rowsSeen === undefined ? {} : { rows: rowsSeen }),
    columns: perColumn,
    statementId: answer.statementId,
    warehouse: warehouseUse(prepared, deps),
    ...(warnings.length ? { warnings } : {}),
    ...(input.samplePercent === undefined ? {} : { message: `A ${String(input.samplePercent)}% sample: every figure is an estimate from it.` }),
  }
}

export { PROFILE_PERCENTILES, PROFILE_TOP }

export default profile
