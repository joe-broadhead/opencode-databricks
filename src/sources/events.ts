/**
 * `databricks.queries` and `databricks.runs`, the plugin's two event sources, over one page engine. The design is in
 * the PR that introduced it (opencode-databricks #8) and in `docs/architecture.md`; in short:
 *
 * **What the APIs give.** Query History (`GET /api/2.0/sql/history/queries`) filters only by when a statement *started*
 * (`filter_by.query_start_time_range`, at most 30 days), answers "most recently started first", pages by
 * `next_page_token` (1,000 rows a page at most), returns running rows too, and marks a row that will not change again
 * with `is_final` (https://docs.databricks.com/api/workspace/queryhistory/list). Jobs `runs/list` filters by
 * `start_time_from`/`start_time_to`, lists "in descending order by start time", pages by `next_page_token` (25 runs a
 * page at most) and lists active and completed runs alike (https://docs.databricks.com/api/workspace/jobs/listruns); run
 * history is kept 60 days (https://docs.databricks.com/aws/en/jobs/monitor). A statement or run becomes an event when it
 * *ends*, which can be hours after it started.
 *
 * **So an item is keyed on the moment it becomes final.** Its event's `occurred_at` is its end, and a page lists items in
 * `(end, id hash)` order up to a horizon `t ≤ now − LAG_MS`. The cursor (`cursor.ts`) carries the listing line `(e, k)`,
 * the scan floor `l` and a few tracked ids `z`; each page:
 *
 * 1. walks `[l, e]` by start time (items that started before the line and may have finished since: the long ones), and
 *    `(e, t]` (everything newer), narrowing `t` when that walk is longer than its cap, so a large window is read in
 *    slices and never re-walked whole for every page;
 * 2. reads the tracked ids back by id;
 * 3. lists the final items after `(e, k)` and at or before `t`, oldest first, up to `limit`;
 * 4. moves the line to the last item listed (or to `t`), and the floor up to the oldest item still unlisted, sending
 *    an item whose start lies too far behind into `z` instead.
 *
 * Nothing is de-duplicated by a set of ids, so the volume of a window never shortens it: an item is listed once
 * because it has one end. A gap (`window-truncated`) is answered only when something is really dropped (a walk past
 * its cap behind the line, a millisecond with more starts than the jam cap, an item the full tracked set cannot take
 * and a walk cannot reach, or, once per lag episode, a proven lag longer than the hold the line passed an untracked
 * running item under), once per read; `expired` when the cursor
 * or `since` is older than the provider keeps. State is never dropped without one.
 *
 * **The line is held** at the oldest item still shown running that is not tracked by id (its final state may lag its
 * end), at most `HOLD_MAX_MS` behind now; items running longer than `HOLD_SOFT_MS` are tracked first, and a tracked
 * item is listed whenever it is final, wherever its end falls.
 *
 * **Assumptions** (`docs/sources.md`, Known limits): a new row appears within `LAG_MS` of its start, and the host's
 * clock is within that of Databricks'; an untracked item's final state shows within `HOLD_MAX_MS` of its end (a
 * tracked item that shows otherwise answers a gap). Both APIs page by token over a fixed start range, which new starts
 * (always later than the range) cannot shift.
 *
 * Every provider call either succeeds or fails the whole page (no item fails on its own: a tracked run that is gone is
 * dropped), so no page carries `failed[]`. The event's title is the plugin's own wording; `text` is empty, because SQL
 * holds literals and secrets and a run's state message can hold data.
 */
import { fitPage, makeEvent, parseEventsListInput, screenEvents, startTime, type EventsListResult, type RefusedEvent, type Scope, type SourceEvent } from "@we-the-rebel-alliance/source-contract/events"
import { PLUGIN_ID } from "../constants.js"
import { DatabricksError } from "../domain/errors.js"
import type { HistoryQuery, RunInfo } from "../ports.js"
import type { Deps } from "../registry.js"
import type { Call } from "../tool-spec.js"
import { assertRead } from "./assert.js"
import { after, bindingOf, decodeState, encodeState, fits, hashOf, iso, packIds, parseRef, refOf, unpackIds, type CursorState, type Tracked } from "./cursor.js"
import { sourceError, sourceErrorOf } from "./errors.js"
import { hostName, ownerOf, workspaceOwner, type Owner } from "./owner.js"
import { recordsOf, type IdentityRecord } from "./records.js"

/** The source names, as `events_list`'s `source` input and the descriptor's `input.source` name them. */
export type SourceName = "queries" | "runs"

export const SOURCE_NAMES: readonly SourceName[] = ["queries", "runs"]

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** How long after its end (or start) an item may take to show in the list: the horizon's hold-back. */
export const LAG_MS = 5 * 60_000
/**
 * The longest the listing line waits behind now for an untracked item still shown running: the most a final state may
 * lag its end. An item still running after `HOLD_SOFT_MS` is tracked by id instead (if the cursor has room), and a
 * tracked item is listed whatever its lag; a tracked item found to have lagged longer than this answers a gap.
 */
export const HOLD_MAX_MS = 75 * 60_000
/** A lag episode widens the hold to the lag it proves plus this margin… */
export const HOLD_MARGIN_MS = 15 * 60_000
/** …up to this; a lag longer still is answered with a gap for each release it can have cost. */
export const HOLD_CAP_MS = 12 * HOUR
/** An item shown running for longer than this is tracked by id, so it stops holding the line back past the horizon. */
export const HOLD_SOFT_MS = LAG_MS
/** The margin kept inside a provider's retention, so a restart is not expired again at once. */
export const EDGE_MARGIN_MS = HOUR
/** 30 days: one Query History range's limit, and the age past which this source assumes history is gone. */
export const QUERY_RETENTION_MS = 30 * DAY
/** 60 days: "Databricks retains run history for 60 days" (https://docs.databricks.com/aws/en/jobs/monitor). */
export const RUN_RETENTION_MS = 60 * DAY
/** A narrowed walk is retried at most this many times a page; then the page answers with a narrower slice to read next. */
export const NARROW_ATTEMPTS = 3

