/**
 * Databricks' typed results, as values a model can read (design §8.1).
 *
 * `INLINE` + `JSON_ARRAY` answers every non-null cell as a *string* and nulls as `null` (Statement Execution API,
 * `POST /api/2.0/sql/statements`: "When specifying format=JSON_ARRAY, result data will be formatted as an array of
 * arrays of values, where each value is either the string representation of a value, or null"). The manifest's
 * `schema.columns[i]` carries `type_name` (the base type: BOOLEAN, BYTE, SHORT, INT, LONG, FLOAT, DOUBLE, DATE,
 * TIMESTAMP, STRING, BINARY, DECIMAL, INTERVAL, ARRAY, STRUCT, MAP, CHAR, NULL, USER_DEFINED_TYPE) and `type_text`
 * (the full SQL type). `TIMESTAMP_NTZ`, `VARIANT`, `GEOMETRY`, `GEOGRAPHY` and `TABLE_TYPE` appear in Unity Catalog's
 * column types, and a warehouse returns them in `type_text`; both are read here.
 *
 * The rules are the design's, in one place:
 * - integers: a number when safe, otherwise the exact string (BIGINT beyond 2^53 loses nothing);
 * - DECIMAL: the string, exactly as sent (a decimal is exact; a float would not be);
 * - DOUBLE/FLOAT: numbers, with NaN and ±Infinity as strings (JSON has no NaN);
 * - TIMESTAMP and TIMESTAMP_NTZ: ISO 8601 (`T` separator; a zone the answer carries is kept, and a zone it leaves out
 *   stays out, because a TIMESTAMP is in the session's `TIMEZONE`, which an admin sets — inventing UTC would state a
 *   wrong instant);
 * - DATE and INTERVAL: strings; BOOLEAN: a boolean;
 * - BINARY: base64, cut to 64 characters (§8.1);
 * - ARRAY, MAP, STRUCT and VARIANT: their JSON text, cut at 200 characters (§8.1);
 * - GEOMETRY and GEOGRAPHY: the text Databricks sends, cut (`ST_AsText`'s WKT where the warehouse renders it).
 *
 * Every cell is also made safe to print (§5.8): control characters other than tab and newline are escaped, and a cut
 * cell ends in `…[cut N chars]`. A cell is data: nothing here interprets it.
 */

/** The inline cell cap, in characters (design §8.1). */
export const CELL_CHARS = 200
/** A BINARY cell's cap, in characters of base64 (design §8.1). */
export const BINARY_CHARS = 64

/** One result column's type, as the manifest gives it. */
export interface ColumnType {
  readonly typeName: string
  readonly typeText?: string
}

/**
 * The SQL base type of a column: `type_name` when it is one, otherwise the first word of `type_text`.
 *
 * TIMESTAMP_NTZ is the one type the Statement Execution manifest cannot name: its `type_name` list has TIMESTAMP but
 * no TIMESTAMP_NTZ, so a wall-clock column arrives as `type_name: "TIMESTAMP"` with `type_text: "TIMESTAMP_NTZ"`. The
 * SQL type wins there, or the zone the design says not to invent would be added to a wall-clock value.
 */
