/**
 * The two event sources' cursor (the contract's `cursor`): a version 2 bound cursor, so another plugin's, source's,
 * account's or scope's cursor is `CURSOR_INVALID` before anything is read. The state is this plugin's own and is never
 * shown. It describes **what has been listed by end time, and where unlisted items can still be**, never a set of every
 * id listed (a hash set overflows under ordinary load, which is what the first design did):
 *
 * - `e`, `k`: the **listing line**. Every final item whose `(end, external_id)` is at or before `(e, k)` has been listed
 *   (or was covered by a gap). `k` is the external id of the last item listed at `e` when a page was cut there; without
 *   `k` every item ending at `e` is listed. Ties at one millisecond are walked by external id, so the order is total.
 * - `l`: the **running floor**. Every item still running at the last full page, behind the line and not in `z`,
 *   started at or after `l`. A statement or run that started long before it finished is found again by scanning from
 *   `l` by start time, the only filter both APIs have.
 * - `z`: the **tracked ids**: items not yet listed that would otherwise hold the line back or cost too much to re-walk
 *   to, read back by id (Query History's `statement_ids` filter, Jobs' `runs/get`): a running one on every full page,
 *   a finished one whose end is kept (`@` and base36, relative to `t`) once it is due. Statement ids as 16 bytes of base64url, run ids
 *   sorted and delta-encoded in base36, joined by `.`; at most `Z_CHARS` characters. An id is admitted only if the set
 *   still fits with every entry marked finished, so the set never has to shrink: an end that no longer fits is dropped
 *   (the item is then read back on every full page), never the id.
 * - `n`: the **finished floor**: every finished item not yet listed (and not in `z`) started at or after `n`. A page
 *   cut by `limit` leaves a few of them just behind the line.
 * - `m`: the **visibility line** of the last full page: nothing that was still running behind the line then can be
 *   final, visibly, before `m`. A page whose slice ends before `m` reads `[n, t]` alone, so a backlog is read once,
 *   slice by slice, instead of re-reading everything behind the line for every page.
 * - `d`: the **slice width**: the next slice ends at `e + d`, sized to what a page took or to half a walk.
 * - `t`: when tracked running items were last read back: a tracked item seen running then and found final with an end more than
 *   `HOLD_MAX_MS` before it proves Databricks showed a final state later than the line waits.
 * - `r`: where the line first passed an untracked item still shown running since the last lag gap, and the hold then:
 *   a proven lag answers a gap only if such a release happened under a hold shorter than that lag.
 * - `h`: a hold widened by a lag episode (to the lag seen plus a margin, at most `HOLD_CAP_MS`), and when the lag was
 *   last seen: the line then waits that long, so the episode loses nothing more; it narrows a day after the last proof.
 * - `g`: 1 when this read (pages up to `more: false`) already answered a gap, so it is not answered again.
 *
 * Worst case: `Z_CHARS` (320) of tracked items, `K_CHARS` (240) of external id, the numbers, the lag state and the
 * binding stay under the contract's 1,024-character bound.
 */
import { MAX_CURSOR_LENGTH, canonicalScope, decodeBoundCursor, encodeBoundCursor, type Scope } from "@we-the-rebel-alliance/plugin-contract/cursor"
import { NAMESPACE } from "../../constants.js"
import { sourceError } from "./errors.js"

/** The tracked ids' budget, in characters of the packed string. */
export const Z_CHARS = 320
/** The listing line's external-id budget, so the cursor stays under its 1,024-character bound. */
export const K_CHARS = 240
export const HASH_BYTES = 6

export interface CursorState {
  /** The listing line, ms. */
  e: number
  /** The external id of the last item listed at `e`; absent: every item ending at `e` is listed. */
  k?: string
  /** The scan floor, ms. */
  l: number
  /** The finished floor, ms. */
  n?: number
  /** The visibility line of the last full page, ms. */
  m?: number
  /** The tracked ids, packed. */
  z?: string
  /** The slice width, ms. */
  d?: number
  /** When the last full page read, ms (for the lag check). */
  t?: number
  /** Where the line first passed an untracked running item since the last lag gap, and the hold then (ms). */
  r?: { readonly at: number; readonly hold: number }
  /** A hold widened by a lag episode, and when the lag was last seen (ms). */
  h?: { readonly hold: number; readonly seen: number }
  /** This read already answered a gap. */
  g?: 1
}

