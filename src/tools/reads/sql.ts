/**
 * The SQL the read tools build themselves — a table's sample, a profile's aggregate, a lineage lookup — and the quoting
 * that keeps a caller's name a name.
 *
 * Every statement here goes through the same read path as a caller's text (`analyzeRead`), so nothing is sent that the
 * read path would refuse: the only names in them are identifiers from the plugin's own text and the caller's validated
 * `catalog.schema.table` or column names, each backquoted with its own backticks doubled. A value never becomes text:
 * the lineage lookup's table name travels as a `:name` parameter.
 *
 * Callers of these functions must still pass the result to `prepareRead`, which parses it, checks its calls, resolves
 * its tables and fences them.
 */

/** One name part, backquoted for Spark: a backtick inside is doubled (`sql-ref-names-identifier-clause`). */
export const quotePart = (part: string): string => `\`${part.replaceAll("`", "``")}\``

/**
 * A `catalog.schema.table` name as SQL. The name is split on dots, so a part that itself holds a dot has to be written
 * as one part by the caller; the contract's `FullName` is the dotted form, which is what Unity Catalog returns.
 */
export const quoteName = (fullName: string): string => fullName.split(".").map(quotePart).join(".")

/** `SELECT * FROM <table> LIMIT n`: a sample, never more than the contract's 20 rows (design §4, §5.7). */
export const SAMPLE_LIMIT = 20

export function sampleQuery(fullName: string, rows: number): string {
  const limit = Math.max(1, Math.min(SAMPLE_LIMIT, Math.trunc(rows)))
  return `SELECT * FROM ${quoteName(fullName)} LIMIT ${limit}`
}

/**
 * The lineage lookup (design §4, [26]): `system.access.table_lineage` records one row per read or write of a Unity
 * Catalog table, with `source_table_full_name`, `target_table_full_name` and `event_time`, kept for a rolling 395 days.
 * The table name is a `:oc_table` parameter, so no name is ever spliced into text.
 */
export const LINEAGE_SQL = [
  "SELECT `source_table_full_name` AS `source`, `target_table_full_name` AS `target`, `event_time` AS `at`",
  "FROM `system`.`access`.`table_lineage`",
  "WHERE `target_table_full_name` = :oc_table OR `source_table_full_name` = :oc_table",
  "ORDER BY `event_time` DESC",
  "LIMIT 200",
].join("\n")

/** The name the lineage lookup's parameter carries. */
export const LINEAGE_PARAM = "oc_table"

/** The percentiles a profile reports: the quartiles and the median (design §4). */
export const PROFILE_PERCENTILES = [0.25, 0.5, 0.75] as const
/** The number of most frequent values a profile reports (design §4: `approx_top_k` (5)). */
export const PROFILE_TOP = 5

export interface ProfileInput {
  /** A table's full name, quoted here. */
  readonly table?: string
  /** A query to profile as a subquery; the caller's text, which the read path then parses. */
  readonly sql?: string
  readonly columns: readonly string[]
  /** `TABLESAMPLE (<p> PERCENT)`, 0.01 to 100 (design §4). */
  readonly samplePercent?: number
}

/** One aggregate over a table or a query, per chosen column: rows, nulls, distinct, min, max, percentiles, top values. */
export function profileQuery(input: ProfileInput): string {
  const source = input.table ? quoteName(input.table) : `(\n${input.sql ?? ""}\n) AS oc_src`
  const sample = input.samplePercent === undefined ? "" : ` TABLESAMPLE (${percentOf(input.samplePercent)} PERCENT)`
  const aggregates = ["count(*) AS `oc_rows`"]
  input.columns.forEach((column, index) => {
    const name = quotePart(column)
    aggregates.push(
      `count_if(${name} IS NULL) AS \`oc_nulls_${index}\``,
      `approx_count_distinct(${name}) AS \`oc_distinct_${index}\``,
      `min(${name}) AS \`oc_min_${index}\``,
      `max(${name}) AS \`oc_max_${index}\``,
      `percentile_approx(${name}, array(${PROFILE_PERCENTILES.join(", ")}), 10000) AS \`oc_percentiles_${index}\``,
      `approx_top_k(${name}, ${PROFILE_TOP}) AS \`oc_top_${index}\``,
    )
  })
  return `SELECT\n  ${aggregates.join(",\n  ")}\nFROM ${source}${sample}`
}

/** A number as SQL text, without an exponent: `0.01`, `10`, `100`. */
function percentOf(percent: number): string {
  const clamped = Math.max(0.01, Math.min(100, percent))
  return Number.isInteger(clamped) ? String(clamped) : clamped.toFixed(4).replace(/0+$/u, "")
}
