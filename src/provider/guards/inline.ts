/**
 * The inline rules (design §5.7, Q6): whether a read's rows may go back to the model's provider at all.
 *
 * - `accounts.<alias>.inline.deny` is a list of `catalog.schema.table` patterns, matched against the **source tables**
 *   the read resolved — never the result's columns, which cannot be traced back to a source (BigQuery review M7).
 * - `inlinePii: "save-only"` sends no inline rows at all on this account: the rows are only reachable through
 *   `databricks_save`, which writes a file rather than returning cells.
 * - `accounts.<alias>.inline.piiTags` asks the plugin to look for personal-data tags on the sources. This version has no
 *   Unity Catalog tag read on its port (`DatabricksPort` has no tag-assignments call), so a configured `piiTags` cannot
 *   be evaluated. It fails closed: every inline read is refused with `DEPENDENCIES_UNKNOWN`, and the next step names
 *   `databricks_save`. See the PR's contract requests.
 * - A tool that returns no cells (`databricks_explain`) and the file route (`databricks_save`) are not inline reads and
 *   are never refused here.
 *
 * The result is a refusal, not a warning: an inline read whose rows may not leave the warehouse has nowhere else to put
 * them, and running it would either leak them or cost a warehouse start for nothing.
 */
import type { Options } from "../../options.js"
import { quoted, firstMatch } from "./pattern.js"
import type { Refusal } from "./refusal.js"

/** The tools whose result carries cells inline. `explain` returns a plan; `save` writes a file. */
export const INLINE_TOOLS: ReadonlySet<string> = new Set(["query", "profile", "table", "saved_read", "status"])

export interface InlineInput {
  readonly options: Options
  readonly account: string
  /** `ReadRequest.tool`: the tool the read runs for (`query`, `save`, …). */
  readonly tool: string
  /** Every source table the read resolved, `catalog.schema.table`. */
  readonly tables: readonly string[]
}

/** Whether any inline rule applies to this account: a view with unknown dependencies is refused when one does. */
export function inlineApplies(options: Options, account: string): boolean {
  const inline = options.accounts?.[account]?.inline
  return options.inlinePii === "save-only" || Boolean(inline?.deny?.length) || Boolean(inline?.piiTags?.length)
}

/** The refusal that withholds the rows, or undefined when they may be returned inline. */
export function inlineRefusal(input: InlineInput): Refusal | undefined {
  if (!INLINE_TOOLS.has(input.tool)) return undefined
  const save = "Run it with databricks_save({ sql }) to write the rows to a file instead."
  if (input.options.inlinePii === "save-only") {
    return { code: "INLINE_WITHHELD", detail: "inlinePii is save-only on this account, so no rows are returned inline.", next: save }
  }
  const inline = input.options.accounts?.[input.account]?.inline
  if (inline?.piiTags?.length) {
    return {
      code: "DEPENDENCIES_UNKNOWN",
      detail: `inline.piiTags is set, and this version cannot read Unity Catalog tag assignments, so it cannot tell whether a source carries one (${inline.piiTags.map((tag) => quoted(tag, 40)).join(", ")}).`,
      next: "Remove inline.piiTags for this account, or run the query with databricks_save.",
    }
  }
  for (const table of input.tables) {
    const pattern = firstMatch(inline?.deny, table)
    if (pattern) {
      return {
        code: "INLINE_WITHHELD",
        detail: `The source table ${quoted(table)} matches inline.deny's ${quoted(pattern)}, so its rows are not returned inline.`,
        next: save,
      }
    }
  }
  return undefined
}
