/**
 * A small, pure-TypeScript Arrow IPC **stream** reader (design §8.2), enough for the `ARROW_STREAM` result chunks
 * Databricks' Statement Execution API returns [6]:
 *
 * - the stream framing: a 0xFFFFFFFF continuation, a little-endian metadata length, the FlatBuffer `Message`, then its
 *   aligned body, repeated, ended by a zero-length message (Arrow's `format/Message.fbs`, `format/Schema.fbs`,
 *   `format/File.fbs`; https://arrow.apache.org/docs/format/Columnar.html);
 * - a FlatBuffer reader for the five tables involved (`Message`, `Schema`, `Field`, `RecordBatch`, `DictionaryBatch`),
 *   since the plugin has no runtime dependency and bundles nothing from an Arrow implementation;
 * - the column types Databricks' SQL types map to: Int, FloatingPoint, Utf8, LargeUtf8, Binary, LargeBinary, Bool,
 *   Decimal, Date, Timestamp, Time, Duration, List, LargeList, Struct, Map, FixedSizeBinary and Null.
 *
 * Values come out typed as design §8.1 says: integers as numbers when safe and strings otherwise, `DECIMAL` as a
 * string, doubles as numbers with `NaN`/`±Infinity` as strings, dates and timestamps as ISO 8601, binary as base64,
 * nested values as arrays and objects. The reader never runs a statement and reads no file: it turns bytes into rows.
 *
 * It is deliberately a reader only: `save` writes the Arrow format by splicing the stream messages Databricks sent
 * (`arrowStreamOf`), not by re-encoding them.
 */

/** The schema types the reader understands; `unsupported` keeps a column readable as nulls with a warning. */
export type ArrowType =
  | { readonly kind: "int"; readonly bits: number; readonly signed: boolean }
  | { readonly kind: "float"; readonly bits: number }
  | { readonly kind: "utf8"; readonly large: boolean }
  | { readonly kind: "binary"; readonly large: boolean }
  | { readonly kind: "fixed"; readonly bytes: number }
  | { readonly kind: "bool" }
  | { readonly kind: "decimal"; readonly precision: number; readonly scale: number; readonly bits: number }
  | { readonly kind: "date"; readonly unit: string }
  | { readonly kind: "timestamp"; readonly unit: string; readonly timezone?: string }
  | { readonly kind: "time"; readonly unit: string }
  | { readonly kind: "duration"; readonly unit: string }
  | { readonly kind: "interval"; readonly unit: string }
  | { readonly kind: "list"; readonly large: boolean }
  | { readonly kind: "struct" }
  | { readonly kind: "map" }
  | { readonly kind: "null" }
  | { readonly kind: "unsupported" }

/** One field of a schema, with its children (a list's element, a struct's members, a map's entries struct). */
export interface ArrowField {
  readonly name: string
  readonly type: ArrowType
  readonly nullable: boolean
  readonly children: readonly ArrowField[]
}

/** One record batch: its row count and each top-level column's values. */
export interface ArrowBatch {
  readonly rows: number
  readonly columns: readonly (readonly unknown[])[]
}

/** A whole stream: its schema and its batches in the order the provider wrote them. */
export interface ArrowStream {
  readonly schema: readonly ArrowField[]
  readonly batches: readonly ArrowBatch[]
}

/** A refusable Arrow problem: the plugin's own wording, with the details a reader can check. */
export class ArrowProblem extends Error {}

// ── FlatBuffers ──────────────────────────────────────────────────────────

const text = new TextDecoder()

/**
 * A table at `position` in a FlatBuffer. A table starts with a signed offset to its vtable; the vtable holds the table's
 * size, then one 16-bit offset per field, `0` for a field the writer left out.
 */
class Table {
  constructor(
    private readonly bytes: Uint8Array,
    private readonly view: DataView,
    readonly position: number,
  ) {}

  field(index: number): number {
    const vtable = this.position - this.view.getInt32(this.position, true)
    const size = this.view.getUint16(vtable, true)
    const slot = 4 + index * 2
    if (slot >= size) return 0
    const offset = this.view.getUint16(vtable + slot, true)
    return offset === 0 ? 0 : this.position + offset
  }