/** One statement or run: its id, its start, and its end once final. */
interface Item {
  readonly id: string
  readonly start: number
  /** Present once the item is final; its event's `occurred_at`. */
  readonly end?: number
  /** Final with nothing to list (a final row without a terminal status): consumed without an event. */
  readonly silent?: boolean
  readonly draft: { readonly kind: string; readonly title: string; readonly labels: readonly string[]; readonly actors: readonly { readonly role: string; readonly id: string; readonly name?: string }[] }
}

interface Walk {
  readonly items: readonly Item[]
  /** Pages remained when the walk reached its cap. */
  readonly truncated: boolean
  /** The oldest start the walk saw. */
  readonly oldest?: number
  readonly calls: number
}

interface Context {
  readonly deps: Deps
  readonly account: string
  readonly call: Call
  /** The workspace's host name, for ids. */
  readonly host: string
  readonly scope?: Scope
  readonly identity?: IdentityRecord
  readonly now: number
  /** Plain-language notes for the model's tool (`message`): the evidence behind a lag gap. */
  readonly notes?: string[]
}

interface Adapter {
  readonly source: SourceName
  readonly retentionMs: number
  /** How far before `since` a first read looks for items that started earlier and ended after it. */
  readonly firstLookbackMs: number
  readonly limitMax: number
  readonly scopeKeys: readonly string[]
  /** Every operation a page may call, asserted before the first call. */
  readonly operations: readonly string[]
  readonly pageRows: number
  /** Pages a walk behind the line may take; beyond it the oldest part is abandoned, with a gap. */
  readonly behindCap: number
  /** Pages a walk of the new slice may take before the slice is narrowed. */
  readonly sliceCap: number
  /** Pages one millisecond may take; beyond it the rest of that millisecond is a gap. */
  readonly jamCap: number
  /** Rows behind the line a page aims to re-walk; items started further back are tracked by id. */
  readonly keepRows: number
  /** The most ids tracked: each is read back once a page. */
  readonly maxTracked: number
  readonly owner: (context: Context) => Owner
  readonly walk: (context: Context, from: number, to: number, capPages: number) => Promise<Walk>
  /** The key an item is tracked by: a run's id, a statement's reference (`refOf`). */
  readonly keyOf: (item: Item) => string
  /** The tracked items, read back by key (or, from a cursor written before references, by id); one gone is absent. */
  readonly recheck: (context: Context, keys: readonly string[]) => Promise<readonly Item[]>
}

/** The page request every source's page needs. */
export interface PageRequest {
  readonly account: string
  readonly source: SourceName
  readonly cursor?: string
  readonly since?: string
  readonly limit?: number
  readonly scope?: Readonly<Record<string, readonly string[]>>
  readonly call: Call
  /**
   * The model's own tool, not a consumer's source session: it asserts the family's rule (`assert.ts`), and with no probe
   * record it reads the identity itself (asserting its action on `<account>:scim.me.get`) and records it. A source
   * session answers `UNAVAILABLE` instead.
   */
  readonly mode?: "source" | "tool"
  /** Collects plain-language notes for the model's tool, such as the evidence behind a lag gap. */
  readonly notes?: string[]
}

/** The account a source's `events_list` is for, checked against the plugin's accounts. */
function accountOf(deps: Deps, requested: string | undefined): string {
  const names = Object.keys(deps.options.accounts ?? {})
  if (requested === undefined) return names[0] ?? "default"
  try {
    deps.auth.account(requested)
    return requested
  } catch {
    throw sourceError("ACCOUNT_MISMATCH", `This plugin is not signed in to "${requested}".`, `Pass the account probe answers (${names.join(", ") || "default"}), or sign in with /connect.`)
  }
}

/** The identity `probe` recorded for `account`, or (model tool only) one read now. */
async function identityFor(deps: Deps, account: string, request: PageRequest): Promise<IdentityRecord> {
  const host = deps.auth.account(account).host
  const records = recordsOf(deps)
  const known = records.get(account, host)
  if (known) return known
  if (request.mode !== "tool") {
    throw sourceError("UNAVAILABLE", "This source lists only your own statements, and no probe has named you on this account yet.", "Probe this source first (a consumer does at bind), then read it again.")
  }
  await assertRead("tool", deps.permission, request.call, "databricks.events_list", ["scim.me.get"], account)
  try {
    const me = await deps.databricks.me(account, request.call.signal)
    const record: IdentityRecord = { userId: me.id, userName: me.userName, ...(me.displayName ? { displayName: me.displayName } : {}), at: deps.clock.now() }
    records.put(account, host, record)
    return record
  } catch (error) {
    throw sourceErrorOf(error)
  }
}

/**
 * One page of an event source: validate the input, refuse or expire a cursor, read the window, screen the events, and
 * answer the contract's page with its cursor, gap and refused parts.
 */
