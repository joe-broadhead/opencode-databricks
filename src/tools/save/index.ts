/**
 * `databricks_save` (design §4, §8.2): run one read through the shared read path, ask for its full result as an Arrow
 * stream over external links, and write it beside the target file, then rename it into place. The formats are CSV,
 * JSONL, Parquet and Arrow, ready for `charts_quick({ data: { path } })`.
 *
 * What the design fixes and this file does:
 *
 * 1. the same read path and the same wrapped text as `databricks_query`, so an unchanged query is served from the
 *    result cache [23]; `EXTERNAL_LINKS` + `ARROW_STREAM`, `byte_limit = maxSaveBytes` [6];
 * 2. a link is downloaded with no `Authorization` header, and only from the cloud's storage hosts (§8.2 step 2), or
 *    `EXTERNAL_LINK_REFUSED`; `fetchLink` is package B's, which checks the host again;
 * 3. an expired link is re-read from the chunk index [6];
 * 4. links that are disabled or unreachable fall back to `INLINE` + `JSON_ARRAY`, with `SAVE_INLINE_FALLBACK`;
 * 5. chunks stream through the bundled Arrow reader into a temporary file beside the target, sha256 computed on the way,
 *    then renamed into place: one chunk is decoded and written before the next is fetched, so a million rows do not sit
 *    in memory;
 * 6. `SAVE_LIMIT` (rows or bytes) removes the partial file;
 * 7. the result carries `charts: { path, format, rows, fitsCharts }`.
 */
import { createHash } from "node:crypto"
import { closeSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs"
import { dirname } from "node:path"
import { chargeStatement } from "../../guards/budget.js"
import { sizeOf } from "../../guards/warehouse.js"
import { DatabricksError, WARNINGS } from "../../domain/errors.js"
import { bytesOf } from "../../options.js"
import type { ExternalLink, ResultColumn, StatementAnswer, StatementRequest } from "../../ports.js"
import { assertTool, type Deps } from "../../registry.js"
import type { Call, Handler } from "../../tool-spec.js"
import { accountOf, failureOf, queryTags, warehouseUse } from "../reads/context.js"
import { columnsOf, messageFrames, readArrowStream, streamRowCount, type ArrowType } from "./arrow.js"
import { csvLine, fitsCharts, jsonLine } from "./formats.js"
import { typedRow } from "./inline.js"
import { assertLinkHost, linkExpired, readLink } from "./links.js"
import { ParquetWriter, parquetCell, parquetTypeOf } from "./parquet.js"
import { assertEdit, folderIsReal, openTemporary, resolveTarget, type SaveFormat } from "./paths.js"

const INLINE_LIMIT = 25 * 1024 * 1024

/** Links are disabled or unreachable: the design's documented fallback to INLINE + JSON_ARRAY. */
class LinkUnavailable extends Error {}

type Column = { readonly name: string; readonly type: ArrowType }

/** One chunk of a result as the writer receives it. */
interface Payload {
  readonly chunkIndex: number
  readonly links?: readonly ExternalLink[]
  readonly rows?: readonly (readonly (string | null)[])[]
}

/** One attempt: the statement's answer, and its chunks as a lazy sequence. */
interface Attempt {
  readonly answer: StatementAnswer
  readonly manifestColumns: readonly ResultColumn[]
  readonly payloads: AsyncGenerator<Payload>
}

const save: Handler<"save"> = async (input, call, deps) => {
  const account = accountOf(input, deps)
  await assertTool("save", account, call, deps)
  const format = input.format ?? "csv"
  const limits = { maxRows: deps.options.maxSaveRows, maxBytes: bytesOf(deps.options.maxSaveBytes) }
  const parameters = input.params?.length
    ? input.params.map((param) => ({ name: param.name, value: param.value === null ? null : String(param.value), ...(param.type ? { type: param.type } : {}) }))
    : undefined
  const prepared = await deps.reads.prepare(
    {
      account,
      sql: input.sql,
      ...(parameters ? { params: parameters } : {}),
      ...(input.warehouse ? { warehouse: input.warehouse } : {}),
      ...(input.catalog ? { catalog: input.catalog } : {}),
      ...(input.schema ? { schema: input.schema } : {}),
      ...(input.start === undefined ? {} : { start: input.start }),
      tool: "save",
      sessionID: call.sessionID,
      messageID: call.messageID,
      callID: call.id,
    },
    call.signal,
  )

  // An explicit path is checked and its `edit` permission asked for before the statement runs; a default name needs the
  // statement id, so it is checked after the submit and before the first byte is written.
  const explicit = input.path ? resolveTarget({ ...(input.path ? { path: input.path } : {}), format, statementId: "pending", ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite }) }, deps) : undefined
  if (explicit) await assertEdit(explicit, call, deps)

  const warnings = [...prepared.warnings]
  const run = async (inline: boolean, target: string | undefined): Promise<{ target: string; rows: number; bytes: number; sha256: string; statementId: string }> => {
    const attempt = await submitAndWait(deps, {
      account,
      call,
      prepared,
      ...(parameters ? { parameters } : {}),
      ...(input.catalog ? { catalog: input.catalog } : {}),
      ...(input.schema ? { schema: input.schema } : {}),
      byteLimit: inline ? INLINE_LIMIT : limits.maxBytes,
      inline,
    })
    let path = target
    if (!path) {
      path = resolveTarget({ format, statementId: attempt.answer.statementId, ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite }) }, deps)
      await assertEdit(path, call, deps)
    }
    const written = await write(path, format, attempt, { account, call, deps, limits })
    return { target: path, ...written, statementId: attempt.answer.statementId }
  }

  let written: Awaited<ReturnType<typeof run>>
  try {
    written = await run(false, explicit)
  } catch (error) {
    if (!(error instanceof LinkUnavailable)) throw error
    warnings.push({ code: "SAVE_INLINE_FALLBACK", message: WARNINGS.SAVE_INLINE_FALLBACK })
    written = await run(true, explicit)
  }

  const fit = fitsCharts(format, written.rows, written.bytes)
  return {
    state: "ok",
    trust: "untrusted" as const,
    path: written.target,
    format,
    rows: written.rows,
    bytes: written.bytes,
    sha256: written.sha256,
    statementId: written.statementId,
    // This call's own cost: the warehouse it ran on, whether this call started it, and its estimated $/hour.
    warehouse: warehouseUse(prepared, deps),
    charts: { path: written.target, format, rows: written.rows, fitsCharts: fit },
    ...(warnings.length ? { warnings } : {}),
    ...(fit
      ? {}
      : {
          next: `charts_quick does not read ${format} files${format === "arrow" ? "" : " at this size"}; save it as csv, jsonl or parquet under 100,000 rows and 32 MB to chart it.`,
        }),
  }
}