  /** A field that holds an offset to another table, struct or vector. */
  indirect(index: number): number {
    const at = this.field(index)
    return at === 0 ? 0 : at + this.view.getInt32(at, true)
  }

  int8(index: number, fallback = 0): number {
    const at = this.field(index)
    return at === 0 ? fallback : this.view.getInt8(at)
  }

  uint8(index: number, fallback = 0): number {
    const at = this.field(index)
    return at === 0 ? fallback : this.view.getUint8(at)
  }

  int16(index: number, fallback = 0): number {
    const at = this.field(index)
    return at === 0 ? fallback : this.view.getInt16(at, true)
  }

  int32(index: number, fallback = 0): number {
    const at = this.field(index)
    return at === 0 ? fallback : this.view.getInt32(at, true)
  }

  int64(index: number, fallback = 0): number {
    const at = this.field(index)
    return at === 0 ? fallback : Number(this.view.getBigInt64(at, true))
  }

  string(index: number): string | undefined {
    const at = this.indirect(index)
    if (at === 0) return undefined
    const length = this.view.getInt32(at, true)
    return text.decode(this.bytes.subarray(at + 4, at + 4 + length))
  }

  /** A vector's length and the absolute offset of its first element (each element is a 4-byte offset for tables). */
  vector(index: number): { length: number; start: number } {
    const at = this.indirect(index)
    if (at === 0) return { length: 0, start: 0 }
    return { length: this.view.getInt32(at, true), start: at + 4 }
  }

  /** A vector of structs: each element sits inline at `start + index * stride`. */
  structAt(start: number, index: number, stride: number): Table {
    return new Table(this.bytes, this.view, start + index * stride)
  }

  /** A vector of tables: each element is a 4-byte offset from its own position. */
  tableAt(start: number, index: number): Table {
    const at = start + index * 4
    return new Table(this.bytes, this.view, at + this.view.getInt32(at, true))
  }
}

const alignment = (value: number, to: number) => (value + to - 1) & ~(to - 1)

/** One message's raw bytes and where its body starts, so the `arrow` writer can splice messages unchanged. */
interface MessageFrame {
  readonly start: number
  readonly end: number
  readonly headerType: number
  readonly bodyStart: number
  readonly bodyLength: number
}

/** Every message frame in a stream, including the end marker (`headerType: 0`). */
export function messageFrames(bytes: Uint8Array): MessageFrame[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const frames: MessageFrame[] = []
  let at = 0
  while (at + 4 <= bytes.length) {
    const first = view.getUint32(at, true)
    let prefix = 4
    let length: number
    if (first === 0xffffffff) {
      if (at + 8 > bytes.length) break
      length = view.getUint32(at + 4, true)
      prefix = 8
    } else {
      length = first
    }
    if (length === 0) {
      frames.push({ start: at, end: at + prefix, headerType: 0, bodyStart: at + prefix, bodyLength: 0 })
      at += prefix
      break
    }
    const metadataStart = at + prefix
    const headerType = messageHeaderType(bytes, metadataStart)
    const metaLength = length
    const bodyStart = metadataStart + alignment(metaLength, 8)
    const bodyLength = messageBodyLength(bytes, metadataStart)
    const end = bodyStart + bodyLength
    if (end > bytes.length) throw new ArrowProblem("an Arrow message runs past the end of the chunk")
    frames.push({ start: at, end, headerType, bodyStart, bodyLength })
    at = end
  }
  return frames
}

function messageTable(bytes: Uint8Array, metadataStart: number): Table {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const root = metadataStart + view.getInt32(metadataStart, true)
  return new Table(bytes, view, root)
}

const messageHeaderType = (bytes: Uint8Array, metadataStart: number) => messageTable(bytes, metadataStart).uint8(1, 0)
const messageBodyLength = (bytes: Uint8Array, metadataStart: number) => messageTable(bytes, metadataStart).int64(3, 0)

/**
 * The whole stream as Arrow's own schema and batches. A dictionary batch is refused: Databricks' SQL types do not use
 * dictionaries, and reading one as plain values would silently be wrong.
 */
