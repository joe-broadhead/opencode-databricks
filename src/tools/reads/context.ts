/**
 * What the eight read tools share: the account a call runs for, the statement one read sends, and the answer's shape.
 *
 * A read's statement is built in exactly one place, `submitRead`, from `PreparedReadEx.sent` — `analyzeRead(sql).sent`,
 * the wrapper around the caller's text with every allowlisted built-in qualified. The one exception the design allows
 * is `databricks_explain`, which prefixes `EXPLAIN` to that same wrapped text and nothing else (design §5.1 step 6,
 * §5.5).
 *
 * The submit's fields are the design's §5.1 step 6: `row_limit` and `byte_limit` (the server enforces both [6]),
 * `INLINE` + `JSON_ARRAY`, `wait_timeout` of at most 50 s with `on_wait_timeout: CANCEL` at or below 50 (so Databricks
 * itself cancels the read, laptop or no laptop) and `CONTINUE` only when the call asked for more, and the
 * `query_tags` that make a statement findable in Query History [24].
 */
import type { StatementParameter, StatementRequest, StatementAnswer } from "../../ports.js"
import type { PreparedReadEx } from "../../guards/read.js"
import { DatabricksError, WARNINGS } from "../../domain/errors.js"
import type { Deps } from "../../registry.js"
import type { Call } from "../../tool-spec.js"
import type { ToolName } from "../../domain/actions.js"
import { sizeOf, usdPerHour } from "../../guards/warehouse.js"
import { chargeStatement } from "../../guards/budget.js"
import { sessionToken } from "../../guards/path.js"
import type { Warning } from "../../guards/dependencies.js"
import { safeText } from "../../guards/pattern.js"

/** The account a call runs for: its `account` input, or the first configured account, or `default` (as the registry). */
export function accountOf(input: { readonly account?: string }, deps: Deps): string {
  if (input.account) return input.account
  return Object.keys(deps.options.accounts ?? {})[0] ?? "default"
}

/** One parameter as the contract allows it (a named `:marker`), before it becomes a Statement Execution parameter. */
export interface ParamLike {
  readonly name: string
  readonly value: string | number | boolean | null
  readonly type?: string
}

/**
 * The SQL type of a parameter when the caller did not name one: JSON has no integers, so an `INT` or a `BIGINT` column
 * compared with `42` needs the type to be said [6]. A caller's own `type` always wins.
 */
export function typeOf(value: string | number | boolean | null): string | undefined {
  if (value === null) return undefined
  if (typeof value === "boolean") return "BOOLEAN"
  if (typeof value === "number") return Number.isSafeInteger(value) ? "BIGINT" : "DOUBLE"
  return "STRING"
}

export function toStatementParameters(params: readonly ParamLike[] | undefined): StatementParameter[] | undefined {
  if (!params?.length) return undefined
  return params.map((param) => {
    const type = param.type ?? typeOf(param.value)
    return { name: param.name, value: param.value === null ? null : String(param.value), ...(type ? { type } : {}) }
  })
}

/** The `oc_*` query tags (design §5.1 step 6): audit in Query History, and the recovery match after an ambiguous submit. */
export function queryTags(tool: string, call: Call, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return { oc_plugin: "databricks", oc_tool: tool, oc_session: sessionToken(call.sessionID), oc_call: call.id, ...extra }
}

/** A statement id, safe for the plugin's own words: identifiers only, 128 characters at most (design §5.8). */
export function statementRef(statementId: string): string {
  const safe = statementId.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 128)
  return safe ? `databricks_statement({ statementId: ${JSON.stringify(safe)}, wait: 30 })` : "databricks_statement({ statementId, wait: 30 })"
}

/** A warehouse name, safe for the plugin's own words. */
export const warehouseName = (name: string): string => safeText(name, 120)

/** A wait in seconds as the API takes it: 0, or 5 to 50 [6]. */
export function waitTimeoutOf(wait: number): number {
  if (wait <= 0) return 0
  return Math.min(50, Math.max(5, wait))
}

