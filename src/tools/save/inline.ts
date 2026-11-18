/**
 * The §8.1 typing for a save's `INLINE` fallback: `data_array` holds strings or null [6], and the manifest's schema says
 * what each column is. The same rules the inline reads use, except nothing is cut: a save writes the full value.
 *
 * - integers: a number when it is safe, otherwise a string;
 * - `DECIMAL`: a string, so no digit is lost;
 * - `DOUBLE`/`FLOAT`: numbers, with `NaN` and `±Infinity` as strings;
 * - `TIMESTAMP`/`TIMESTAMP_NTZ`, `DATE`, `INTERVAL`, `STRING` and `BINARY`: strings (binary as Databricks sent it);
 * - `BOOLEAN`: a boolean;
 * - `ARRAY`, `MAP`, `STRUCT` and `VARIANT`: the JSON value when it parses, else the string.
 */
import type { ResultColumn } from "../../ports.js"

export function typedCell(value: string | null, column: ResultColumn | undefined): unknown {
  if (value === null) return null
  const type = (column?.typeName ?? "STRING").toUpperCase()
  switch (type) {
    case "BYTE":
    case "SHORT":
    case "INT":
    case "LONG": {
      const number = Number(value)
      return Number.isSafeInteger(number) && String(number) === value.trim() ? number : value
    }
    case "FLOAT":
    case "DOUBLE": {
      if (value === "NaN" || value === "Infinity" || value === "-Infinity") return value
      const number = Number(value)
      return Number.isFinite(number) ? number : value
    }
    case "BOOLEAN":
      return value === "true" ? true : value === "false" ? false : value
    case "ARRAY":
    case "MAP":
    case "STRUCT":
    case "VARIANT":
      try {
        return JSON.parse(value) as unknown
      } catch {
        return value
      }
    default:
      return value
  }
}

/** One inline row as typed cells, in the manifest's column order. */
export function typedRow(values: readonly (string | null)[], columns: readonly ResultColumn[]): unknown[] {
  return values.map((value, index) => typedCell(value, columns[index]))
}