export function readArrowStream(bytes: Uint8Array): ArrowStream {
  const frames = messageFrames(bytes)
  let schema: readonly ArrowField[] = []
  const batches: ArrowBatch[] = []
  for (const frame of frames) {
    if (frame.headerType === 0) break
    const message = messageTable(bytes, frame.start + (bytes[frame.start] === 0xff ? 8 : 4))
    const header = message.indirect(2)
    if (header === 0) throw new ArrowProblem("an Arrow message names no header")
    if (frame.headerType === 1) {
      schema = readSchema(bytes, header)
    } else if (frame.headerType === 3) {
      if (schema.length === 0) throw new ArrowProblem("an Arrow record batch came before any schema")
      batches.push(readBatch(bytes, header, frame, schema))
    } else if (frame.headerType === 2) {
      throw new ArrowProblem("an Arrow dictionary batch is not supported")
    }
  }
  return { schema, batches }
}

// ── schema ───────────────────────────────────────────────────────────────

function readSchema(bytes: Uint8Array, position: number): ArrowField[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const schema = new Table(bytes, view, position)
  if (schema.int16(0, 0) !== 0) throw new ArrowProblem("a big-endian Arrow stream is not supported")
  const fields = schema.vector(1)
  const answer: ArrowField[] = []
  const root = new Table(bytes, view, position)
  for (let index = 0; index < fields.length; index++) answer.push(readField(bytes, view, root.tableAt(fields.start, index)))
  return answer
}

function readField(bytes: Uint8Array, view: DataView, field: Table): ArrowField {
  const name = field.string(0) ?? ""
  const nullable = field.uint8(1, 0) !== 0
  const kind = field.uint8(2, 0)
  const typePosition = field.indirect(3)
  const childrenVector = field.vector(5)
  const children: ArrowField[] = []
  for (let index = 0; index < childrenVector.length; index++) children.push(readField(bytes, view, field.tableAt(childrenVector.start, index)))
  const type = typePosition === 0 ? ({ kind: "null" } as const) : readType(kind, new Table(bytes, view, typePosition))
  return { name, type, nullable, children }
}

const TIME_UNITS = ["s", "ms", "us", "ns"] as const

function readType(kind: number, type: Table): ArrowType {
  switch (kind) {
    // Int
    case 2:
      return { kind: "int", bits: type.int32(0, 32), signed: type.uint8(1, 0) !== 0 }
    // FloatingPoint: 0 = half, 1 = single, 2 = double
    case 3: {
      const precision = type.int16(0, 2)
      return { kind: "float", bits: precision === 1 ? 32 : precision === 0 ? 16 : 64 }
    }
    // Binary, Utf8, LargeBinary, LargeUtf8
    case 4:
      return { kind: "binary", large: false }
    case 5:
      return { kind: "utf8", large: false }
    case 19:
      return { kind: "binary", large: true }
    case 20:
      return { kind: "utf8", large: true }
    // Bool
    case 6:
      return { kind: "bool" }
    // Decimal
    case 7:
      return { kind: "decimal", precision: type.int32(0, 38), scale: type.int32(1, 0), bits: type.int32(2, 128) }
    // Date
    case 8:
      return { kind: "date", unit: type.int16(0, 0) === 0 ? "day" : "ms" }
    // Time
    case 9:
      return { kind: "time", unit: TIME_UNITS[type.int16(0, 1)] ?? "ms" }
    // Timestamp
    case 10:
      return { kind: "timestamp", unit: TIME_UNITS[type.int16(0, 1)] ?? "ms", ...(type.string(1) ? { timezone: type.string(1)! } : {}) }
    // Interval
    case 11:
      return { kind: "interval", unit: TIME_UNITS[type.int16(0, 0)] ?? "ms" }
    // List, LargeList, Map, FixedSizeList
    case 12:
      return { kind: "list", large: false }
    case 21:
      return { kind: "list", large: true }
    case 13:
      return { kind: "map" }
    case 16:
      return { kind: "list", large: false }
    // Struct
    case 14:
      return { kind: "struct" }
    // FixedSizeBinary
    case 15:
      return { kind: "fixed", bytes: type.int32(0, 0) }
    // Duration
    case 18:
      return { kind: "duration", unit: TIME_UNITS[type.int16(0, 1)] ?? "ms" }
    default:
      return { kind: "unsupported" }
  }
}