/** The cursor's binding: this plugin, one source, one account, and the scope the person confirmed. */
export interface Binding {
  readonly plugin: string
  readonly source: string
  readonly account: string
  readonly scope?: Scope
}

export const bindingOf = (source: string, account: string, scope: Scope | undefined): Binding => ({
  plugin: NAMESPACE,
  source,
  account,
  ...(scope === undefined ? {} : { scope: canonicalScope(scope) }),
})

export function encodeState(binding: Binding, state: CursorState): string {
  if (state.k !== undefined && (state.k.length === 0 || state.k.length > K_CHARS || !state.k.includes(":"))) {
    throw sourceError("UNAVAILABLE", "The read's position did not fit in a cursor.", "Start again with since.")
  }
  const plain: Record<string, unknown> = { e: state.e, l: state.l }
  if (state.k !== undefined) plain.k = state.k
  if (state.n !== undefined) plain.n = state.n
  if (state.m !== undefined) plain.m = state.m
  if (state.z) plain.z = state.z
  if (state.d !== undefined) plain.d = state.d
  if (state.t !== undefined) plain.t = state.t
  // Both pairs as one short string each: the cursor's budget is tight.
  if (state.r !== undefined) plain.r = `${state.r.at.toString(36)}.${Math.round(state.r.hold / 60_000).toString(36)}`
  if (state.h !== undefined) plain.h = `${Math.round(state.h.hold / 60_000).toString(36)}.${Math.round(state.h.seen / 1000).toString(36)}`
  if (state.g === 1) plain.g = 1
  try {
    return encodeBoundCursor(binding, plain)
  } catch {
    // The state is bounded by construction (`Z_CHARS`), so this is a bug in this source, not in the person's call.
    throw sourceError("UNAVAILABLE", "The read's position did not fit in a cursor.", "Start again with since.")
  }
}

export type Decoded = { readonly ok: true; readonly state: CursorState } | { readonly ok: false; readonly code: "CURSOR_INVALID"; readonly what: string }

/** Two base36 numbers joined by `.`, scaled; undefined when the value is anything else. */
const pairOf = (value: unknown, first: number, second: number): [number, number] | undefined => {
  if (typeof value !== "string") return undefined
  const match = /^([0-9a-z]{1,10})\.([0-9a-z]{1,8})$/u.exec(value)
  return match ? [Number.parseInt(match[1]!, 36) * first, Number.parseInt(match[2]!, 36) * second] : undefined
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)

/**
 * The state a cursor holds for this binding, or `CURSOR_INVALID`. Only a cursor of another binding, or one this plugin
 * never wrote, is refused: an odd optional field is dropped rather than refused, so the plugin never refuses its own
 * cursor.
 */
export function decodeState(binding: Binding, cursor: string): Decoded {
  if (cursor.length > MAX_CURSOR_LENGTH) return { ok: false, code: "CURSOR_INVALID", what: "The cursor is longer than a cursor can be." }
  const decoded = decodeBoundCursor(binding, cursor)
  if (!decoded.ok) {
    return {
      ok: false,
      code: "CURSOR_INVALID",
      what: decoded.reason === "foreign" ? "The cursor belongs to another source, account or scope." : "The cursor is not one this plugin wrote.",
    }
  }
  const raw = decoded.state as Record<string, unknown>
  if (!finite(raw.e) || !finite(raw.l)) return { ok: false, code: "CURSOR_INVALID", what: "The cursor does not carry this source's position." }
  if (raw.k !== undefined && (typeof raw.k !== "string" || raw.k.length === 0 || raw.k.length > K_CHARS || !raw.k.includes(":"))) {
    return { ok: false, code: "CURSOR_INVALID", what: "The cursor's listing line is not an external id." }
  }
  const l = Math.min(raw.l, raw.e + 1)
  return {
    ok: true,
    state: {
      e: raw.e,
      l,
      ...(finite(raw.n) ? { n: Math.min(raw.n, raw.e + 1) } : {}),
      ...(finite(raw.m) ? { m: raw.m } : {}),
      ...(typeof raw.k === "string" ? { k: raw.k } : {}),
      ...(typeof raw.z === "string" && raw.z.length > 0 && raw.z.length <= Z_CHARS ? { z: raw.z } : {}),
      ...(finite(raw.d) && raw.d >= 1 ? { d: raw.d } : {}),
      ...(finite(raw.t) ? { t: raw.t } : {}),
      ...(pairOf(raw.r, 1, 60_000) ? { r: { at: pairOf(raw.r, 1, 60_000)![0], hold: pairOf(raw.r, 1, 60_000)![1] } } : {}),
      ...(pairOf(raw.h, 60_000, 1000) ? { h: { hold: pairOf(raw.h, 60_000, 1000)![0], seen: pairOf(raw.h, 60_000, 1000)![1] } } : {}),
      ...(raw.g === 1 ? { g: 1 as const } : {}),
    },
  }
}

