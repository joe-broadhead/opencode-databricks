/**
 * The cells of an inline result, shaped for a model (design §8.1, §5.8).
 *
 * `JSON_ARRAY` gives every cell as a string or `null` [6]; the manifest's schema says what type it is. The types are
 * converted the way §8.1 says, so a model sees a number where the column is a number and a boolean where it is a
 * boolean:
 *
 * - integers: a number when JavaScript holds it exactly, otherwise the string (a 64-bit id must not lose digits);
 * - `DECIMAL`: the string, because a decimal is exact and a double is not;
 * - `DOUBLE`/`FLOAT`: a number, with `NaN`, `Infinity` and `-Infinity` as strings (JSON has no such numbers);
 * - `TIMESTAMP`/`TIMESTAMP_NTZ`: the string Databricks sent, which is ISO 8601;
 * - `DATE`, `BINARY` (base64), `INTERVAL` and everything else: the string.
 *
 * Every cell that is text is then cut to 200 characters (`…[cut N chars]`), and control characters other than tab and
 * newline are escaped: a cell is data, never a line of instructions (design §5.8). Package B's `databricks_save` writes
 * the same values uncut to a file (§8.2); the two must agree on the types, which is why this file is the read path's only
 * conversion.
 */
export const CELL_LIMIT = 200

const CONTROL = /\p{Cc}|[\u2028\u2029]/gu
const escapeControl = (text: string) =>
  text.replace(CONTROL, (character) => (character === "\t" || character === "\n" || character === "\r" ? character : `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`))

/** The base of a type name: `DECIMAL(10,2)` → `DECIMAL`, `ARRAY<INT>` → `ARRAY`. */
function baseType(typeName: string | undefined): string {
  if (!typeName) return ""
  return typeName.split(/[<(]/u)[0]!.trim().toUpperCase()
}

const INTEGER = new Set(["BYTE", "TINYINT", "SHORT", "SMALLINT", "INT", "INTEGER", "LONG", "BIGINT"])
const FLOAT = new Set(["FLOAT", "DOUBLE", "REAL"])

interface Clipped {
  readonly value: string
  readonly cut: boolean
}

/** A cell's text, escaped and cut at `CELL_LIMIT`. */
export function clip(text: string): Clipped {
  const escaped = escapeControl(text)
  if (escaped.length <= CELL_LIMIT) return { value: escaped, cut: false }
  return { value: `${escaped.slice(0, CELL_LIMIT)}…[cut ${escaped.length - CELL_LIMIT} chars]`, cut: true }
}

/** One cell, from the JSON string Databricks sent to the value a model reads. */
export function cellValue(raw: unknown, typeName?: string): unknown {
  if (raw === null || raw === undefined) return null
  const text = typeof raw === "string" ? raw : String(raw)
  const base = baseType(typeName)
  if (INTEGER.has(base) && /^-?\d+$/u.test(text)) {
    const value = Number(text)
    if (Number.isSafeInteger(value)) return value
  } else if (FLOAT.has(base)) {
    if (text === "NaN" || text === "Infinity" || text === "-Infinity") return text
    const value = Number(text)
    if (Number.isFinite(value)) return value
  } else if (base === "BOOLEAN") {
    if (text === "true") return true
    if (text === "false") return false
  }
  return clip(text).value
}

export interface ShapedRows {
  readonly rows: unknown[][]
  /** At least one cell was cut at `CELL_LIMIT`. */
  readonly cellsCut: boolean
}

/** Every row, every cell, in the manifest's column order. */
export function shapeRows(rows: readonly (readonly (string | null)[])[] | undefined, columns: readonly { readonly typeName: string }[] | undefined): ShapedRows {
  const types = columns?.map((column) => column.typeName) ?? []
  let cellsCut = false
  const shaped: unknown[][] = (rows ?? []).map((row) =>
    row.map((raw, index) => {
      const value = cellValue(raw, types[index])
      // A number or a boolean is never long; a value kept as text was clipped when it did not fit.
      if (typeof value === "string" && typeof raw === "string" && clip(raw).cut) cellsCut = true
      return value
    }),
  )
  return { rows: shaped, cellsCut }
}

/**
 * Cuts rows from the end until their JSON is under `maxBytes` (design §8.1: `maxInlineBytes`, 32 KiB by default). The
 * server's caps run first (`row_limit`, `byte_limit`); this is the plugin's own, and a cut is reported in `truncated`.
 */
export function fitInline(rows: unknown[][], maxBytes: number): { readonly rows: unknown[][]; readonly bytesCut: boolean } {
  if (Buffer.byteLength(JSON.stringify(rows), "utf8") <= maxBytes) return { rows, bytesCut: false }
  let keep = rows.length
  while (keep > 0 && Buffer.byteLength(JSON.stringify(rows.slice(0, keep)), "utf8") > maxBytes) keep--
  return { rows: rows.slice(0, keep), bytesCut: true }
}