export async function eventsPage(deps: Deps, request: PageRequest): Promise<EventsListResult> {
  const adapter = ADAPTERS[request.source]
  if (!adapter) throw sourceError("SOURCE_UNKNOWN", `This plugin has no source "${String(request.source)}"; its sources are ${SOURCE_NAMES.join(", ")}.`, "Pass source queries or source runs.")
  const parsed = parseEventsListInput(
    {
      ...(request.account === undefined ? {} : { account: request.account }),
      source: request.source,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      ...(request.since === undefined ? {} : { since: request.since }),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.scope === undefined ? {} : { scope: request.scope }),
    },
    { scopeKeys: adapter.scopeKeys },
  )
  if (!parsed.ok) throw sourceError("INPUT_INVALID", `The events_list input is invalid: ${parsed.problems.join("; ")}`, "Pass source, account, since, cursor, limit or the source's scope as its schema describes them.")
  const value = parsed.value
  const account = accountOf(deps, value.account)
  const scope = value.scope as Scope | undefined
  const binding = bindingOf(request.source, account, scope)
  const limit = Math.max(1, Math.min(value.limit ?? 100, adapter.limitMax))
  // The read's own grants, before the first call: for a consumer, the method on `*`, then `databricks.read` on each
  // operation; for the model's tool, its action on each operation.
  await assertRead(request.mode ?? "source", deps.permission, request.call, "databricks.events_list", adapter.operations, account)
  let state: CursorState | undefined
  if (value.cursor !== undefined) {
    const decoded = decodeState(binding, value.cursor)
    if (!decoded.ok) throw sourceError(decoded.code, decoded.what, "Start again with since, or pass the cursor with the source, account and scope it was issued for.")
    state = decoded.state
  }
  const identity = request.source === "queries" ? await identityFor(deps, account, request) : undefined
  const now = deps.clock.now()
  const context: Context = { deps, account, call: request.call, host: hostName(deps.auth.account(account).host), now, ...(scope ? { scope } : {}), ...(identity ? { identity } : {}), ...(request.notes ? { notes: request.notes } : {}) }
  const owner = adapter.owner(context)
  const page = (events: readonly SourceEvent[], next: CursorState, more: boolean, extras: { gap?: EventsListResult["gap"]; refused?: readonly RefusedEvent[] } = {}) =>
    pageResult({ source: request.source, account, owner, events, cursor: encodeState(binding, next), more, ...extras, ...(scope ? { scope: canonical(scope) } : {}) })

  const edge = now - adapter.retentionMs + EDGE_MARGIN_MS
  const horizon = now - LAG_MS
  if (state === undefined) {
    const since = startTime(value, now)
    // Asked further back than the provider keeps: say where history is lost, and start at the edge.
    if (since < edge) return page([], { e: edge, l: edge, g: 1 }, true, { gap: { reason: "expired", since: iso(since) } })
    state = { e: since - 1, l: Math.max(edge, since - adapter.firstLookbackMs) }
  } else if (state.e < edge) {
    // The cursor's line is older than the provider keeps: the gap starts at the line, carried, never at "now".
    return page([], { e: edge, l: edge, g: 1 }, true, state.g === 1 ? {} : { gap: { reason: "expired", since: iso(state.e) } })
  }
  let lost: "expired" | "window-truncated" | undefined
  if (state.l < edge || (state.n !== undefined && state.n < edge)) {
    // Items that started before the edge and were still unlisted are beyond the provider's history now.
    state = { ...state, l: Math.max(state.l, edge), ...(state.n === undefined ? {} : { n: Math.max(state.n, edge) }) }
    lost = "expired"
  }
  // Nothing can have finished, visibly, after the line yet: the same position, read again later.
  if (horizon <= state.e) {
    const { g: _g, ...kept } = state
    void _g
    return page([], kept, false, lost !== undefined && state.g !== 1 ? { gap: { reason: lost, since: iso(state.e) } } : {})
  }

  const initialTop = state.d !== undefined ? Math.min(horizon, state.e + state.d) : horizon
  // A **full** page re-reads everything behind the line (`[l, e]` and the tracked ids); a **partial** page, possible only
  // while the slice ends before `m`, reads `[n, t]` alone: nothing still running behind the line can be final before
  // `m`, and every finished one not yet listed started at or after `n`. A backlog is then read once, slice by slice.
  const full = state.m === undefined || initialTop >= state.m
  const answer = await pageOf(context, adapter, state, { horizon, top: initialTop, full, limit, lost })
  if (answer.retryFull && !full) return page(...(await pageOf(context, adapter, state, { horizon, top: initialTop, full: true, limit, lost })).result)
  return page(...answer.result)
}

interface PageOptions {
  readonly horizon: number
  readonly top: number
  readonly full: boolean
  readonly limit: number
  readonly lost: "expired" | "window-truncated" | undefined
}

type PageParts = [readonly SourceEvent[], CursorState, boolean, { gap?: EventsListResult["gap"]; refused?: readonly RefusedEvent[] }]