/** A stable 6-byte FNV-1a hash of an id, as 12 hex digits: the tie-break inside one millisecond. */
export function hashOf(id: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (let index = 0; index < id.length; index++) {
    hash ^= BigInt(id.charCodeAt(index))
    hash = (hash * prime) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, "0").slice(-HASH_BYTES * 2)
}

/** True when `(end, externalId)` is after the listing line `(e, k)`. */
export const after = (end: number, externalId: string, e: number, k: string | undefined): boolean => end > e || (end === e && k !== undefined && externalId > k)

export const iso = (ms: number): string => new Date(ms).toISOString()

// ── tracked ids ──────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/** One id as the cursor keeps it: a run id in base36, a UUID as 16 bytes of base64url, anything else as `~` + base64url. */
export function packId(id: string): string {
  if (/^[1-9][0-9]{0,18}$/u.test(id)) return BigInt(id).toString(36)
  if (UUID.test(id)) return Buffer.from(id.replaceAll("-", ""), "hex").toString("base64url")
  return `~${Buffer.from(id, "utf8").toString("base64url")}`
}

export function unpackId(packed: string): string | undefined {
  if (packed.startsWith("~")) return Buffer.from(packed.slice(1), "base64url").toString("utf8") || undefined
  if (packed.length === 22) {
    const hex = Buffer.from(packed, "base64url").toString("hex")
    return hex.length === 32 ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : undefined
  }
  if (!/^[0-9a-z]{1,13}$/u.test(packed)) return undefined
  let value = 0n
  for (const character of packed) value = value * 36n + BigInt(Number.parseInt(character, 36))
  return value.toString()
}

/**
 * A tracked item: its key; `done` once it was seen finished, with its `end` when the cursor had room to keep it. A
 * running one is read back on every full page; a finished one with its end once it is due; a finished one without it
 * on every full page (the end is only a saving, never needed to list it).
 *
 * The key is a run's id, or a statement's **reference** `<start second>~<id hash>` (`refOf`): the second it started
 * and 12 bits of its id's hash, about 7 characters where its UUID takes 22. A reference is admitted only when no other
 * statement of that second has the same hash, and every statement of a second is shown within `LAG_MS` of it, so a
 * reference names exactly one statement: it can neither lose one nor list one twice.
 */
export interface Tracked {
  readonly id: string
  readonly done?: boolean
  readonly end?: number
}

const NUMERIC = /^[1-9][0-9]{0,18}$/u
const REF = /^(\d{1,13})~([A-Za-z0-9_-]{2})$/u

/** A statement's reference: the second it started and two base64url characters (12 bits) of its id's hash. */
export const refOf = (id: string, start: number): string => `${Math.floor(start / 1000)}~${Buffer.from(hashOf(id).slice(0, 4), "hex").toString("base64url").slice(0, 2)}`

/** The second a reference names, and its hash; undefined for a key that is not a reference. */
export function parseRef(key: string): { readonly second: number; readonly hash: string } | undefined {
  const match = REF.exec(key)
  return match ? { second: Number(match[1]), hash: match[2]! } : undefined
}

/**
 * Entries as the cursor keeps them, joined by `.`: numeric (run) ids sorted and delta-encoded (`+<base36 delta>` after
 * the first); statement references sorted by second, as `!<hash><base36 seconds>` (the first relative to `base`, the
 * rest to the one before); other ids packed by `packId`; then `@` when finished, with the end in base36 after it when
 * kept.
 */
