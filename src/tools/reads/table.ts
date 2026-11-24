/**
 * `databricks_table` (design §4, §5.4, §5.7): one table or view — its columns (with the mask on each), its row filter by
 * name, its view definition and dependencies — and, when asked, a small sample or its lineage.
 *
 * - The metadata read is free (`tables.get` [27]); it needs only `USE` and `SELECT`, the privileges a read of the table
 *   needs too.
 * - **A sample** (`sample: n`, at most 20) is `SELECT * FROM <table> LIMIT n` through the whole read path: the fence, the
 *   inline rules, the warehouse policy and the start policy all apply, exactly as for `databricks_query` (design §5.7:
 *   "Samples follow the same rule").
 * - **Lineage** reads `system.access.table_lineage` [26] on the same warehouse and under the same start policy: it needs
 *   grants on the `system` catalog, and its `my_table` lookup travels as a `:oc_table` parameter.
 * - Masks and row filters are shown by name, and the result says the values are what Databricks returns to this identity
 *   (`MASKED_COLUMNS`, `ROW_FILTERED`): the plugin never widens access, and it cannot see the functions behind a mask
 *   (design §5.7 and its disclosure).
 */
import { actionOf, tableResource } from "../../domain/actions.js"
import { DatabricksError } from "../../domain/errors.js"
import { WARNINGS } from "../../domain/errors.js"
import type { Warning } from "../../guards/dependencies.js"
import { prepareRead } from "../../guards/read.js"
import { assertTool } from "../../registry.js"
import type { Handler } from "../../tool-spec.js"
import { accountOf, failureOf, submitRead, warehouseUse } from "./context.js"
import { LINEAGE_PARAM, LINEAGE_SQL, SAMPLE_LIMIT, sampleQuery } from "./sql.js"
import { shapeRows } from "./values.js"

/** How much of a view's stored SQL a result carries (design §4). */
export const VIEW_DEFINITION_LIMIT = 2000