/** One page's reads and its next state, full or partial. A partial page that meets a jam asks to be read in full. */
async function pageOf(context: Context, adapter: Adapter, state: CursorState, options: PageOptions): Promise<{ readonly result: PageParts; readonly retryFull?: boolean }> {
  const { horizon, full, limit } = options
  let lost = options.lost
  // 1. Behind the line (full pages): items that started at or before it and are not listed yet (long statements, runs).
  const seen: Item[] = []
  const behindFrom = Math.min(state.l, state.n ?? state.l)
  // The oldest start this page's walks cover: every unlisted item it decides about started at or after it.
  let floorAtLeast = full ? behindFrom : Math.min(state.n ?? state.e + 1, state.e + 1)
  if (full && behindFrom <= state.e) {
    const behind = await adapter.walk(context, behindFrom, state.e, adapter.behindCap)
    seen.push(...behind.items)
    if (behind.truncated) {
      // More rows behind the line than a page reads: the part older than the walk reached is given up, and said so.
      floorAtLeast = behind.oldest ?? state.e
      lost ??= "window-truncated"
    }
  }

  // 2. The slice, `(e, t]` (from `n` on a partial page), narrowed while it is longer than its cap; one millisecond is
  // walked to the jam cap.
  const from = full ? state.e + 1 : Math.min(state.n ?? state.e + 1, state.e + 1)
  let top = options.top
  let narrowed = false
  let jam: number | undefined
  let fresh: Walk
  for (let attempt = 1; ; attempt++) {
    fresh = await adapter.walk(context, from, top, adapter.sliceCap)
    if (!fresh.truncated) break
    // A partial page's walk includes the few rows behind the line; when it is too long, the page is read in full.
    if (!full) return { result: [[], state, true, {}], retryFull: true }
    if (top === state.e + 1) {
      fresh = await adapter.walk(context, top, top, adapter.jamCap)
      if (fresh.truncated) {
        jam = top
        lost ??= "window-truncated"
      }
      break
    }
    narrowed = true
    // At most half the way to the oldest start the walk reached, and about half a walk's rows at the density it saw.
    const reached = Math.max(state.e + 1, Math.min(top, fresh.oldest ?? top))
    const dense = Math.floor(((top - reached + 1) * sliceRows(adapter)) / 2 / Math.max(1, fresh.items.length))
    top = state.e + Math.max(1, Math.min(Math.floor((reached - state.e) / 2), dense))
    if (attempt >= NARROW_ATTEMPTS) {
      // Still too long: answer nothing yet, and read the narrower slice on the next page. The width halves every time,
      // down to one millisecond, so the read always progresses.
      return { result: [[], { ...state, d: top - state.e }, true, {}] }
    }
  }
  seen.push(...fresh.items)

  // 3. The tracked items: one this page's walks cover is decided from what they saw; the rest that are due are read
  // back; the others are carried as they are (a final row does not change).
  const trackedAll = unpackIds(state.z, state.t ?? 0)
  // A running one is read back on a full page at most once every `LAG_MS` (once a read): one skipped is still listed
  // when it is next read, since a tracked item is listed wherever its end falls. A finished one when its end is due,
  // or on every page when the cursor had no room for its end.
  const checkRunning = full && (state.t === undefined || context.now - state.t >= LAG_MS)
  const keyOf = (item: Item) => adapter.keyOf(item)
  const seenByKey = new Map<string, Item[]>()
  for (const item of seen) seenByKey.set(keyOf(item), [...(seenByKey.get(keyOf(item)) ?? []), item])
  // A statement tracked by its id (a cursor written before references) is matched by that id.
  const named = (key: string, items: readonly Item[]) => items.filter((item) => keyOf(item) === key || item.id === key)
  const coveredFrom = Math.min(floorAtLeast, state.e + 1)
  /** A statement reference whose whole second this page's walks read: if they did not see it, it is gone. */
  const covered = (key: string) => {
    const ref = parseRef(key)
    return ref !== undefined && ref.second * 1000 >= coveredFrom && ref.second * 1000 + 999 <= top
  }
  const resolved: { readonly entry: Tracked; readonly item: Item }[] = []
  const unresolved: Tracked[] = []
  for (const entry of trackedAll) {
    const matches = seenByKey.get(entry.id) ?? named(entry.id, seen)
    if (matches.length === 1) resolved.push({ entry, item: matches[0]! })
    else if (matches.length > 1) lost ??= "window-truncated" // a key that names two items: never guess which
    else if (!covered(entry.id)) unresolved.push(entry)
  }
  const due = unresolved.filter((entry) => (entry.end !== undefined ? entry.end <= top : entry.done === true || checkRunning))
  const carriedTracked = unresolved.filter((entry) => !due.includes(entry))
  if (due.length > 0) {
    const answers = await adapter.recheck(context, due.map((entry) => entry.id))
    for (const entry of due) {
      const matches = named(entry.id, answers)
      if (matches.length === 1) resolved.push({ entry, item: matches[0]! })
      else if (matches.length > 1) lost ??= "window-truncated"
    }
  }
  const tracked = resolved.map((pair) => pair.item)
  // A tracked item seen running at the last check and final now, with an end more than `HOLD_MAX_MS` before that check,
  // shows Databricks' final state lagging at least that long (the evidence for step 8's lag episode).
  let lag: number | undefined
  if (state.t !== undefined) {
    for (const { entry, item } of resolved) {
      if (entry.done || item.end === undefined || item.end >= state.t - HOLD_MAX_MS) continue
      lag = Math.max(lag ?? 0, state.t - item.end)
    }
  }
  // The hold in force: the default, or one a lag episode widened (for a day after its last proof).
  const widened = state.h !== undefined && context.now - state.h.seen <= DAY ? state.h.hold : undefined
  const holdMax = Math.max(HOLD_MAX_MS, widened ?? 0, lag === undefined ? 0 : Math.min(HOLD_CAP_MS, lag + HOLD_MARGIN_MS))

  // 4. Hold the line: an item still shown running may already have ended (its final state can lag), so the line stops
  // before the oldest one not tracked, at most `HOLD_MAX_MS` behind now. Items running longer than `HOLD_SOFT_MS` are
  // tracked first (oldest first, while the cursor has room), so they stop holding it.
  const trackedItemIds = new Set(tracked.map((item) => item.id))
  const runningSeen = seen.filter((item) => item.end === undefined && item.start <= top && !trackedItemIds.has(item.id)).sort((a, b) => a.start - b.start)
  /** A key this page can track: one that names this item alone among what the walks saw. */
  const trackable = (item: Item) => (seenByKey.get(keyOf(item))?.length ?? 0) <= 1
  let ids: Tracked[] = [...carriedTracked, ...resolved.map((pair) => ({ id: pair.entry.id, done: true }))]
  const admitted = new Set<string>()
  for (const item of runningSeen) {
    if (item.start >= context.now - HOLD_SOFT_MS || admitted.has(item.id) || !trackable(item)) continue
    if (ids.length >= adapter.maxTracked || !fits([...ids, { id: keyOf(item) }])) break
    ids = [...ids, { id: keyOf(item) }]
    admitted.add(item.id)
  }
  const holdStart = runningSeen.find((item) => !admitted.has(item.id))?.start
  const holdCap = holdStart === undefined ? Number.POSITIVE_INFINITY : Math.max(context.now - holdMax, holdStart - 1)
  const listTop = Math.min(top, holdCap)

  // 5. What is listable now: final, at or before the held top, after the line (a tracked item is unlisted by
  // definition, so it is listed wherever its end is).
  type Entry = { readonly item: Item; readonly tracked: boolean; readonly hash: string }
  const entries = new Map<string, Entry>()
  for (const item of seen) entries.set(item.id, { item, tracked: admitted.has(item.id) || trackedItemIds.has(item.id), hash: hashOf(externalId(context, item)) })
  for (const item of tracked) entries.set(item.id, { item, tracked: true, hash: hashOf(externalId(context, item)) })
  const listable: Entry[] = []
  const waiting: Entry[] = []
  for (const entry of entries.values()) {
    const end = entry.item.end
    if (end === undefined || end > listTop) waiting.push(entry)
    else if (entry.tracked || after(end, entry.hash, state.e, state.k)) listable.push(entry)
  }
  listable.sort((left, right) => left.item.end! - right.item.end! || (left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0))

  const built = listable.map((entry) => (entry.item.silent ? undefined : screenEvents([eventOf(context, adapter.source, entry.item)], { ownedBy: () => true })))
  const listedEvents = built.flatMap((screened) => screened?.events ?? [])
  const take = Math.max(1, fitPage(listedEvents, limit))
  const events: SourceEvent[] = []
  const refused: RefusedEvent[] = []
  let consumed = 0
  for (; consumed < listable.length; consumed++) {
    const screened = built[consumed]
    if (screened?.events.length) {
      if (events.length >= take) break
      events.push(...screened.events)
    } else if (screened?.refused.length) refused.push(...screened.refused)
  }
  const cut = consumed < listable.length
  for (const entry of listable.slice(consumed)) waiting.push(entry)
  const last = consumed > 0 ? listable[consumed - 1] : undefined
  const held = { e: state.e, ...(state.k ? { k: state.k } : {}) }
  const reached = (position: { readonly e: number; readonly k?: string }) => (position.e > state.e || (position.e === state.e && after(position.e, position.k ?? "~", state.e, state.k)) ? position : held)
  const line: { readonly e: number; readonly k?: string } = cut ? (last ? reached({ e: last.item.end!, k: last.hash }) : held) : listTop > state.e ? { e: listTop } : held
  /** The oldest start, at or after `floor`, of the untracked items behind the new line that are finished (or running). */
  const floorOf = (floor: number, finished: boolean) => {
    let oldest: number | undefined
    for (const entry of waiting) {
      if (entry.tracked || (entry.item.end !== undefined) !== finished || entry.item.start > line.e || entry.item.start < floor) continue
      if (oldest === undefined || entry.item.start < oldest) oldest = entry.item.start
    }
    return oldest
  }

  // 6. The floor: the oldest unlisted item behind the new line, unless re-walking back to it costs more than `keepRows`
  // (then it is tracked by id), or the cursor cannot track it (then it is lost, and the gap says so). A full page
  // decides for everything behind the line; a partial page for what its walk saw (it read `[n, t]` whole).
  const starts = seen.map((item) => item.start).filter((start) => start <= line.e).sort((a, b) => a - b)
  const rowsFrom = (start: number) => starts.length - lowerBound(starts, start)
  const trackedOf = (item: Item): Tracked => (item.end === undefined ? { id: keyOf(item) } : { id: keyOf(item), done: true, end: item.end })
  // The tracked set: what was carried, what was read back and is still unlisted, and what this page admitted.
  const stillTracked = waiting.filter((entry) => entry.tracked).map((entry) => trackedOf(entry.item))
  ids = [...carriedTracked, ...stillTracked]
  const behindLine = waiting.filter((entry) => !entry.tracked && entry.item.start <= line.e).sort((a, b) => a.item.start - b.item.start)
  const jamFloor = jam !== undefined && !cut ? jam + 1 : undefined
  let floor = line.e + 1
  for (const entry of behindLine) {
    const start = entry.item.start
    if (start < floorAtLeast) continue
    const rows = rowsFrom(start)
    // A finished item is cheaper to track (one read when it is due) than to re-walk for; a running one is tracked only
    // when re-walking back to it costs more than `keepRows`.
    const keep = entry.item.end === undefined ? adapter.keepRows : adapter.pageRows
    if (jamFloor === undefined || start >= jamFloor) {
      if (rows <= keep) {
        floor = start
        break
      }
    }
    if (trackable(entry.item) && ids.length < adapter.maxTracked && fits([...ids, trackedOf(entry.item)])) {
      ids = [...ids, trackedOf(entry.item)]
      continue
    }
    // No room to track it: keep re-walking back to it while a behind-walk reaches (no gap); only past that is it lost.
    if ((jamFloor === undefined || start >= jamFloor) && rows <= adapter.behindCap * adapter.pageRows * 0.8) {
      floor = start
      break
    }
    lost ??= "window-truncated"
  }
  floor = Math.min(Math.max(floor, floorAtLeast), line.e + 1)
  // Still running behind the line: on a full page, what it saw; on a partial one, also what the last full page saw.
  // (`l` past the old line means the last full page left nothing running behind it.)
  const carried = !full && state.l <= state.e ? state.l : line.e + 1
  let running = Math.min(floorOf(floor, false) ?? line.e + 1, carried)
  let finished = floorOf(floor, true)
  // A statement tracked by reference close behind the line (within `keepRows`) is found again by the walk, at no call
  // of its own: the floors stay at its second.
  for (const entry of ids) {
    const ref = parseRef(entry.id)
    if (ref === undefined) continue
    const at = ref.second * 1000
    if (at > line.e || at < floorAtLeast || rowsFrom(at) > adapter.keepRows) continue
    if (entry.done) finished = Math.min(finished ?? at, at)
    else running = Math.min(running, at)
  }
  // Nothing still running at a full page can be final, visibly, before that page's held line.
  const visible = full ? Math.min(horizon, holdCap) : (state.m ?? horizon)

  // 7. The slice width: about a page and a quarter after a cut page, else widened towards half a walk's rows.
  let width = narrowed ? top - state.e : state.d
  if (cut) width = Math.max(1, Math.ceil((line.e - state.e) * 1.25))
  else if (!narrowed && width !== undefined) {
    const fit = Math.floor(((top - state.e) * sliceRows(adapter)) / 2 / Math.max(1, fresh.items.length))
    width = Math.max(width, Math.min(width * 16, fit))
    if (width >= adapter.retentionMs) width = undefined
  }

  // A held line ends the read; a slice that stopped short of the horizon by its width does not.
  const more = cut || (top < horizon && listTop >= top)
  // Admission keeps the set within its budget even once every entry is finished, so it always packs. Should it not,
  // the ids that cannot be kept are lost, and the gap says so: state is never dropped without one.
  const base = checkRunning ? context.now : (state.t ?? 0)
  let packed = packIds(ids, base)
  while (packed === undefined && ids.length > 0) {
    ids = ids.slice(0, -1)
    packed = packIds(ids, base)
    lost ??= "window-truncated"
  }
  // 8. The lag episode. A release is the line passing an untracked item still shown running (the hold's bound let it
  // go); `r` keeps the first release not yet answered and the shortest hold it was made under. Proof of a lag (step 3)
  // longer than that hold means those releases can have lost items: one gap, from `r`. The hold then widens to the lag
  // plus a margin (`h`), so the rest of the episode loses nothing and answers nothing. Proof with no such release lost
  // nothing new: no gap. A release unproven for a day is let go.
  const releasedNow = runningSeen.some((item) => !admitted.has(item.id) && item.start <= line.e)
  let release = state.r
  if (releasedNow) release = { at: Math.min(release?.at ?? state.e, state.e), hold: Math.min(release?.hold ?? holdMax, holdMax) }
  let lagSince: number | undefined
  if (lag !== undefined) {
    const minutes = Math.round(lag / 60_000)
    if (release !== undefined && release.hold < lag) {
      lagSince = release.at
      lost ??= "window-truncated"
      context.notes?.push(`Databricks showed a final state about ${minutes} minutes after its end, longer than the ${Math.round(release.hold / 60_000)} minutes this source waited; items still running when the line passed them, from ${iso(release.at)}, may be missing. It now waits ${Math.round(holdMax / 60_000)} minutes.`)
      release = undefined
    } else {
      context.notes?.push(`Databricks showed a final state about ${minutes} minutes after its end; this source waits ${Math.round(holdMax / 60_000)} minutes, and nothing it passed meanwhile can be missing.`)
    }
  } else if (release !== undefined && !releasedNow && context.now - release.at > DAY) release = undefined
  const hold = lag !== undefined ? { hold: holdMax, seen: context.now } : widened !== undefined ? state.h : undefined
  const gap = lost !== undefined && state.g !== 1 ? { reason: lost, since: iso(Math.min(state.e, lagSince ?? state.e)) } : undefined
  const next: CursorState = {
    ...line,
    l: Math.min(running, line.e + 1),
    ...(finished !== undefined ? { n: finished } : {}),
    m: visible,
    ...(release !== undefined ? { r: release } : {}),
    ...(hold !== undefined ? { h: hold } : {}),
    ...(packed ? { z: packed } : {}),
    ...(width !== undefined ? { d: width } : {}),
    ...(checkRunning ? { t: context.now } : state.t !== undefined ? { t: state.t } : {}),
    ...(more && (state.g === 1 || gap !== undefined) ? { g: 1 as const } : {}),
  }
  return { result: [events, next, more, { ...(gap ? { gap } : {}), ...(refused.length ? { refused } : {}) }] }
}

