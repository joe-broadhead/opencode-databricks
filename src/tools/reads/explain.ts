/**
 * `databricks_explain` (design §4, §5.1, §5.5): validate a **read** without running it.
 *
 * - The text goes through the whole read path first, so anything the read path refuses never reaches a warehouse: DML,
 *   DDL, a script, `EXECUTE IMMEDIATE`, `CALL`, `TRANSFORM … USING`, a user-defined table function, `IDENTIFIER`, a
 *   secret function. This is why a Python UDTF's `analyze()` — which Databricks runs at planning time [42] — can never
 *   run through this tool.
 * - What is sent is `EXPLAIN [EXTENDED] ` followed by `prepared.sent`, the design's wrapper, and nothing else: the tool
 *   never EXPLAINs a change (design §5.5: `EXPLAIN` executed statements in Spark until SPARK-59689 and SPARK-61554).
 * - The run limit is the server's: `wait_timeout: 50` with `on_wait_timeout: CANCEL` (§6.2) [6].
 * - The plan's top operators are read out of the plan text (`operators`, a heuristic), and the tables are the ones the
 *   read path resolved.
 */
import type { Handler } from "../../tool-spec.js"
import { assertTool } from "../../registry.js"
import { prepareRead } from "../../guards/read.js"
import { accountOf, failureOf, statementRef, submitRead, toStatementParameters, warehouseUse } from "./context.js"

/** The most operators a result lists. */
const MAX_OPERATORS = 20

/**
 * The plan's operator names: a line that starts with Spark's tree markers (`+- `, `:- `, `*- `, `+- `) or that stands
 * alone as `SomeOperator ...`. The plan text is Databricks' own output, so it is read as data: names are cut, and only
 * identifier-shaped words are kept.
 */
export function operatorsOf(rows: readonly (readonly (string | null)[])[] | undefined): string[] {
  const found: string[] = []
  for (const row of rows ?? []) {
    for (const cell of row) {
      if (typeof cell !== "string") continue
      for (const line of cell.split(/\r?\n/u)) {
        const match = /^(?:[+*:-]+-\s*)?([A-Za-z][A-Za-z0-9_]{2,40})(?=[\s(:[]|$)/u.exec(line.trim())
        if (!match) continue
        const name = match[1]!
        if (found.includes(name) || found.length >= MAX_OPERATORS) continue
        found.push(name)
      }
    }
  }
  return found
}

const explain: Handler<"explain"> = async (input, call, deps) => {
  const account = accountOf(input, deps)
  await assertTool("explain", account, call, deps)
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
      ...(input.start === undefined ? {} : { start: input.start }),
      tool: "explain",
      sessionID: call.sessionID,
      messageID: call.messageID,
      callID: call.id,
    },
    call.signal,
    50,
  )
  const sent = `${input.extended ? "EXPLAIN EXTENDED" : "EXPLAIN"} ${prepared.sent}`
  const { answer } = await submitRead(deps, {
    account,
    tool: "explain",
    call,
    prepared,
    statement: sent,
    ...(parameters ? { parameters } : {}),
    wait: 50,
    ...(input.catalog ? { catalog: input.catalog } : {}),
    ...(input.schema ? { schema: input.schema } : {}),
  })
  const failure = failureOf(answer, 50)
  if (failure) throw failure
  const running = answer.state === "PENDING" || answer.state === "RUNNING"
  const operators = running ? [] : operatorsOf(answer.rows)
  const warnings = [...prepared.warnings]
  return {
    state: running ? "running" : "ok",
    trust: "untrusted",
    sent,
    ...(operators.length ? { operators } : {}),
    tables: [...prepared.tables],
    warehouse: warehouseUse(prepared, deps),
    ...(warnings.length ? { warnings } : {}),
    ...(running ? { next: statementRef(answer.statementId) } : {}),
  }
}

export default explain