/** Both lists can carry the same warning (the tool's own metadata read and the read guard's resolved tables). */
const merge = (base: readonly Warning[], extra: readonly Warning[]): Warning[] => {
  const seen = new Set<string>()
  return [...base, ...extra].filter((warning) => {
    const key = `${warning.code}|${warning.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const cut = (text: string): string => (text.length <= VIEW_DEFINITION_LIMIT ? text : `${text.slice(0, VIEW_DEFINITION_LIMIT)}…[cut ${text.length - VIEW_DEFINITION_LIMIT} chars]`)

const table: Handler<"table"> = async (input, call, deps) => {
  const account = accountOf(input, deps)
  await assertTool("table", account, call, deps)
  // The table itself, under the tool's own action, so a person's `deny databricks.table on …:table:…` stops a metadata
  // read too (design §10.1, review `databricks-4.md`, LOW 4).
  const parts = input.name.split(".")
  await deps.permission.assert(
    {
      action: actionOf("table"),
      resource: parts.length === 3 && parts[0] && parts[1] && parts[2] ? tableResource(account, parts[0], parts[1], parts[2]) : `${account}:table:${input.name}`,
      sessionID: call.sessionID,
      messageID: call.messageID,
      callID: call.id,
    },
    call.signal,
  )
  if (input.sample === undefined && input.lineage !== true && (input.warehouse || input.start === true)) {
    throw new DatabricksError("INPUT_INVALID", "warehouse and start only apply to sample and lineage, which this call did not ask for.", "Pass sample or lineage: true, or leave warehouse and start out.")
  }

  const info = await deps.databricks.getTable(account, input.name, call.signal)
  const warnings: Warning[] = []
  if (info.columns.some((column) => column.mask)) warnings.push({ code: "MASKED_COLUMNS", message: WARNINGS.MASKED_COLUMNS })
  if (info.rowFilter) warnings.push({ code: "ROW_FILTERED", message: WARNINGS.ROW_FILTERED })
  let sample: { columns: string[]; rows: unknown[][] } | undefined
  let lineage: { source: string; target: string; at?: string }[] | undefined
  /** The warehouse a sample or lineage ran on, with its estimated $/hour: this call's own cost. */
  let warehouse: ReturnType<typeof warehouseUse> | undefined
  const wait = deps.options.wait

  if (input.sample !== undefined) {
    const prepared = await prepareRead(
      deps,
      { account, sql: sampleQuery(input.name, Math.min(input.sample, SAMPLE_LIMIT)), ...(input.warehouse ? { warehouse: input.warehouse } : {}), ...(input.start === undefined ? {} : { start: input.start }), wait, tool: "table", sessionID: call.sessionID, messageID: call.messageID, callID: call.id },
      call.signal,
    )
    warehouse ??= warehouseUse(prepared, deps)
    const { answer } = await submitRead(deps, { account, tool: "table", call, prepared, rowLimit: Math.min(input.sample, SAMPLE_LIMIT), wait })
    const failure = failureOf(answer, wait)
    if (failure) throw failure
    sample = { columns: (answer.manifest?.columns ?? []).map((column) => column.name), rows: shapeRows(answer.rows, answer.manifest?.columns).rows }
    warnings.push(...prepared.warnings)
  }

  if (input.lineage) {
    const prepared = await prepareRead(
      deps,
      {
        account,
        sql: LINEAGE_SQL,
        params: [{ name: LINEAGE_PARAM, value: input.name, type: "STRING" }],
        ...(input.warehouse ? { warehouse: input.warehouse } : {}),
        ...(input.start === undefined ? {} : { start: input.start }),
        wait,
        tool: "table",
        sessionID: call.sessionID,
        messageID: call.messageID,
        callID: call.id,
      },
      call.signal,
    )
    warehouse ??= warehouseUse(prepared, deps)
    const { answer } = await submitRead(deps, { account, tool: "table", call, prepared, parameters: [{ name: LINEAGE_PARAM, value: input.name, type: "STRING" }], rowLimit: 200, wait })
    const failure = failureOf(answer, wait)
    if (failure) throw failure
    lineage = shapeRows(answer.rows, answer.manifest?.columns).rows.map((row) => ({
      source: typeof row[0] === "string" ? row[0] : "",
      target: typeof row[1] === "string" ? row[1] : "",
      ...(typeof row[2] === "string" ? { at: row[2] } : {}),
    }))
    warnings.push(...prepared.warnings)
  }

  return {
    state: "ok",
    trust: "untrusted",
    name: info.fullName,
    ...(info.tableType ? { tableType: info.tableType } : {}),
    ...(info.dataSourceFormat ? { format: info.dataSourceFormat } : {}),
    ...(info.comment ? { comment: info.comment } : {}),
    ...(info.owner ? { owner: info.owner } : {}),
    columns: info.columns.map((column) => ({ name: column.name, type: column.typeText, ...(column.nullable === undefined ? {} : { nullable: column.nullable }), ...(column.comment ? { comment: column.comment } : {}), ...(column.mask ? { mask: column.mask.functionName } : {}) })),
    ...(info.partitionColumns?.length ? { partitionColumns: [...info.partitionColumns] } : {}),
    ...(info.rowFilter ? { rowFilter: info.rowFilter.functionName } : {}),
    ...(info.viewDefinition ? { viewDefinition: cut(info.viewDefinition) } : {}),
    ...(info.viewDependencies
      ? { viewDependencies: info.viewDependencies.map((dependency) => ({ kind: dependency.kind, name: dependency.name })) }
      : {}),
    ...(info.updatedAt === undefined ? {} : { updatedAt: new Date(info.updatedAt).toISOString() }),
    ...(sample ? { sample } : {}),
    ...(lineage ? { lineage } : {}),
    ...(warehouse ? { warehouse } : {}),
    ...(warnings.length ? { warnings: merge([], warnings) } : {}),
  }
}

export default table
