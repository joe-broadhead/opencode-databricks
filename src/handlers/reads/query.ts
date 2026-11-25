/**
 * `databricks_query` (design §4, §5.1): one read through the read path, with the server's row and byte caps and the
 * plugin's own inline cap. The statement is exactly `prepared.sent` — the design's wrapper around the caller's text with
 * every allowlisted call qualified — and every other field is §5.1 step 6's.
 *
 * A `CONTINUE` read (a `wait` above 50) that has not finished answers `running` with the statement's id: the model polls
 * `databricks_statement`. At or below 50 Databricks itself cancels it at the wait, so nothing is left running by a closed
 * laptop.
 *
 * The posture is §5.7's: rows are only inline if the account's inline rules allow it, and `prepareRead` refuses first if
 * they do not. Every cell is cut and escaped, and every value is typed as §8.1 says (`values.ts`).
 */
import { bytesOf } from "../../options.js"
import type { Handler } from "../types.js"
import { prepareRead } from "../../provider/guards/read.js"
import { accountOf, failureOf, statementRef, submitRead, toStatementParameters, warehouseUse } from "./context.js"
import { fitInline, shapeRows } from "./values.js"

const query: Handler<"query"> = async (input, call, deps) => {
  const account = accountOf(input, deps)
  const wait = input.wait ?? deps.options.wait
  const parameters = toStatementParameters(input.params)
  const prepared = await prepareRead(
    deps,
    {
      account,
      sql: input.sql,
      ...(parameters ? { params: parameters } : {}),
      ...(input.warehouse ? { warehouse: input.warehouse } : {}),
      ...(input.catalog ? { catalog: input.catalog } : {}),
      ...(input.schema ? { schema: input.schema } : {}),
      wait,
      tool: "query",
      sessionID: call.sessionID,
      messageID: call.messageID,
      callID: call.id,
    },
    call.signal,
  )
  const maxRows = input.maxRows ?? deps.options.maxRows
  const { answer, durationMs } = await submitRead(deps, {
    account,
    tool: "query",
    call,
    prepared,
    ...(parameters ? { parameters } : {}),
    rowLimit: maxRows,
    wait,
    ...(input.catalog ? { catalog: input.catalog } : {}),
    ...(input.schema ? { schema: input.schema } : {}),
  })
  const warnings = [...prepared.warnings]
  if (answer.state === "PENDING" || answer.state === "RUNNING") {
    return {
      state: "running",
      statementId: answer.statementId,
      warehouse: warehouseUse(prepared, deps),
      ...(warnings.length ? { warnings } : {}),
      next: statementRef(answer.statementId),
    }
  }
  const failure = failureOf(answer, wait)
  if (failure) throw failure
  const columns = (answer.manifest?.columns ?? []).map((column) => ({ name: column.name, type: column.typeText || column.typeName }))
  const shaped = shapeRows(answer.rows, answer.manifest?.columns)
  const fitted = fitInline(shaped.rows, bytesOf(deps.options.maxInlineBytes))
  const truncated = {
    ...(answer.manifest?.truncated === true || (answer.rows?.length ?? 0) >= maxRows ? { rows: true } : {}),
    ...(shaped.cellsCut ? { cells: true } : {}),
    ...(fitted.bytesCut ? { bytes: true } : {}),
  }
  const more = truncated.rows || truncated.bytes
  return {
    state: "ok",
    trust: "untrusted",
    enforcement: prepared.enforcement,
    columns,
    rows: fitted.rows,
    returned: fitted.rows.length,
    ...(answer.manifest?.totalRowCount === undefined ? {} : { totalRows: answer.manifest.totalRowCount }),
    ...(Object.keys(truncated).length ? { truncated } : {}),
    statementId: answer.statementId,
    warehouse: warehouseUse(prepared, deps),
    durationMs,
    ...(warnings.length ? { warnings } : {}),
    ...(more ? { next: "Run it with databricks_save({ sql }) to write the full result to a file, or add a filter or a LIMIT." } : {}),
  }
}

export default query