function encodeEntries(tracked: readonly Tracked[], base = 0): string {
  const unique = [...new Map(tracked.map((entry) => [entry.id, entry])).values()]
  const numeric = unique.filter((entry) => NUMERIC.test(entry.id)).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0))
  const refs = unique.filter((entry) => parseRef(entry.id) !== undefined).sort((a, b) => parseRef(a.id)!.second - parseRef(b.id)!.second)
  const other = unique.filter((entry) => !NUMERIC.test(entry.id) && parseRef(entry.id) === undefined)
  const suffix = (entry: Tracked) => (entry.end !== undefined ? `@${(entry.end - base).toString(36)}` : entry.done ? "@" : "")
  const parts: string[] = []
  let previous: bigint | undefined
  for (const entry of numeric) {
    const value = BigInt(entry.id)
    parts.push(`${previous === undefined ? value.toString(36) : `+${(value - previous).toString(36)}`}${suffix(entry)}`)
    previous = value
  }
  let second = Math.floor(base / 1000)
  for (const entry of refs) {
    const ref = parseRef(entry.id)!
    parts.push(`!${ref.hash}${(ref.second - second).toString(36)}${suffix(entry)}`)
    second = ref.second
  }
  for (const entry of other) parts.push(`${packId(entry.id)}${suffix(entry)}`)
  return parts.join(".")
}

/** The entries of a packed set; `base` is the time its ends and first reference are kept relative to (the state's `t`, else 0). */
export const unpackIds = (packed: string | undefined, base = 0): Tracked[] => {
  const out: Tracked[] = []
  let previous: bigint | undefined
  let second = Math.floor(base / 1000)
  for (const part of (packed ?? "").split(".").filter(Boolean)) {
    const at = part.indexOf("@")
    const head = at < 0 ? part : part.slice(0, at)
    let id: string | undefined
    if (head.startsWith("+")) {
      if (previous === undefined || !/^\+[0-9a-z]{1,13}$/u.test(head)) continue
      let delta = 0n
      for (const character of head.slice(1)) delta = delta * 36n + BigInt(Number.parseInt(character, 36))
      previous += delta
      id = previous.toString()
    } else if (head.startsWith("!")) {
      const match = /^!([A-Za-z0-9_-]{2})(-?[0-9a-z]{1,9})$/u.exec(head)
      if (!match) continue
      second += Number.parseInt(match[2]!, 36)
      if (!Number.isSafeInteger(second) || second < 0) continue
      id = `${second}~${match[1]}`
    } else {
      id = unpackId(head)
      if (id !== undefined && NUMERIC.test(id)) previous = BigInt(id)
    }
    if (id === undefined) continue
    if (at < 0) out.push({ id })
    else {
      const offset = part.slice(at + 1)
      const end = /^-?[0-9a-z]{1,11}$/u.test(offset) ? base + Number.parseInt(offset, 36) : Number.NaN
      out.push(Number.isSafeInteger(end) ? { id, done: true, end } : { id, done: true })
    }
  }
  return out
}

/** The size the entries take with every one marked finished and no end kept: what admitting one must fit within. */
export const reservedSize = (tracked: readonly Tracked[]): number => encodeEntries(tracked.map((entry) => ({ id: entry.id, done: true }))).length

/** True when `tracked` fits the budget even once every entry is finished: removals and marks never grow it past that. */
export const fits = (tracked: readonly Tracked[]): boolean => reservedSize(tracked) <= Z_CHARS

/**
 * The packed form of `tracked`, keeping as many ends as fit (the latest-due ends are dropped first). Undefined only
 * when the entries do not fit even without ends, which `fits` at admission rules out.
 */
export function packIds(tracked: readonly Tracked[], base = 0): string | undefined {
  let entries = [...tracked]
  let packed = encodeEntries(entries, base)
  if (packed.length <= Z_CHARS) return packed
  const withEnds = entries.filter((entry) => entry.end !== undefined).sort((a, b) => b.end! - a.end!)
  for (const entry of withEnds) {
    entries = entries.map((candidate) => (candidate.id === entry.id ? { id: entry.id, done: true } : candidate))
    packed = encodeEntries(entries, base)
    if (packed.length <= Z_CHARS) return packed
  }
  return undefined
}
