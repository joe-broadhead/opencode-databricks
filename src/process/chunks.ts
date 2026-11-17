/**
 * Paging a statement's result.
 *
 * A `StatementResponse` carries the first chunk: `result.data_array` for `INLINE` (JSON_ARRAY), or
 * `result.external_links` for `EXTERNAL_LINKS`. `result.next_chunk_index` names the next one, and
 * `GET /api/2.0/sql/statements/{statement_id}/result/chunks/{chunk_index}` answers each following chunk in the same
 * shape, with its own `next_chunk_index` (Statement Execution API, "Get result chunk by index"). The manifest's
 * `total_chunk_count` is a second, independent bound: this walk stops at either.
 *
 * The first chunk is already in the answer the submit or poll returned, so it is yielded without a request; only the
 * following chunks cost one. A chunk index seen twice ends the walk with `UNAVAILABLE` rather than looping, and with no
 * `next_chunk_index` the walk ends after the chunk it names.
 */
import { DatabricksError } from "../domain/errors.js"
import type { ChunkAnswer, ExternalLink, StatementAnswer } from "../ports.js"

/** What a chunk walk needs: the chunk endpoint, and nothing else. */
export interface ChunkSource {
  getChunk(account: string, statementId: string, chunkIndex: number, signal: AbortSignal): Promise<ChunkAnswer>
}

export interface ResultChunk {
  /** The chunk's position in the result set, from 0. */
  readonly chunkIndex: number
  /** `INLINE`: the chunk's cells, strings or null. */
  readonly rows: readonly (readonly (string | null)[])[]
  /** `EXTERNAL_LINKS`: the chunk's link, whose URL carries credentials. */
  readonly links: readonly ExternalLink[]
  /** The next chunk to fetch, or undefined when this was the last. */
  readonly nextChunkIndex?: number
}

/** The first chunk, which the submit or poll answer already carries (its index is 0). */
export function firstChunk(answer: StatementAnswer): ResultChunk {
  return {
    chunkIndex: 0,
    rows: answer.rows ?? [],
    links: answer.links ?? [],
    ...(answer.nextChunkIndex !== undefined ? { nextChunkIndex: answer.nextChunkIndex } : {}),
  }
}

/** A chunk the chunk endpoint answered, in its own top-level shape. */
export function chunkOf(answer: ChunkAnswer): ResultChunk {
  return {
    chunkIndex: answer.chunkIndex,
    rows: answer.rows ?? [],
    links: answer.links ?? [],
    ...(answer.nextChunkIndex !== undefined ? { nextChunkIndex: answer.nextChunkIndex } : {}),
  }
}

/**
 * Every chunk of a result, the first one included. `first` is the answer the caller already holds; each later chunk is
 * fetched from `source`. The generator never runs past the last chunk, and a repeated index fails `UNAVAILABLE`.
 */
export async function* resultChunks(source: ChunkSource, account: string, statementId: string, first: StatementAnswer, signal: AbortSignal): AsyncGenerator<ResultChunk> {
  const total = first.manifest?.totalChunkCount
  const seen = new Set<number>()
  let index = 0
  let chunk = firstChunk(first)
  for (;;) {
    if (seen.has(index)) throw new DatabricksError("UNAVAILABLE", `Databricks named chunk ${index} twice; the result cannot be paged.`, "Run the query again.")
    const next = chunk.nextChunkIndex
    const empty = chunk.rows.length === 0 && chunk.links.length === 0
    // An empty chunk while the result says more exist is a lost answer, not a finished result: a wrong shape read
    // would silently cut the tail off a save.
    if (empty && (next !== undefined || (total !== undefined && index + 1 < total))) {
      throw new DatabricksError("UNAVAILABLE", `Chunk ${index} answered no rows and no links, though the result has more chunks.`, "Run the query again.")
    }
    seen.add(index)
    yield chunk
    if (next === undefined) return
    if (!Number.isInteger(next) || next < 0) throw new DatabricksError("RESULTS_EXPIRED", "Databricks named a result chunk that does not exist.", "Run the query again.")
    if (total !== undefined && next >= total) return
    chunk = chunkOf(await source.getChunk(account, statementId, next, signal))
    index = next
  }
}

/** The whole result's chunks, in order (for a caller that writes a file rather than streaming it). */
export async function collectChunks(source: ChunkSource, account: string, statementId: string, first: StatementAnswer, signal: AbortSignal): Promise<ResultChunk[]> {
  const chunks: ResultChunk[] = []
  for await (const chunk of resultChunks(source, account, statementId, first, signal)) chunks.push(chunk)
  return chunks
}