// ── record batches ───────────────────────────────────────────────────────

interface BatchBuffers {
  readonly body: Uint8Array
  readonly view: DataView
  readonly nodes: readonly { readonly length: number; readonly nulls: number }[]
  readonly buffers: readonly { readonly offset: number; readonly length: number }[]
}

function readBatch(bytes: Uint8Array, position: number, frame: MessageFrame, schema: readonly ArrowField[]): ArrowBatch {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const batch = new Table(bytes, view, position)
  const rows = batch.int64(0, 0)
  const nodesVector = batch.vector(1)
  const nodes: { length: number; nulls: number }[] = []
  // FieldNode and Buffer are FlatBuffer structs, laid out inline: no vtable, two 64-bit fields each.
  for (let index = 0; index < nodesVector.length; index++) {
    const at = nodesVector.start + index * 16
    nodes.push({ length: Number(view.getBigInt64(at, true)), nulls: Number(view.getBigInt64(at + 8, true)) })
  }
  const buffersVector = batch.vector(2)
  const buffers: { offset: number; length: number }[] = []
  for (let index = 0; index < buffersVector.length; index++) {
    const at = buffersVector.start + index * 16
    buffers.push({ offset: Number(view.getBigInt64(at, true)), length: Number(view.getBigInt64(at + 8, true)) })
  }
  if (frame.bodyLength > 0 && frame.bodyStart + frame.bodyLength > bytes.length) throw new ArrowProblem("an Arrow record batch's body is missing")
  const body = bytes.subarray(frame.bodyStart, frame.bodyStart + frame.bodyLength)
  const state = { body, view: new DataView(body.buffer, body.byteOffset, body.byteLength), nodes, buffers }
  const cursor = { node: 0, buffer: 0 }
  const columns = schema.map((field) => readVector(field, rows, state, cursor))
  return { rows, columns }
}

interface Cursor {
  node: number
  buffer: number
}

/** The validity bitmap's bytes for a field: the first buffer, empty when every value is present. */
function validity(state: BatchBuffers, cursor: Cursor, length: number): Uint8Array | undefined {
  const node = state.nodes[cursor.node++]
  cursor.buffer++ // the validity buffer is always present, even when its length is 0
  if (node === undefined) throw new ArrowProblem("an Arrow batch is missing a field node")
  if (node.nulls === 0) return undefined
  const buffer = state.buffers[cursor.buffer - 1]
  if (buffer === undefined || buffer.length === 0) return undefined
  return state.body.subarray(buffer.offset, buffer.offset + buffer.length)
}

const bit = (bytes: Uint8Array | undefined, index: number) => bytes === undefined || (bytes[index >> 3]! & (1 << (index & 7))) !== 0

