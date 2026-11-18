/**
 * The two event sources' cursor (design §11.1, §11.2, source-contract's `cursor`): a version 2 bound cursor, so another
 * plugin's, source's, account's or scope's cursor is `CURSOR_INVALID` before anything is read. The state is this
 * plugin's own and is never shown:
 *
 * - `w`: the window's end, a start-time watermark in ms: every item that starts at or before it has been looked at;
 * - `f`: the window's start, a start-time line in ms: the oldest item this window reads (the lookback, or a gap line
 *   carried from a shortening — never recomputed from "now", the sliding-gap bug);
 * - `h`: base64url of 6-byte hashes of the ids already emitted, newest last, at most 40: the de-duplication that lets
 *   the lookback re-read a window and still deliver each item once (a 1,024-character cap leaves no room for 40 UUIDs);
 * - `g`: the window start whose truncation has already been announced, so a gap is reported once per shortening and
 *   never once per read;
 * - `z`: the ids of runs still active when the watermark passed them (at most 200), which each read checks with
 *   `runs/get` — a run can last days, so its end cannot be predicted.
 */
import { MAX_CURSOR_LENGTH, canonicalScope, decodeBoundCursor, encodeBoundCursor, type Scope } from "@we-the-rebel-alliance/source-contract/cursor"
import { NAMESPACE } from "../constants.js"
import { sourceError } from "./errors.js"

/** The most details a source's state keeps; the rest is a gap, never silent loss. */
export const MAX_HASHES = 64
/** The cursor's 1,024-character cap holds this many pending run ids; beyond it a gap is announced. */
export const MAX_PENDING = 40
export const HASH_BYTES = 6

export interface CursorState {
  /** The window's end, ms. */
  w: number
  /** The window's start, ms. */
  f: number
  /** The emitted ids' hashes, base64url. */
  h: string
  /** 1 when a gap was announced for this cursor chain, so the next page does not repeat it. */
  g?: number
  /** The last emitted position in the window: `(occurred_at ms, id hash)`, so a burst larger than the hash set drains. */
  p?: { readonly e: number; readonly h: string }
  /** A run walk's next page token, `<jobId or empty>|<token>`: a same-start burst larger than the walk cap resumes here. */
  t?: string
  /** The runs still active when the window ended, base36 ids joined by commas. */
  z?: string
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
  try {
    return encodeBoundCursor(binding, state as unknown as Readonly<Record<string, unknown>>)
  } catch {
    // A cursor over the cap is a bug in this source, not in the person's call.
    throw sourceError("TOO_LARGE", "The read's position is too large to keep in a cursor.", "Read fewer items per page with limit, or start again with since.")
  }
}

export type Decoded = { readonly ok: true; readonly state: CursorState } | { readonly ok: false; readonly code: "CURSOR_INVALID" | "CURSOR_EXPIRED"; readonly what: string }

/** The state a cursor holds for this binding, or the contract code it is refused with. */
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
  const state = decoded.state as Partial<CursorState>
  if (typeof state.w !== "number" || typeof state.f !== "number" || typeof state.h !== "string") {
    return { ok: false, code: "CURSOR_INVALID", what: "The cursor does not carry this source's position." }
  }
  const position = state.p as { e?: unknown; h?: unknown } | undefined
  return {
    ok: true,
    state: {
      w: state.w,
      f: state.f,
      h: state.h,
      ...(typeof state.g === "number" ? { g: state.g } : {}),
      ...(typeof state.z === "string" ? { z: state.z } : {}),
      ...(position !== undefined && typeof position.e === "number" && typeof position.h === "string" ? { p: { e: position.e, h: position.h } } : {}),
      ...(typeof state.t === "string" ? { t: state.t } : {}),
    },
  }
}

/** A stable 6-byte FNV-1a hash of an id, as hex: a cursor keeps hashes, not the ids. */
export function hashOf(id: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (let index = 0; index < id.length; index++) {
    hash ^= BigInt(id.charCodeAt(index))
    hash = (hash * prime) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, "0").slice(-HASH_BYTES * 2)
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

/** The packed hashes as base64url: 6 bytes each, 8 characters in base64url after the bit packing below. */
export function packHashes(hashes: readonly string[]): string {
  let bits = ""
  for (const hash of hashes) for (const nibble of hash) bits += parseInt(nibble, 16).toString(2).padStart(4, "0")
  let out = ""
  for (let index = 0; index < bits.length; index += 6) out += BASE64URL[Number.parseInt(bits.slice(index, index + 6).padEnd(6, "0"), 2)]
  return out
}

/** The hashes a packed string holds; an unreadable one is an empty list (the cursor is still bound and valid). */
export function unpackHashes(packed: string): string[] {
  let bits = ""
  for (const character of packed) {
    const value = BASE64URL.indexOf(character)
    if (value < 0) return []
    bits += value.toString(2).padStart(6, "0")
  }
  const hashes: string[] = []
  const per = HASH_BYTES * 2
  for (let index = 0; index + per * 4 <= bits.length; index += per * 4) {
    let hex = ""
    for (let nibble = 0; nibble < per; nibble++) hex += Number.parseInt(bits.slice(index + nibble * 4, index + nibble * 4 + 4), 2).toString(16)
    hashes.push(hex)
  }
  return hashes
}

/** The hashes with `added`, keeping the newest `MAX_HASHES`; `dropped` is true when an older hash had to go. */
export function withHashes(packed: string, added: readonly string[]): { packed: string; dropped: boolean } {
  const kept = [...unpackHashes(packed), ...added]
  const dropped = kept.length > MAX_HASHES
  return { packed: packHashes(kept.slice(Math.max(0, kept.length - MAX_HASHES))), dropped }
}

export const iso = (ms: number): string => new Date(ms).toISOString()

/** The pending run ids `z` holds, as numbers. */
export const pendingOf = (state: CursorState): number[] =>
  (state.z ?? "")
    .split(",")
    .filter(Boolean)
    .map((id) => Number.parseInt(id, 36))
    .filter((id) => Number.isFinite(id))

/** A pending list as the cursor stores it: base36, comma-joined, newest first, at most `MAX_PENDING`. */
export const pendingString = (ids: readonly number[]): string => [...new Set(ids)].slice(0, MAX_PENDING).map((id) => id.toString(36)).join(",")
