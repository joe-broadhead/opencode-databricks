/**
 * The post-run drift check (design §5.1 step 7, §5.5, §16): after a statement has run, Query History records what kind
 * of statement it really was, and the plugin compares that with what the plan (or the read path) promised.
 *
 * Databricks records the type in Query History's `statement_type`, whose values the reference lists: `OTHER`, `ALTER`,
 * `ANALYZE`, `COPY`, `CREATE`, `DELETE`, `DESCRIBE`, `DROP`, `EXPLAIN`, `GRANT`, `INSERT`, `MERGE`, `OPTIMIZE`,
 * `REFRESH`, `REPLACE`, `REVOKE`, `SELECT`, `SET`, `SHOW`, `TRUNCATE`, `UPDATE` and `USE`
 * (https://docs.databricks.com/api/query-history/v1/query-history/object.md). Query History is filtered by
 * `filter_by.statement_ids`, so the record for one statement is one call, and it needs no warehouse [24].
 *
 * **What a drift is.** A category is a promise about the most a statement can do (design §5.5's table). A statement
 * whose recorded type is outside the set its category allows broke that promise: a `write` plan that was recorded as
 * `DROP`, or a `delete` plan recorded as `SELECT`, means the planned text did not run as planned. The statement has
 * already had its effect, so a drift is **recorded and reported as a warning**, never turned into a refusal that would
 * hide the statement id and the rows affected of a change that did happen. `CLASSIFICATION_DRIFT` is both an error code
 * (for the read path, §5.1 step 7) and a warning code (for a commit, §5.5), and this module raises the warning.
 *
 * **When it cannot be checked.** Query History can lag behind a submit, and it is filtered by *start* time [24]. A
 * record that is not there yet, or a call that fails, is recorded as an unchecked attempt — never as a pass — and adds
 * no warning: a change that ran is not failed for a bookkeeping read the plugin could not make. The record says
 * `checked: false`, so status can show that nothing was proven.
 *
 * **`run` is never in drift.** A `run` category's effects are unknown until it runs (§5.5), so every recorded type is
 * within what it promised; the check is skipped rather than passed.
 *
 * **L7, as evidence only.** This module is what replaces `EXPLAIN`ing a plan (design §5.5 step 3): `databricks_plan`
 * never sends a statement, and the post-run record is the check instead. L7's live evidence (that `EXPLAIN` of a change
 * has effects on a warehouse channel) is not needed by v0.1.0 and no code path here sends `EXPLAIN` of a change —
 * `test/unit/changes/plan-classification.test.ts` pins that a plan of every mutating form in §5.5 sends nothing.
 */
import type { Category } from "./domain/actions.js"
import { WARNINGS, type WarningCode } from "./domain/errors.js"
import type { DatabricksPort } from "./ports.js"
import type { Warning } from "./guards/dependencies.js"

/**
 * Every `statement_type` Query History documents (the reference's enum, above). A recorded type outside this set is
 * still compared: it is not in any category's set, so it is a drift, which is the fail-closed answer for a value this
 * version does not know.
 */
export const STATEMENT_TYPES = ["ALTER", "ANALYZE", "COPY", "CREATE", "DELETE", "DESCRIBE", "DROP", "EXPLAIN", "GRANT", "INSERT", "MERGE", "OPTIMIZE", "OTHER", "REFRESH", "REPLACE", "REVOKE", "SELECT", "SET", "SHOW", "TRUNCATE", "UPDATE", "USE"] as const
export type StatementType = (typeof STATEMENT_TYPES)[number]

/** What the read path expects to be recorded for a plain read, and for `databricks_explain` (§5.1 step 7). */
export const READ_STATEMENT_TYPE: StatementType = "SELECT"
export const EXPLAIN_STATEMENT_TYPE: StatementType = "EXPLAIN"

/**
 * The types each plan category may be recorded as, from §5.5's table and the reference's enum. `OTHER` is in every set:
 * Databricks records a statement it does not classify as `OTHER`, which says nothing either way, and turning it into a
 * drift would report a change that ran as if it had done something else. `run` is absent on purpose: its effects are
 * unknown until it runs, so it cannot drift.
 */