/** The rows one slice walk may read. */
const sliceRows = (adapter: Adapter) => adapter.sliceCap * adapter.pageRows

/** The first index of `sorted` holding a value at least `value`. */
function lowerBound(sorted: readonly number[], value: number): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (sorted[middle]! < value) low = middle + 1
    else high = middle
  }
  return low
}

const externalId = (context: Context, item: Item): string => `${context.host}:${item.id}`

function eventOf(context: Context, source: SourceName, item: Item): SourceEvent {
  return makeEvent({
    source,
    account: context.account,
    external_id: externalId(context, item),
    kind: item.draft.kind as never,
    occurred_at: item.end!,
    title: item.draft.title,
    text: "",
    url: null,
    labels: item.draft.labels,
    actors: item.draft.actors,
  })
}

const canonical = (scope: Scope): Record<string, string | string[]> => {
  const answer: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(scope)) answer[key] = typeof value === "string" ? value : [...value]
  return answer
}

const listOf = (value: string | readonly string[] | undefined): string[] => (value === undefined ? [] : typeof value === "string" ? [value] : [...value])

/** The contract's page, with this plugin's name on it. A v0.1.x consumer refuses `removals[]` and `owner.verified`, so neither is written. */
function pageResult(page: {
  source: SourceName
  account: string
  owner: Owner
  events: readonly SourceEvent[]
  cursor: string
  more: boolean
  refused?: readonly RefusedEvent[]
  gap?: EventsListResult["gap"]
  scope?: Record<string, string | string[]>
}): EventsListResult {
  return {
    source: page.source,
    account: page.account,
    owner: { id: page.owner.id, label: page.owner.label },
    events: [...page.events],
    cursor: page.cursor,
    more: page.more,
    trust: "untrusted",
    ...(page.scope ? { scope: page.scope } : {}),
    ...(page.refused?.length ? { refused: [...page.refused] } : {}),
    ...(page.gap ? { gap: page.gap } : {}),
    plugin: PLUGIN_ID,
  }
}