function readVector(field: ArrowField, length: number, state: BatchBuffers, cursor: Cursor): unknown[] {
  const validityBuffer = validity(state, cursor, length)
  const values: unknown[] = new Array(length)
  const type = field.type
  const next = () => state.buffers[cursor.buffer++]
  const data = () => {
    const buffer = next()
    return buffer === undefined ? new Uint8Array(0) : state.body.subarray(buffer.offset, buffer.offset + buffer.length)
  }
  const check = (index: number) => validityBuffer === undefined || bit(validityBuffer, index)

  switch (type.kind) {
    case "int": {
      const bytes = data()
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const width = type.bits / 8
      for (let index = 0; index < length; index++) {
        if (!check(index)) continue
        values[index] = readInt(view, index * width, type.bits, type.signed)
      }
      return values
    }
    case "float": {
      const bytes = data()
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const width = type.bits / 8
      for (let index = 0; index < length; index++) {
        if (!check(index)) continue
        const value = type.bits === 32 ? view.getFloat32(index * width, true) : type.bits === 16 ? half(view.getUint16(index * width, true)) : view.getFloat64(index * width, true)
        values[index] = Number.isFinite(value) ? value : value > 0 ? "Infinity" : value < 0 ? "-Infinity" : "NaN"
      }
      return values
    }
    case "bool": {
      const bytes = data()
      for (let index = 0; index < length; index++) if (check(index)) values[index] = bit(bytes, index)
      return values
    }
    case "utf8":
    case "binary":
    case "fixed": {
      const decoder = new TextDecoder()
      const widths = type.kind === "fixed" ? type.bytes : 4
      const offsets = type.kind === "fixed" ? undefined : data()
      const offsetView = offsets === undefined ? undefined : new DataView(offsets.buffer, offsets.byteOffset, offsets.byteLength)
      const bytes = data()
      const at = (index: number) => {
        if (offsetView === undefined) return index * widths
        const value = type.kind === "binary" || type.kind === "utf8" ? offsetView.getInt32(index * 4, true) : Number(offsetView.getBigInt64(index * 8, true))
        return Number(value)
      }
      for (let index = 0; index < length; index++) {
        if (!check(index)) continue
        const start = at(index)
        const end = type.kind === "fixed" ? start + widths : at(index + 1)
        const slice = bytes.subarray(start, end)
        values[index] = type.kind === "utf8" ? decoder.decode(slice) : Buffer.from(slice).toString("base64")
      }
      return values
    }
    case "decimal": {
      const bytes = data()
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      for (let index = 0; index < length; index++) {
        if (!check(index)) continue
        values[index] = readDecimal(view, index, type.bits, type.scale)
      }
      return values
    }
    case "date": {
      const bytes = data()
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      for (let index = 0; index < length; index++) {
        if (!check(index)) continue
        values[index] = type.unit === "day" ? dayIso(view.getInt32(index * 4, true)) : new Date(Number(view.getBigInt64(index * 8, true))).toISOString()
      }
      return values
    }
    case "timestamp": {
      const bytes = data()
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      for (let index = 0; index < length; index++) {
        if (!check(index)) continue
        values[index] = timeIso(view.getBigInt64(index * 8, true), type.unit)
      }
      return values
    }
    case "time":
    case "duration": {
      const bytes = data()
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      for (let index = 0; index < length; index++) {
        if (!check(index)) continue
        const raw = type.kind === "duration" || type.unit === "us" || type.unit === "ns" ? view.getBigInt64(index * 8, true) : BigInt(view.getInt32(index * 4, true))
        values[index] = durationText(raw, type.unit)
      }
      return values
    }
    case "list": {
      const offsets = data()
      const view = new DataView(offsets.buffer, offsets.byteOffset, offsets.byteLength)
      const child = field.children[0]
      if (child === undefined) throw new ArrowProblem("an Arrow list has no element field")
      const at = (index: number) => (type.large ? Number(view.getBigInt64(index * 8, true)) : view.getInt32(index * 4, true))
      const inner = readVector(child, Math.max(0, at(length)), state, cursor)
      for (let index = 0; index < length; index++) if (check(index)) values[index] = inner.slice(at(index), at(index + 1))
      return values
    }
    case "struct": {
      const children = field.children.map((child) => readVector(child, length, state, cursor))
      for (let index = 0; index < length; index++) {
        if (!check(index)) continue
        values[index] = Object.fromEntries(field.children.map((child, position) => [child.name, children[position]![index]]))
      }
      return values
    }
    case "map": {
      const offsets = data()
      const view = new DataView(offsets.buffer, offsets.byteOffset, offsets.byteLength)
      const entries = field.children[0]
      const keyField = entries?.children[0]
      const valueField = entries?.children[1]
      if (entries === undefined || keyField === undefined || valueField === undefined) throw new ArrowProblem("an Arrow map has no entries")
      const count = length === 0 ? 0 : view.getInt32(length * 4, true)
      validity(state, cursor, count) // the entries struct's own node
      const keys = readVector(keyField, count, state, cursor)
      const mapValues = readVector(valueField, count, state, cursor)
      for (let index = 0; index < length; index++) {
        if (!check(index)) continue
        const start = view.getInt32(index * 4, true)
        const end = view.getInt32((index + 1) * 4, true)
        const object: Record<string, unknown> = {}
        for (let item = start; item < end; item++) object[String(keys[item])] = mapValues[item]
        values[index] = object
      }
      return values
    }
    case "interval": {
      // Arrow's MonthDayNano interval is a 16-byte struct; Databricks' INTERVAL arrives as such a value, shown in ISO
      // 8601 by ISO 8601's own rule (the design types INTERVAL as a string).
      const bytes = data()
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      for (let index = 0; index < length; index++) {
        if (!check(index)) continue
        const months = view.getInt32(index * 16, true)
        const days = view.getInt32(index * 16 + 4, true)
        const nanos = view.getBigInt64(index * 16 + 8, true)
        values[index] = `P${months}M${days}DT${nanos}NS`
      }
      return values
    }
    case "null":
      return values
    default:
      return values
  }
}