export const ALLOWED_TYPES: Readonly<Record<Exclude<Category, "run">, ReadonlySet<string>>> = {
  // INSERT INTO, UPDATE, MERGE without DELETE, CREATE/ALTER/COPY/OPTIMIZE/ANALYZE/REFRESH/UNDROP, and a
  // side-effecting read (a `SELECT` that calls `http_request`, §5.2).
  write: new Set(["INSERT", "UPDATE", "MERGE", "CREATE", "ALTER", "COPY", "OPTIMIZE", "ANALYZE", "REFRESH", "SELECT", "SET", "OTHER"]),
  // DELETE, TRUNCATE, DROP, INSERT OVERWRITE, MERGE with DELETE, CREATE/REPLACE over an existing target, ALTER … DROP.
  delete: new Set(["DELETE", "TRUNCATE", "DROP", "INSERT", "MERGE", "CREATE", "REPLACE", "ALTER", "SELECT", "OTHER"]),
  // GRANT, REVOKE, DENY, ALTER … OWNER TO, SET/DROP ROW FILTER, SET/DROP MASK, SET/UNSET TAGS, shares and policies.
  share: new Set(["GRANT", "REVOKE", "ALTER", "SET", "CREATE", "DROP", "REPLACE", "OTHER"]),
  // INSERT OVERWRITE DIRECTORY, CREATE TABLE … LOCATION … AS SELECT.
  export: new Set(["INSERT", "CREATE", "OTHER"]),
  // Connections, storage credentials, external locations, catalog managed location, sync, warehouse edits.
  admin: new Set(["CREATE", "ALTER", "DROP", "SET", "OTHER"]),
}

/** Whether a recorded `statement_type` is within what `category` promised. An unknown recorded type is a drift. */
export function typeAllowed(category: Category, statementType: string): boolean {
  if (category === "run") return true
  return ALLOWED_TYPES[category].has(statementType.toUpperCase())
}

/** What the plugin saw, for status and for the tests: one entry per comparison. */
export interface DriftRecord {
  /** `deps.clock.now()`, epoch milliseconds. */
  readonly at: number
  readonly account: string
  /** The plan committed, when the comparison follows a commit. */
  readonly planId?: string
  readonly statementId: string
  readonly category: Category
  /** Query History's `statement_type`, when there was a record for the statement. */
  readonly observed?: string
  /** `true` when there was a record and it was within the category's set; `false` when it drifted. */
  readonly checked: boolean
  readonly drifted: boolean
  /** Why it could not be checked, when it could not (Query History had no record, or the call failed). */
  readonly note?: string
}

const records: DriftRecord[] = []
/** How many records this process keeps: enough for status's "last errors" and a test's assertions. */
const MAX_RECORDS = 100

/** The comparisons this process has made, newest last. */
export function driftRecords(): readonly DriftRecord[] {
  return records
}

/** Test seam: forget what this process saw. */
export function forgetDrift(): void {
  records.length = 0
}

function record(entry: DriftRecord): void {
  records.push(entry)
  while (records.length > MAX_RECORDS) records.shift()
}

/** What the check needs: the client, a clock and the call's signal. */
export interface DriftDeps {
  readonly databricks: Pick<DatabricksPort, "history">
  readonly now: () => number
}

export interface DriftInput {
  readonly account: string
  readonly statementId: string
  readonly category: Category
  readonly planId?: string
  readonly signal: AbortSignal
}

/**
 * Compares one finished statement with the category its plan promised. Answers the warnings a result should carry: one
 * `CLASSIFICATION_DRIFT` when the recorded type is outside the set, none when it is within it or when there is nothing
 * to compare yet. Never throws: a change that ran must still report what it did.
 */
export async function checkDrift(deps: DriftDeps, input: DriftInput): Promise<readonly Warning[]> {
  const base = { at: deps.now(), account: input.account, statementId: input.statementId, category: input.category, ...(input.planId ? { planId: input.planId } : {}) }
  if (input.category === "run") {
    // §5.5: a run's statements are not known until it runs, so there is nothing to compare it with.
    record({ ...base, checked: false, drifted: false, note: "a run's effects are not known until it runs" })
    return []
  }
  let statementType: string | undefined
  try {
    const page = await deps.databricks.history(input.account, { statementIds: [input.statementId], maxResults: 1 }, input.signal)
    statementType = page.items.find((item) => item.queryId === input.statementId)?.statementType ?? page.items[0]?.statementType
  } catch {
    record({ ...base, checked: false, drifted: false, note: "Query History could not be read" })
    return []
  }
  if (!statementType) {
    record({ ...base, checked: false, drifted: false, note: "Query History had no record of the statement yet" })
    return []
  }
  if (typeAllowed(input.category, statementType)) {
    record({ ...base, observed: statementType, checked: true, drifted: false })
    return []
  }
  record({ ...base, observed: statementType, checked: true, drifted: true })
  return [{ code: "CLASSIFICATION_DRIFT" as WarningCode, message: `${WARNINGS.CLASSIFICATION_DRIFT} The plan was a ${input.category} plan, and Databricks recorded ${statementType}.` }]
}