function durationText(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

/** A provider failure fails the page whole; the source contract's code, in this plugin's words. */
async function provider<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw sourceErrorOf(error)
  }
}

// ── queries: Query History, the person's own finished statements ─────────

const TERMINAL = new Set(["FINISHED", "FAILED", "CANCELED"])

const userActor = (host: string, name: string) => (name.includes("@") ? `mailto:${name}` : `databricks:${host}:user:${name}`)

function queryItem(query: HistoryQuery, host: string): Item {
  const start = query.queryStartTimeMs
  const final = query.isFinal === true || (query.isFinal === undefined && TERMINAL.has(query.status))
  const reported = query.queryEndTimeMs ?? (query.durationMs === undefined ? undefined : start + query.durationMs)
  const end = final ? Math.max(start, reported ?? start) : undefined
  const duration = query.durationMs ?? (end === undefined ? 0 : end - start)
  // The client that submitted it is a label (untrusted, cut to 64 characters); the actor is named by `user_name` when
  // the port carries it (an address becomes `mailto:`), else by the user id.
  const client = query.clientApplication?.trim().slice(0, 64)
  const labels = [query.statementType, query.status, query.queryTags?.oc_tool, client].filter((label): label is string => typeof label === "string" && label.length > 0)
  const name = query.userName?.trim()
  const actor = name ? { role: "author", id: userActor(host, name), name: name.slice(0, 200) } : query.userId === undefined ? undefined : { role: "author", id: `databricks:${host}:user:${query.userId}` }
  return {
    id: query.queryId,
    start,
    ...(end === undefined ? {} : { end }),
    ...(final && !TERMINAL.has(query.status) ? { silent: true } : {}),
    draft: {
      kind: "x-databricks/query",
      title: `${query.statementType ?? "statement"} on ${query.warehouseId ?? "a warehouse"}: ${query.status}, ${durationText(duration)}, ${query.rowsProduced ?? 0} rows`,
      labels,
      actors: actor === undefined ? [] : [actor],
    },
  }
}

