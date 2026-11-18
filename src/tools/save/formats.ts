/**
 * The save formats' encoders (design §8.2): CSV (RFC 4180), JSONL with the §8.1 typing, and the two binary formats'
 * writers' plumbing. Arrow and Parquet have their own modules; this one is the text side and the shared "one row at a
 * time" shape the save handler feeds.
 */

/** A cell as CSV writes it: null is empty, nested values are JSON text, booleans are `true`/`false`. */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : JSON.stringify(value)
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

/** One CSV record, quoted only where RFC 4180 requires it: a comma, a quote, CR or LF. */
export function csvLine(values: readonly unknown[]): string {
  return `${values
    .map((value) => {
      const text = csvField(value)
      return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text
    })
    .join(",")}\n`
}

/** One JSON Lines record: an object keyed by the columns, typed as §8.1 says and never cut. */
export function jsonLine(columns: readonly string[], values: readonly unknown[]): string {
  const object: Record<string, unknown> = {}
  for (const [index, name] of columns.entries()) object[name] = values[index] ?? null
  return `${JSON.stringify(object)}\n`
}

/** The cap opencode-charts' reader takes: 100,000 rows, 32 MB (`src/data.ts`, `docs/configuration.md`). */
export const CHARTS_ROWS = 100_000
export const CHARTS_BYTES = 32 * 1024 * 1024

export const fitsCharts = (format: string, rows: number, bytes: number): boolean => (format === "csv" || format === "jsonl" || format === "parquet") && rows <= CHARTS_ROWS && bytes <= CHARTS_BYTES