export interface SubmitInput {
  readonly account: string
  readonly tool: ToolName
  readonly call: Call
  readonly prepared: PreparedReadEx
  /** Defaults to `prepared.sent`; only `databricks_explain` passes an `EXPLAIN` of it. */
  readonly statement?: string
  readonly parameters?: readonly StatementParameter[]
  readonly rowLimit?: number
  readonly byteLimit?: number
  readonly wait: number
  readonly catalog?: string
  readonly schema?: string
  readonly tags?: Readonly<Record<string, string>>
}

export interface SubmittedRead {
  readonly answer: StatementAnswer
  readonly durationMs: number
}

/** Submits one prepared read, and records its estimated DBU-hours when it finished. Never retried (design §9). */
export async function submitRead(deps: Deps, input: SubmitInput): Promise<SubmittedRead> {
  const startedAt = deps.clock.now()
  const request: StatementRequest = {
    account: input.account,
    operation: "sql.statements.query",
    statement: input.statement ?? input.prepared.sent,
    warehouseId: input.prepared.warehouseId,
    ...(input.catalog ? { catalog: input.catalog } : {}),
    ...(input.schema ? { schema: input.schema } : {}),
    ...(input.parameters?.length ? { parameters: input.parameters } : {}),
    ...(input.rowLimit === undefined ? {} : { rowLimit: input.rowLimit }),
    byteLimit: input.byteLimit ?? 1024 * 1024,
    disposition: "INLINE",
    format: "JSON_ARRAY",
    waitTimeout: waitTimeoutOf(input.wait),
    onWaitTimeout: input.wait <= 50 ? "CANCEL" : "CONTINUE",
    queryTags: queryTags(input.tool, input.call, input.tags),
  }
  const answer = await deps.databricks.submit(request, input.call.signal)
  const durationMs = Math.max(0, deps.clock.now() - startedAt)
  if (answer.ambiguous) {
    // Design §9: the submit may have reached the server. It is never retried blindly; Query History is how to find out.
    throw new DatabricksError("UNAVAILABLE", "The submit got no answer, so the statement may have run.", "Check databricks_history({}) before calling again; the plugin never retries a submit that may have reached the server.")
  }
  if (answer.state === "SUCCEEDED" || answer.state === "FAILED" || answer.state === "CANCELED") {
    const size = sizeOf(input.prepared.warehouse)
    if (size) {
      await chargeStatement(deps.ledger, deps.clock, deps.options, {
        account: input.account,
        sessionId: input.call.sessionID,
        warehouseId: input.prepared.warehouseId,
        statementId: answer.statementId,
        size,
        autoStopMinutes: input.prepared.warehouse.autoStopMins,
        clusters: Math.max(1, input.prepared.warehouse.numClusters ?? input.prepared.warehouse.minNumClusters ?? 1),
        durationMs,
      })
    }
  }
  return { answer, durationMs }
}

/** The refusal a terminal answer carries, or undefined when there is a result to shape. */
export function failureOf(answer: StatementAnswer, wait: number): DatabricksError | undefined {
  const provider = { ...(answer.error ?? {}), trust: "untrusted" as const }
  if (answer.state === "FAILED") {
    return new DatabricksError("STATEMENT_FAILED", "The warehouse ran the statement and it failed.", undefined, answer.error ? provider : undefined)
  }
  if (answer.state === "CANCELED") {
    return new DatabricksError("RUN_TIMEOUT", `Databricks cancelled the read at its wait of ${waitTimeoutOf(wait)} seconds${wait > 50 ? "" : " (on_wait_timeout: CANCEL)"}.`, "Narrow the query, or pass a longer wait; above 50 seconds the limit is the plugin's, not the server's.")
  }
  if (answer.state === "CLOSED") {
    return new DatabricksError("RESULTS_EXPIRED", "The statement was closed and its results are no longer available.", "Run it again; the result cache may serve an identical query.")
  }
  return undefined
}

/** The result's `warehouse`, with the list price per hour the call's own estimates use. */
export function warehouseUse(prepared: PreparedReadEx, deps: Deps): { id: string; name: string; started: boolean; usdPerHour: number } {
  return { id: prepared.warehouse.id, name: prepared.warehouse.name, started: prepared.started, usdPerHour: usdPerHour(prepared.warehouse, deps.options) }
}

/** A warning for a cost figure: every price here is a list-price estimate (design §6.1). */
export const estimateWarning: Warning = { code: "ESTIMATE_ONLY", message: WARNINGS.ESTIMATE_ONLY }