interface SubmitInput {
  readonly account: string
  readonly call: Call
  readonly prepared: Awaited<ReturnType<Deps["reads"]["prepare"]>>
  readonly parameters?: readonly { readonly name: string; readonly value: string | null; readonly type?: string }[]
  readonly catalog?: string
  readonly schema?: string
  readonly byteLimit: number
  readonly inline: boolean
}

/** Submit, wait for a terminal state, then yield the answer's chunk and every chunk the index follows. */
async function submitAndWait(deps: Deps, input: SubmitInput): Promise<Attempt> {
  const request: StatementRequest = {
    account: input.account,
    operation: "sql.statements.query",
    statement: input.prepared.sent,
    warehouseId: input.prepared.warehouseId,
    ...(input.catalog ? { catalog: input.catalog } : {}),
    ...(input.schema ? { schema: input.schema } : {}),
    ...(input.parameters?.length ? { parameters: input.parameters } : {}),
    byteLimit: input.byteLimit,
    disposition: input.inline ? "INLINE" : "EXTERNAL_LINKS",
    format: input.inline ? "JSON_ARRAY" : "ARROW_STREAM",
    waitTimeout: 50,
    onWaitTimeout: "CONTINUE",
    queryTags: queryTags("save", input.call, { oc_save: input.inline ? "inline" : "links" }),
  }
  const startedAt = deps.clock.now()
  let answer = await deps.databricks.submit(request, input.call.signal)
  if (answer.ambiguous) throw new DatabricksError("UNAVAILABLE", "The submit got no answer, so the statement may have run.", "Check databricks_history({}) before calling again; the plugin never retries a submit that may have reached the server.")
  if (answer.state === "PENDING" || answer.state === "RUNNING") {
    answer = await deps.databricks.waitForStatement(input.account, answer.statementId, { untilMs: deps.clock.now() + deps.options.maxRunSeconds * 1000 }, input.call.signal)
  }
  const durationMs = Math.max(0, deps.clock.now() - startedAt)
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
  if (answer.state !== "SUCCEEDED") {
    const failure = failureOf(answer, 50)
    if (failure) throw failure
    throw new DatabricksError("RUN_TIMEOUT", "The statement did not finish within maxRunSeconds, so the call stopped waiting.", "Narrow the query, or raise maxRunSeconds.")
  }
  const manifestColumns = answer.manifest?.columns ?? []
  const first: Payload = { chunkIndex: 0, ...(answer.links?.length ? { links: answer.links } : {}), ...(answer.rows ? { rows: answer.rows } : {}) }
  if (first.links === undefined && first.rows === undefined) {
    // No links although links were asked for, or nothing at all: the inline fallback is the design's answer.
    throw new LinkUnavailable()
  }
  const payloads = (async function* (): AsyncGenerator<Payload> {
    yield first
    let next = answer.nextChunkIndex
    let guard = 0
    while (next !== undefined) {
      if (++guard > 10_000) throw new DatabricksError("UNAVAILABLE", "The result has more chunks than this version follows.")
      const chunk = await deps.databricks.getChunk(input.account, answer.statementId, next, input.call.signal)
      if (input.inline) {
        if (chunk.rows) yield { chunkIndex: next, rows: chunk.rows }
      } else if (chunk.links?.length) {
        yield { chunkIndex: next, links: chunk.links }
      } else {
        throw new LinkUnavailable()
      }
      next = chunk.nextChunkIndex
    }
  })()
  return { answer, manifestColumns, payloads }
}