const queries: Adapter = {
  source: "queries",
  retentionMs: QUERY_RETENTION_MS,
  // Longer than the longest statement: `STATEMENT_TIMEOUT` is at most 172,800 s (48 h).
  firstLookbackMs: 49 * HOUR,
  limitMax: 500,
  scopeKeys: ["warehouses"],
  operations: ["sql.history.queries.list"],
  pageRows: 1000,
  behindCap: 20,
  sliceCap: 10,
  jamCap: 100,
  keepRows: 5000,
  maxTracked: 400,
  owner: (context) => ownerOf({ id: context.identity!.userId, userName: context.identity!.userName, ...(context.identity!.displayName ? { displayName: context.identity!.displayName } : {}) }, context.deps.auth.account(context.account).host),
  async walk(context, from, to, capPages) {
    const warehouses = listOf(context.scope?.warehouses)
    const wanted = new Set(warehouses)
    const items: Item[] = []
    let oldest: number | undefined
    let calls = 0
    let truncated = false
    let pageToken: string | undefined
    for (;;) {
      if (calls >= capPages) {
        truncated = true
        break
      }
      const token = pageToken
      const answer = await provider(() =>
        context.deps.databricks.history(
          context.account,
          {
            userIds: [Number(context.identity!.userId)],
            ...(warehouses.length > 0 ? { warehouseIds: warehouses } : {}),
            startMs: from,
            endMs: to,
            maxResults: 1000,
            includeMetrics: false,
            ...(token === undefined ? {} : { pageToken: token }),
          },
          context.call.signal,
        ),
      )
      calls += 1
      for (const query of answer.items) {
        const start = query.queryStartTimeMs
        if (start < from || start > to) continue
        if (wanted.size > 0 && query.warehouseId !== undefined && !wanted.has(query.warehouseId)) continue
        items.push(queryItem(query, context.host))
        if (oldest === undefined || start < oldest) oldest = start
      }
      pageToken = answer.nextPageToken
      if (pageToken === undefined) break
    }
    return { items, truncated, ...(oldest === undefined ? {} : { oldest }), calls }
  },
  keyOf: (item) => refOf(item.id, item.start),
  async recheck(context, keys) {
    const found: Item[] = []
    // A reference: the one second it names, read whole (a person starts a handful of statements in a second at most).
    for (const key of keys) {
      const ref = parseRef(key)
      if (ref === undefined) continue
      const answer = await provider(() =>
        context.deps.databricks.history(
          context.account,
          { userIds: [Number(context.identity!.userId)], startMs: ref.second * 1000, endMs: ref.second * 1000 + 999, maxResults: 1000, includeMetrics: false },
          context.call.signal,
        ),
      )
      for (const query of answer.items) if (refOf(query.queryId, query.queryStartTimeMs) === key) found.push(queryItem(query, context.host))
    }
    // Ids (a cursor written before references): one call, the `statement_ids` filter over the widest range the API takes.
    const ids = keys.filter((key) => parseRef(key) === undefined)
    if (ids.length > 0) {
      const wanted = new Set(ids)
      const answer = await provider(() =>
        context.deps.databricks.history(
          context.account,
          { userIds: [Number(context.identity!.userId)], statementIds: ids, startMs: context.now - QUERY_RETENTION_MS + 60_000, endMs: context.now, maxResults: 1000, includeMetrics: false },
          context.call.signal,
        ),
      )
      for (const query of answer.items) if (wanted.has(query.queryId)) found.push(queryItem(query, context.host))
    }
    return found
  },
}