export function baseType(column: ColumnType): string {
  const name = (column.typeName || column.typeText || "").trim().toUpperCase()
  const word = name.split(/[\s(<]/u)[0] ?? ""
  const sqlWord = (column.typeText ?? "").trim().toUpperCase().split(/[\s(<]/u)[0] ?? ""
  if (sqlWord === "TIMESTAMP_NTZ" || sqlWord === "TIMESTAMPNTZ") return "TIMESTAMP_NTZ"
  // The SQL names a warehouse may put in `type_text` where the manifest's `type_name` is absent.
  const alias: Readonly<Record<string, string>> = {
    BIGINT: "LONG",
    INTEGER: "INT",
    SMALLINT: "SHORT",
    TINYINT: "BYTE",
    NUMERIC: "DECIMAL",
    REAL: "FLOAT",
    VARCHAR: "STRING",
    TEXT: "STRING",
    TIMESTAMPNTZ: "TIMESTAMP_NTZ",
    TIMESTAMPLTZ: "TIMESTAMP",
  }
  return alias[word] ?? word
}

/**
 * What a model reads, with everything that hides text escaped: C0 and C1 controls and DEL (except tab and newline),
 * the bidi marks and overrides, the zero-width characters, U+2028/U+2029 and the Unicode tag block (U+E0000–E007F, a
 * known way to smuggle instructions past a reader). Escaped, not removed: the cell stays the data it was (§5.8).
 */
export function sanitizeCell(text: string): string {
  const escape = (character: string) => {
    const code = character.codePointAt(0) ?? 0
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`
  }
  return text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, escape)
    .replace(/[\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/gu, escape)
    .replace(/[\u{e0000}-\u{e007f}]/gu, escape)
}

/** `text` cut at `limit` characters, with the design's marker; never split inside a code point. */
export function cutCell(text: string, limit: number = CELL_CHARS): string {
  const characters = Array.from(text)
  if (characters.length <= limit) return text
  return `${characters.slice(0, limit).join("")}…[cut ${characters.length - limit} chars]`
}

/** A cell as text: sanitised, then cut. */
export const textCell = (text: string, limit: number = CELL_CHARS): string => cutCell(sanitizeCell(text), limit)

const SAFE_LIMIT = BigInt(Number.MAX_SAFE_INTEGER)

/** An exact integer as a number when it is safe, otherwise the string: no digit is lost. */
function integerValue(raw: string): number | string {
  const text = raw.trim()
  if (!/^[+-]?\d+$/u.test(text)) return raw
  const magnitude = BigInt(text)
  return magnitude <= SAFE_LIMIT && magnitude >= -SAFE_LIMIT ? Number(magnitude) : text
}

/** A floating-point cell: a number, or "NaN"/"Infinity"/"-Infinity" as strings (JSON has no such numbers). */
function floatValue(raw: string): number | string {
  const text = raw.trim()
  const finite = Number(text)
  if (!Number.isFinite(finite)) return text === "NaN" ? "NaN" : text === "Infinity" || text === "+Infinity" ? "Infinity" : text === "-Infinity" ? "-Infinity" : raw
  return finite
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/u

/**
 * A timestamp as ISO 8601. A zone the answer carries is kept, normalised to `Z` or `±HH:MM`; one it leaves out stays
 * out. Databricks documents TIMESTAMP as a value "with the session local time-zone" and the session's `TIMEZONE` is
 * admin-settable, so a zone-less value is the session's wall-clock reading, not UTC — appending `Z` would state a
 * wrong instant. TIMESTAMP_NTZ is the same: a wall-clock value, never given a zone. Anything that does not look like a
 * timestamp is returned as it came. L8 records a real warehouse's rendering, with a non-UTC session `TIMEZONE`.
 */
export function isoTimestamp(raw: string): string {
  const match = TIMESTAMP.exec(raw.trim())
  if (!match) return raw
  const [, year, month, day, hour, minute, second, fraction, zone] = match
  const time = `${year}-${month}-${day}T${hour}:${minute}${second ? `:${second}` : ""}${fraction ? `.${fraction}` : ""}`
  if (!zone) return time
  return `${time}${zone === "Z" ? "Z" : zone.replace(/^([+-]\d{2})(\d{2})$/u, "$1:$2")}`
}

/**
 * One cell: `raw` is the string the Statement Execution API sent (or null), `column` its type, and the answer is what
 * the tool result carries. `null` stays `null`; everything else follows the rules in this file's header.
 */
export function cellValue(raw: string | null | undefined, column: ColumnType): unknown {
  if (raw === null || raw === undefined) return null
  const type = baseType(column)
  switch (type) {
    case "BOOLEAN":
      return raw === "true" ? true : raw === "false" ? false : textCell(raw)
    case "BINARY":
      return textCell(raw, BINARY_CHARS)
    case "TIMESTAMP":
    case "TIMESTAMP_NTZ":
      return textCell(isoTimestamp(raw))
    case "INT":
    case "LONG":
    case "SHORT":
    case "BYTE":
      return integerValue(raw)
    case "FLOAT":
    case "DOUBLE":
      return floatValue(raw)
    // DECIMAL, DATE, INTERVAL, STRING, CHAR, ARRAY, MAP, STRUCT, VARIANT, GEOMETRY, GEOGRAPHY and anything unknown:
    // the string as Databricks sent it, safe and cut.
    default:
      return textCell(raw)
  }
}

/** Every cell of a JSON_ARRAY answer, in the manifest's column order. */
export function convertRows(rows: readonly (readonly (string | null)[])[], columns: readonly ColumnType[]): unknown[][] {
  return rows.map((row) => row.map((value, index) => {
    const column = columns[index]
    return column ? cellValue(value, column) : value
  }))
}

/**
 * One row's raw value for a file (design §8.2): nested values as JSON text, null as null. A file is data, not model
 * text, so nothing is escaped or cut here — a control character in a saved CSV is the value the warehouse returned.
 */
export function cellText(raw: string | null | undefined, _column: ColumnType): string | null {
  return raw === null || raw === undefined ? null : raw
}