interface WriteLimits {
  readonly maxRows: number
  readonly maxBytes: number
}

/** Write the payloads to the target through a temporary file, computing sha256 as it goes. */
async function write(
  target: string,
  format: SaveFormat,
  attempt: Attempt,
  context: { readonly account: string; readonly call: Call; readonly deps: Deps; readonly limits: WriteLimits },
): Promise<{ rows: number; bytes: number; sha256: string }> {
  const { account, call, deps, limits } = context
  mkdirSync(dirname(target), { recursive: true })
  // The folder was checked as a real path; a link put on the way since then is refused rather than followed.
  if (!folderIsReal(target)) throw new DatabricksError("SAVE_PATH_REFUSED", "The save folder changed into a link after it was checked.", "Save again, under a folder that is not a link.")
  const temp = `${target}.${deps.clock.uuid()}.tmp`
  let fd = openTemporary(temp)
  const hash = createHash("sha256")
  let rows = 0
  const sink = (bytes: Uint8Array) => {
    writeSync(fd, bytes)
    hash.update(bytes)
  }
  const cap = () => {
    if (rows > limits.maxRows) throw new DatabricksError("SAVE_LIMIT", `The result is over maxSaveRows (${limits.maxRows}) rows; the partial file was removed.`, "Aggregate or filter the query, or raise maxSaveRows.")
    if (statSync(temp).size > limits.maxBytes) throw new DatabricksError("SAVE_LIMIT", `The result is over maxSaveBytes (${limits.maxBytes}); the partial file was removed.`, "Filter or aggregate the query, or raise maxSaveBytes.")
  }
  let writeRow: (values: readonly unknown[]) => void = () => undefined
  let finish: () => void = () => undefined
  let opened = false
  const open = (fields: readonly Column[]) => {
    opened = true
    if (format === "csv") {
      sink(new TextEncoder().encode(csvLine(fields.map((field) => field.name))))
      writeRow = (values) => {
        sink(new TextEncoder().encode(csvLine(values)))
        rows += 1
      }
      return
    }
    if (format === "jsonl") {
      const names = fields.map((field) => field.name)
      writeRow = (values) => {
        sink(new TextEncoder().encode(jsonLine(names, values)))
        rows += 1
      }
      return
    }
    if (format === "parquet") {
      const parquet = new ParquetWriter(sink, fields.map((field) => ({ name: field.name, type: parquetTypeOf(field.type) })))
      writeRow = (values) => {
        parquet.write([values.map(parquetCell)])
        rows += 1
      }
      finish = () => parquet.finish()
      return
    }
    throw new DatabricksError("UNAVAILABLE", "The Arrow writer was opened without a stream.")
  }

  try {
    let columns: readonly Column[] = attempt.manifestColumns.map((column) => ({ name: column.name, type: inlineArrowType(column.typeName) }))
    let schemaWritten = false
    const cloud = deps.auth.account(account).cloud
    for await (const payload of attempt.payloads) {
      if (payload.rows) {
        if (format === "arrow") {
          throw new DatabricksError("UNAVAILABLE", "The result came inline, and the arrow format is written only from Databricks' own Arrow chunks.", "Save it as csv, jsonl or parquet, or ask an admin to enable external links for the workspace.")
        }
        if (!opened) open(columns)
        for (const values of payload.rows) {
          writeRow(typedRow(values, attempt.manifestColumns))
          if (rows % 4096 === 0) cap()
        }
        cap()
        continue
      }
      for (const link of payload.links ?? []) {
        assertLinkHost(cloud, link.url)
        const bytes = await bytesOfLink(deps, account, call, link, attempt.answer.statementId, payload.chunkIndex)
        if (format === "arrow") {
          let any = false
          for (const frame of messageFrames(bytes)) {
            if (frame.headerType === 0) continue
            if (frame.headerType === 1 && schemaWritten) continue
            if (frame.headerType === 1) schemaWritten = true
            any = true
            sink(bytes.subarray(frame.start, frame.end))
          }
          if (!any) continue
          rows += streamRowCount(bytes)
          cap()
          continue
        }
        const stream = readArrowStream(bytes)
        columns = columnsOf(stream)
        if (!opened) open(columns)
        for (const batch of stream.batches) {
          for (let row = 0; row < batch.rows; row++) {
            writeRow(batch.columns.map((column) => column[row]))
            if (rows % 4096 === 0) cap()
          }
        }
        cap()
      }
    }
    if (format === "arrow") {
      if (!schemaWritten) throw new DatabricksError("UNAVAILABLE", "Databricks returned no Arrow chunks for the result.")
      sink(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]))
    } else {
      if (!opened) throw new DatabricksError("UNAVAILABLE", "Databricks returned no rows and no columns for the result.")
      finish()
    }
    closeSync(fd)
    fd = -1
    const bytes = statSync(temp).size
    if (bytes > limits.maxBytes) throw new DatabricksError("SAVE_LIMIT", `The result is over maxSaveBytes (${limits.maxBytes}); the partial file was removed.`, "Filter or aggregate the query, or raise maxSaveBytes.")
    const sha256 = hash.digest("hex")
    renameSync(temp, target)
    return { rows, bytes, sha256 }
  } catch (error) {
    if (fd >= 0) closeSync(fd)
    if (existsSync(temp)) rmSync(temp, { force: true })
    throw error
  }
}