// ── runs: the Jobs API's finished runs ───────────────────────────────────

const RUN_TERMINAL = new Set(["TERMINATED", "SKIPPED", "INTERNAL_ERROR"])
const GONE = new Set(["NOT_FOUND", "PERMISSION_DENIED", "INPUT_INVALID"])


function runItem(run: RunInfo, host: string): Item {
  const terminal = RUN_TERMINAL.has(run.state.lifeCycleState)
  // `end_time` is 0 while a run is active; a terminal run without one ended when it started (a skipped run).
  const end = terminal ? Math.max(run.startTime, run.endTime && run.endTime > 0 ? run.endTime : run.startTime) : undefined
  const result = run.state.resultState ?? run.state.lifeCycleState
  const labels = [run.triggerType, result, run.runType].filter((label): label is string => typeof label === "string" && label.length > 0)
  return {
    id: String(run.runId),
    start: run.startTime,
    ...(end === undefined ? {} : { end }),
    draft: {
      kind: "x-databricks/run",
      title: `${run.runName ?? (run.jobId === undefined ? "run" : `job ${run.jobId}`)} run: ${result}, ${durationText((end ?? run.startTime) - run.startTime)}`,
      labels,
      actors: run.creatorUserName === undefined ? [] : [{ role: "author", id: userActor(host, run.creatorUserName), name: run.creatorUserName }],
    },
  }
}

const jobsOf = (scope: Scope | undefined): number[] =>
  listOf(scope?.jobs)
    .map((id) => Number(id))
    .filter((id) => Number.isSafeInteger(id))

const runs: Adapter = {
  source: "runs",
  retentionMs: RUN_RETENTION_MS,
  // `runs/list` pages 25 at a time, so a first read looks 6 h back for runs that started before `since` and ended after
  // it; a busier workspace than the walk's cap answers a gap for that part.
  firstLookbackMs: 6 * HOUR,
  limitMax: 500,
  scopeKeys: ["jobs"],
  operations: ["jobs.runs.list", "jobs.runs.get"],
  pageRows: 25,
  behindCap: 600,
  sliceCap: 40,
  jamCap: 400,
  keepRows: 250,
  maxTracked: 400,
  // A run source is a workspace's, not one person's: the page names the workspace account, and probe the identity.
  owner: (context) => workspaceOwner(context.deps.auth.account(context.account).host, context.account),
  async walk(context, from, to, capPages) {
    const jobs = jobsOf(context.scope)
    const targets: (number | undefined)[] = jobs.length > 0 ? jobs : [undefined]
    const items: Item[] = []
    let oldest: number | undefined
    let calls = 0
    let truncated = false
    for (const jobId of targets) {
      let pageToken: string | undefined
      for (;;) {
        if (calls >= capPages) {
          truncated = true
          break
        }
        const token = pageToken
        const answer = await provider(() =>
          context.deps.databricks.listRuns(
            context.account,
            { ...(jobId === undefined ? {} : { jobId }), startTimeFrom: from, startTimeTo: to, limit: 25, ...(token === undefined ? {} : { pageToken: token }) },
            context.call.signal,
          ),
        )
        calls += 1
        for (const run of answer.items) {
          if (run.startTime < from || run.startTime > to) continue
          items.push(runItem(run, context.host))
          if (oldest === undefined || run.startTime < oldest) oldest = run.startTime
        }
        pageToken = answer.nextPageToken
        if (pageToken === undefined) break
      }
      if (truncated) break
    }
    return { items, truncated, ...(oldest === undefined ? {} : { oldest }), calls }
  },
  keyOf: (item) => item.id,
  async recheck(context, ids) {
    const found: Item[] = []
    for (const id of ids) {
      try {
        found.push(runItem(await context.deps.databricks.getRun(context.account, Number(id), context.call.signal), context.host))
      } catch (error) {
        // A run that is gone (deleted, or past retention) or no longer readable is dropped: there is nothing to list.
        if (error instanceof DatabricksError && GONE.has(error.code)) continue
        throw sourceErrorOf(error)
      }
    }
    return found
  },
}

const ADAPTERS: Record<SourceName, Adapter> = { queries, runs }
