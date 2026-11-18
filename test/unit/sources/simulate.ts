// A consumer over a moving clock: every `every` ms it reads a source until `more: false`, and the run records what was
// listed (with repeats), when, every gap, the pages, the provider calls and the longest cursor. No network.
import type { Deps } from "../../../src/registry.js"
import { eventsPage, LAG_MS } from "../../../src/sources/events.js"
import { call } from "./harness.js"

const iso = (ms: number) => new Date(ms).toISOString()

export interface Consumed {
  /** Each listed id (the provider id, after the host), with how many times it was listed. */
  readonly listed: Map<string, number>
  /** When each id was first listed. */
  readonly listedAt: Map<string, number>
  readonly gaps: { readonly at: number; readonly reason: string; readonly since: string }[]
  readonly pages: number
  readonly reads: number
  readonly maxCursor: number
  /** The clock at the last read. */
  readonly lastRead: number
  /** The most pages one read took. */
  readonly maxPagesPerRead: number
}

export interface ConsumeOptions {
  readonly source: "queries" | "runs"
  readonly since: number
  readonly reads: number
  readonly every: number
  readonly limit?: number
  readonly scope?: Readonly<Record<string, readonly string[]>>
  readonly onRead?: (now: number) => void
  /** Pages one read may take before the simulation calls it stuck. */
  readonly pagesPerRead?: number
  /** Start from this cursor instead of `since`. */
  readonly cursor?: string
}

export async function consume(deps: Deps, options: ConsumeOptions): Promise<Consumed & { readonly cursor?: string }> {
  const clock = deps.clock as unknown as { now(): number; advance(ms: number): void }
  let cursor = options.cursor
  const listed = new Map<string, number>()
  const listedAt = new Map<string, number>()
  const gaps: { at: number; reason: string; since: string }[] = []
  let pages = 0
  let maxCursor = 0
  let lastRead = clock.now()
  let maxPagesPerRead = 0
  for (let read = 0; read < options.reads; read++) {
    if (read > 0) clock.advance(options.every)
    lastRead = clock.now()
    options.onRead?.(lastRead)
    let pagesThisRead = 0
    for (;;) {
      if (pagesThisRead >= (options.pagesPerRead ?? 2000)) throw new Error(`a read at ${iso(lastRead)} took more than ${pagesThisRead} pages`)
      const page = await eventsPage(deps, {
        account: "work",
        source: options.source,
        ...(cursor === undefined ? { since: iso(options.since) } : { cursor }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.scope === undefined ? {} : { scope: options.scope }),
        call: call(`r${read}p${pagesThisRead}`),
      })
      pages += 1
      pagesThisRead += 1
      for (const event of page.events) {
        const id = event.external_id.slice(event.external_id.lastIndexOf(":") + 1)
        listed.set(id, (listed.get(id) ?? 0) + 1)
        if (!listedAt.has(id)) listedAt.set(id, lastRead)
      }
      if (page.gap) gaps.push({ at: lastRead, reason: page.gap.reason, since: page.gap.since })
      cursor = page.cursor
      maxCursor = Math.max(maxCursor, page.cursor.length)
      if (!page.more) break
    }
    maxPagesPerRead = Math.max(maxPagesPerRead, pagesThisRead)
  }
  return { listed, listedAt, gaps, pages, reads: options.reads, maxCursor, lastRead, maxPagesPerRead, ...(cursor === undefined ? {} : { cursor }) }
}

/** The ids that ended early enough to be owed by the last read, and that were not listed. */
export function missing(consumed: Consumed, items: readonly { readonly id: string; readonly end?: number }[], since: number): string[] {
  return items.filter((item) => item.end !== undefined && item.end >= since && item.end <= consumed.lastRead - LAG_MS && !consumed.listed.has(item.id)).map((item) => item.id)
}

export const repeats = (consumed: Consumed): string[] => [...consumed.listed].filter(([, count]) => count > 1).map(([id]) => id)

/** A small seeded generator (mulberry32), so every simulation is the same run every time. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}