/** One link's bytes: an expired or failed link is re-read once from the chunk index; a wrong host is refused. */
async function bytesOfLink(deps: Deps, account: string, call: Call, link: ExternalLink, statementId: string, chunkIndex: number): Promise<Uint8Array> {
  const fresh = async (): Promise<ExternalLink | undefined> => {
    try {
      const chunk = await deps.databricks.getChunk(account, statementId, link.chunkIndex ?? chunkIndex, call.signal)
      return chunk.links?.[0]
    } catch {
      return undefined
    }
  }
  if (linkExpired(link, deps.clock.now())) {
    const again = await fresh()
    if (!again) throw new LinkUnavailable()
    try {
      return await readLink(deps.databricks, account, again, call.signal)
    } catch {
      throw new LinkUnavailable()
    }
  }
  try {
    return await readLink(deps.databricks, account, link, call.signal)
  } catch (error) {
    if (error instanceof DatabricksError && error.code === "EXTERNAL_LINK_REFUSED") throw error
    const again = await fresh()
    if (!again) throw new LinkUnavailable()
    try {
      return await readLink(deps.databricks, account, again, call.signal)
    } catch (again2) {
      if (again2 instanceof DatabricksError && again2.code === "EXTERNAL_LINK_REFUSED") throw again2
      throw new LinkUnavailable()
    }
  }
}

/** An inline column's Arrow type from its SQL type name, for the writers' schema. */
function inlineArrowType(typeName: string): ArrowType {
  switch (typeName.toUpperCase()) {
    case "BOOLEAN":
      return { kind: "bool" }
    case "BYTE":
      return { kind: "int", bits: 8, signed: true }
    case "SHORT":
      return { kind: "int", bits: 16, signed: true }
    case "INT":
      return { kind: "int", bits: 32, signed: true }
    case "LONG":
      return { kind: "int", bits: 64, signed: true }
    case "FLOAT":
      return { kind: "float", bits: 32 }
    case "DOUBLE":
      return { kind: "float", bits: 64 }
    case "DATE":
      return { kind: "date", unit: "day" }
    case "TIMESTAMP":
      return { kind: "timestamp", unit: "us" }
    default:
      return { kind: "utf8", large: false }
  }
}

export default save