function readInt(view: DataView, offset: number, bits: number, signed: boolean): number | string {
  switch (bits) {
    case 64: {
      const value = view.getBigInt64(offset, true)
      return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString()
    }
    case 32:
      return signed ? view.getInt32(offset, true) : view.getUint32(offset, true)
    case 16:
      return signed ? view.getInt16(offset, true) : view.getUint16(offset, true)
    case 8:
      return signed ? view.getInt8(offset) : view.getUint8(offset)
    default:
      return view.getUint8(offset)
  }
}

function half(value: number): number {
  const sign = value & 0x8000 ? -1 : 1
  const exponent = (value >> 10) & 0x1f
  const fraction = value & 0x3ff
  if (exponent === 0) return sign * fraction * 2 ** -24
  if (exponent === 31) return fraction === 0 ? sign * Infinity : NaN
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15)
}

function readDecimal(view: DataView, index: number, bits: number, scale: number): string {
  const width = bits / 8
  const offset = index * width
  const value = bits === 128 ? (view.getBigInt64(offset, true) << 64n) | BigInt(view.getBigUint64(offset + 8, true)) : bits === 32 ? BigInt(view.getInt32(offset, true)) : view.getBigInt64(offset, true)
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0")
  const whole = digits.slice(0, digits.length - scale)
  const part = scale === 0 ? "" : `.${digits.slice(digits.length - scale)}`
  return `${negative ? "-" : ""}${whole}${part}`
}

function dayIso(days: number): string {
  return new Date(days * 86_400_000).toISOString().slice(0, 10)
}

function timeIso(value: bigint, unit: string): string {
  const ms = unit === "s" ? value * 1000n : unit === "us" ? value / 1000n : unit === "ns" ? value / 1_000_000n : value
  return new Date(Number(ms)).toISOString()
}

function durationText(value: bigint, unit: string): string {
  const divisors: Record<string, bigint> = { s: 1n, ms: 1000n, us: 1_000_000n, ns: 1_000_000_000n }
  const divisor = divisors[unit] ?? 1n
  const seconds = (value / divisor).toString()
  const fraction = value % divisor
  return fraction === 0n ? `${seconds}s` : `${seconds}.${fraction.toString().padStart(unit.length === 2 ? 3 : 6, "0")}s`
}

/** One stream whose schema and record-batch messages are the ones Databricks sent, spliced for the `arrow` format. */
export function arrowStreamOf(chunks: readonly Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = []
  let schemaTaken = false
  for (const chunk of chunks) {
    const frames = messageFrames(chunk)
    for (const frame of frames) {
      if (frame.headerType === 0) continue
      if (frame.headerType === 1) {
        if (schemaTaken) continue
        schemaTaken = true
      }
      parts.push(chunk.subarray(frame.start, frame.end))
    }
  }
  parts.push(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00]))
  const total = parts.reduce((size, part) => size + part.length, 0)
  const answer = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    answer.set(part, offset)
    offset += part.length
  }
  return answer
}

/** How many rows a stream holds, from its record-batch headers, without decoding any value. */
export function streamRowCount(bytes: Uint8Array): number {
  let rows = 0
  for (const frame of messageFrames(bytes)) {
    if (frame.headerType !== 3) continue
    const message = messageTable(bytes, frame.start + (bytes[frame.start] === 0xff ? 8 : 4))
    const header = message.indirect(2)
    if (header !== 0) rows += new Table(bytes, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), header).int64(0, 0)
  }
  return rows
}

/** The top-level column names and Arrow types of a stream, for the writers' schema. */
export function columnsOf(stream: ArrowStream): { name: string; type: ArrowType }[] {
  return stream.schema.map((field) => ({ name: field.name, type: field.type }))
}
