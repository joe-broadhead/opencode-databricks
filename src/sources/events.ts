/**
 * `databricks.queries` and `databricks.runs` (design §11.1, §11.2), the plugin's two event sources, over one page
 * engine:
 *
 * - a page is built oldest-first by `(occurred_at, id)`, and its cursor carries the window (`f`, `w`), the hashes of the
 *   ids already emitted (`h`) and the gap line (`g`);
 * - **late arrivals** are read by a lookback before the watermark: Query History filters by **start** time [24] and a
 *   statement can run for hours, and a job run can last days [29], so every read re-reads the window and de-duplicates
 *   by id hash. The lookback is 49 h for statements (longer than the longest `STATEMENT_TIMEOUT`, 172,800 s [20]) and
 *   72 h for runs, plus the run ids still active when the window ended, checked with `runs/get`;
 * - **a gap is reported once per shortening and never per read**: the page where a truncation is discovered carries
 *   `gap`, and the cursor's `g` suppresses it on the next page of the same window; the line is the window's `f`,
 *   carried, never recomputed from "now" (the sliding gap);
 * - **a jam drains**: ties at one timestamp are ordered by id, a burst larger than a page is walked by the cursor's
 *   window and hash set, and a walk past `maxWalkPages` (10 × 1,000 for history, 40 × 25 for runs) answers a
 *   `window-truncated` gap and carries the oldest fetched start as the next window's end, so the older part is read
 *   next rather than dropped;
 * - **expiry is honest**: Query History answers at most 30 days a call and documents no retention beyond that [24], and
 *   Databricks keeps run history 60 days [29]. A cursor older than the source's retention answers
 *   `gap: { reason: "expired" }` and a cursor that restarts; `noExpiry` is false for both.
 *
 * Query History is read without a status filter (filtering by several statuses "is not recommended" [24]) and filtered
 * locally to `is_final` terminal rows. The event's title is the plugin's own wording; `text` is empty, because SQL holds
 * literals and secrets and a run's state message can hold data (design §11.1, §11.2).
 */
import { fitPage, makeEvent, parseEventsListInput, screenEvents, startTime, type EventsListResult, type RefusedEvent, type Scope, type SourceEvent } from "@we-the-rebel-alliance/source-contract/events"
import { PLUGIN_ID } from "../constants.js"
import type { HistoryQuery, RunInfo } from "../ports.js"
import type { Deps } from "../registry.js"
import type { Call } from "../tool-spec.js"
import { assertSourceRead } from "./assert.js"
import { bindingOf, decodeState, encodeState, hashOf, iso, MAX_HASHES, MAX_PENDING, pendingOf, pendingString, unpackHashes, withHashes, type CursorState } from "./cursor.js"
import { sourceError, sourceErrorOf } from "./errors.js"
import { hostName, ownerOf, workspaceOwner } from "./owner.js"

/** The source names, as `events_list`'s `source` input and the descriptor's `input.source` name them. */
export type SourceName = "queries" | "runs"

export const SOURCE_NAMES: readonly SourceName[] = ["queries", "runs"]

/** 30 days: one Query History call's limit, and the age past which the source assumes older history is gone [24]. */
export const QUERY_RETENTION_MS = 30 * 86_400_000
/** 60 days: Databricks "retains run history for 60 days" (https://docs.databricks.com/aws/en/jobs/monitor). */
export const RUN_RETENTION_MS = 60 * 86_400_000
/** Longer than the longest statement run: `STATEMENT_TIMEOUT`'s 172,800 s [20]. */
export const QUERY_LOOKBACK_MS = 49 * 3_600_000
/** Runs can last days (`timeout_seconds` defaults to no timeout [29]); the design's 72 h. */
export const RUN_LOOKBACK_MS = 72 * 3_600_000
export const HISTORY_PAGES = 10
export const RUN_PAGES = 40

/** The page request every source's page needs. */
export interface PageRequest {
  readonly account: string
  readonly source: SourceName
  readonly cursor?: string
  readonly since?: string
  readonly limit?: number
  readonly scope?: Readonly<Record<string, readonly string[]>>
  readonly call: Call
}

/** One item a source found: its identity, the time it became visible, and the event it becomes. */
interface Candidate {
  readonly id: string
  readonly start: number
  readonly end: number
  readonly draft: { readonly kind: string; readonly title: string; readonly labels: readonly string[]; readonly actors: readonly { readonly role: string; readonly id: string; readonly name?: string }[] }
}

interface FetchResult {
  readonly candidates: readonly Candidate[]
  /** The walk stopped at its page cap with more history in the window. */
  readonly truncated: boolean
  /** The oldest start the walk fetched: the next window's end when truncated. */
  readonly oldestStart?: number
  readonly failed?: readonly { readonly id: string; readonly code: string }[]
  readonly pending?: readonly number[]
  readonly pendingOverflow?: boolean
  /** The page token the walk stopped at, and the job it belongs to. */
  readonly resume?: { readonly jobId?: number; readonly token: string }
}

interface SourceAdapter {
  readonly source: SourceName
  readonly lookbackMs: number
  readonly retentionMs: number
  readonly limitMax: number
  readonly scopeKeys: readonly string[]
  readonly owner: (deps: Deps, account: string, call: Call) => Promise<{ readonly id: string; readonly label: string }>
  readonly pending?: (deps: Deps, account: string, state: CursorState, call: Call) => Promise<{ readonly candidates: readonly Candidate[]; readonly failed: readonly { readonly id: string; readonly code: string }[] }>
  readonly fetch: (deps: Deps, account: string, from: number, to: number, scope: Scope | undefined, call: Call, options: { readonly limit: number; readonly resume?: { readonly jobId?: number; readonly token: string } }) => Promise<FetchResult>
}

/** The id and account a source's `events_list` is for, checked against the plugin's accounts. */
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

/**
 * One page of an event source: validate the input, refuse or expire a cursor, read the window, screen the events, and
 * answer the contract's page with its cursor, gap, refused and (for runs) failed parts.
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
  const now = deps.clock.now()
  const limit = Math.min(value.limit ?? 100, adapter.limitMax)
  // The read's own grants: its action on every operation it uses, before the first call.
  await assertSourceRead(deps.permission, request.call, "databricks.events_list", operationSet(request.source), account)
  const owner = await adapter.owner(deps, account, request.call)

  let state: CursorState
  if (value.cursor !== undefined) {
    const decoded = decodeState(binding, value.cursor)
    if (!decoded.ok) throw sourceError(decoded.code, decoded.what, "Start again with since, or pass the cursor with the source, account and scope it was issued for.")
    state = decoded.state
    if (state.w < now - adapter.retentionMs || state.f < now - adapter.retentionMs) {
      // The provider no longer keeps the history the cursor points at: say where it was lost, and restart cleanly.
      const fresh: CursorState = { w: now, f: now - adapter.lookbackMs, h: "" }
      return pageResult({
        source: request.source,
        account,
        owner,
        events: [],
        cursor: encodeState(binding, fresh),
        more: false,
        gap: { reason: "expired", since: iso(state.w) },
        ...(scope ? { scope: canonical(scope) } : {}),
      })
    }
  } else {
    const from = startTime(value, now)
    if (from < now - adapter.retentionMs) {
      const fresh: CursorState = { w: now, f: now - adapter.lookbackMs, h: "" }
      return pageResult({
        source: request.source,
        account,
        owner,
        events: [],
        cursor: encodeState(binding, fresh),
        more: false,
        gap: { reason: "expired", since: iso(from) },
        ...(scope ? { scope: canonical(scope) } : {}),
      })
    }
    state = { w: now, f: Math.max(from, now - adapter.retentionMs), h: "" }
  }

  // A run that was still active when the window ended is checked again: its end is what makes it an event.
  let pendingCandidates: readonly Candidate[] = []
  let failed: readonly { readonly id: string; readonly code: string }[] = []
  if (adapter.pending) {
    const checked = await adapter.pending(deps, account, state, request.call)
    pendingCandidates = checked.candidates
    failed = checked.failed
  }

  const resume = state.t === undefined ? undefined : decodeResume(state.t)
  const fetched = await adapter.fetch(deps, account, state.f, state.w, scope, request.call, { limit, ...(resume === undefined ? {} : { resume }) })
  const usePosition = adapter.source === "queries"
  const seen = new Set(unpackHashes(state.h))
  const hashed = [...fetched.candidates, ...pendingCandidates]
    .filter((candidate) => candidate.start >= state.f && candidate.start <= state.w)
    .map((candidate) => ({ candidate, hash: hashOf(candidate.id) }))
    .filter((entry) => !seen.has(entry.hash))
    .filter((entry) => {
      // The position the last page reached in this window: it drains a burst larger than the hash set without repeating
      // a row. Ties are walked by the id's hash, so the position and the order are one rule. A page token walk needs no
      // position: its pages are read once each, in the provider's own order.
      if (!usePosition || state.p === undefined) return true
      return entry.candidate.end > state.p.e || (entry.candidate.end === state.p.e && entry.hash > state.p.h)
    })
    .sort((left, right) => (left.candidate.end === right.candidate.end ? (left.hash < right.hash ? -1 : 1) : left.candidate.end - right.candidate.end))
  const all = hashed.map((entry) => entry.candidate)
  const unique: Candidate[] = []
  const ids = new Set<string>()
  for (const candidate of all) {
    if (ids.has(candidate.id)) continue
    ids.add(candidate.id)
    unique.push(candidate)
  }

  const built = unique.map((candidate) =>
    makeEvent({
      source: request.source,
      account,
      external_id: candidate.id,
      kind: candidate.draft.kind as never,
      occurred_at: candidate.end,
      title: candidate.draft.title,
      text: "",
      url: null,
      labels: candidate.draft.labels,
      actors: candidate.draft.actors,
    }),
  )
  const screened = screenEvents(built, { ownedBy: () => true })
  // A page is at most the hash set's capacity: the cursor has 1,024 characters, so it keeps 64 ids, and a page larger
  // than that could not de-duplicate its own boundary when the next window re-reads it.
  const take = fitPage(screened.events, Math.min(limit, MAX_HASHES))
  const events = screened.events.slice(0, take)
  const position = !usePosition ? undefined : events.length > 0 ? { e: Date.parse(events[events.length - 1]!.occurred_at), h: hashOf(events[events.length - 1]!.external_id) } : state.p
  const refused = screened.refused
  const remaining = unique.length - events.length

  const added = withHashes(state.h, events.map((event) => hashOf(event.external_id)))
  let next: CursorState
  let gap: EventsListResult["gap"]
  let more: boolean
  if (fetched.truncated) {
    // A walk that stopped at its cap either keeps its place in the provider's own paging (the runs source's page token:
    // the only way a same-start burst larger than one page drains exactly once), or narrows the window to the oldest
    // start it fetched (the history source's 10,000-row cap), carrying that boundary — never "now" — into the cursor.
    const boundary = fetched.oldestStart ?? state.f
    const older = fetched.resume === undefined && boundary > state.f
    more = true
    next = { w: older ? boundary : state.w, f: state.f, h: added.packed, ...(state.g === undefined ? {} : { g: state.g }) }
    // A page token loses nothing: it is the read continuing, not a gap. Only a window that cannot be narrowed is one.
    if (older && state.g !== 1) {
      gap = { reason: "window-truncated", since: iso(state.f) }
      next.g = 1
    }
    // A continuation reads the older part of the window, so the position inside the newer part no longer applies.
    if (older || position === undefined) delete next.p
    else next.p = position
    if (adapter.source === "runs") {
      next.z = pendingString(fetched.pending ?? pendingOf(state))
      // The token only moves past pages whose runs are all emitted: a page that did not fit is read again, from the
      // saved token (or from the window's start when there is none), and the hashes drop what was already delivered.
      if (fetched.resume && remaining === 0) next.t = encodeResume(fetched.resume)
      else if (state.t !== undefined) next.t = state.t
    }
  } else if (remaining > 0) {
    more = true
    next = {
      w: state.w,
      f: state.f,
      h: added.packed,
      ...(state.g === undefined ? {} : { g: state.g }),
      ...(position === undefined ? {} : { p: position }),
      ...(adapter.source === "runs" ? { z: pendingString(fetched.pending ?? pendingOf(state)), ...(fetched.resume === undefined ? {} : { t: encodeResume(fetched.resume) }) } : {}),
    }
  } else {
    more = false
    // A read that already announced a gap moves on incrementally: its next window starts at the frontier, because a
    // lookback larger than the walk's cap would truncate and gap on every read (the "gap once per shortening" rule).
    const incremental = state.g === 1
    const shortened = added.dropped && !incremental
    const from = shortened || incremental ? state.w : Math.max(state.w - adapter.lookbackMs, state.f)
    next = { w: now, f: from, h: shortened ? "" : added.packed, ...(adapter.source === "runs" ? { z: pendingString(fetched.pending ?? []) } : {}) }
    // A shortening of the lookback is a gap too, but one banner per read: a page that already announced one is silent.
    if (shortened && state.g !== 1) gap = { reason: "window-truncated", since: iso(state.w - adapter.lookbackMs) }
  }
  // A failure holds the consumer's cursor where it was, byte for byte: the same page is read again. A held cursor
  // cannot carry a gap's "already said" mark, so the page says nothing about lost history either.
  const held = failed.length > 0 ? value.cursor : undefined
  if (failed.length > 0) {
    more = true
    gap = undefined
    if (next !== undefined) delete next.g
  }
  if (fetched.pendingOverflow && !gap && state.g !== 1 && failed.length === 0) {
    // More than the cursor can hold of runs still active when the window ended: the ones beyond the cap are not
    // tracked, and the gap says so once.
    gap = { reason: "window-truncated", since: iso(state.f) }
    next.g = 1
    more = true
  }

  return pageResult({
    source: request.source,
    account,
    owner,
    events,
    ...(refused.length ? { refused } : {}),
    ...(failed.length ? { failed: failed.map((entry) => ({ external_id: entry.id, code: entry.code })) } : {}),
    ...(gap ? { gap } : {}),
    cursor: held ?? encodeState(binding, next),
    more,
    ...(scope ? { scope: canonical(scope) } : {}),
  })
}

/** The run walk's saved position: `<jobId base36 or empty>|<page token>`. */
const decodeResume = (value: string): { readonly jobId?: number; readonly token: string } | undefined => {
  const at = value.indexOf("|")
  if (at < 0) return undefined
  const job = value.slice(0, at)
  const token = value.slice(at + 1)
  if (!token || token.length > 400) return undefined
  return { ...(job === "" ? {} : { jobId: Number.parseInt(job, 36) }), token }
}
const encodeResume = (resume: { readonly jobId?: number; readonly token: string }): string => `${resume.jobId === undefined ? "" : resume.jobId.toString(36)}|${resume.token}`

const canonical = (scope: Scope): Record<string, string | string[]> => {
  const answer: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(scope)) answer[key] = typeof value === "string" ? value : [...value]
  return answer
}

const operationSet = (source: SourceName): readonly string[] => (source === "queries" ? ["sql.history.queries.list", "scim.me.get"] : ["jobs.runs.list", "jobs.runs.get"])

/** The contract's page, with this plugin's name on it. A v0.1.x consumer refuses `removals[]` and `owner.verified`, so neither is written. */
function pageResult(page: {
  source: SourceName
  account: string
  owner: { readonly id: string; readonly label: string }
  events: readonly SourceEvent[]
  cursor: string
  more: boolean
  refused?: readonly RefusedEvent[]
  failed?: readonly { readonly external_id: string; readonly code: string }[]
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
    ...(page.failed?.length ? { failed: [...page.failed] } : {}),
    ...(page.gap ? { gap: page.gap } : {}),
    plugin: PLUGIN_ID,
  }
}

// ── queries: Query History, the person's own finished statements ─────────

const TERMINAL = new Set(["FINISHED", "FAILED", "CANCELED"])

const queries: SourceAdapter = {
  source: "queries",
  lookbackMs: QUERY_LOOKBACK_MS,
  retentionMs: QUERY_RETENTION_MS,
  limitMax: 500,
  scopeKeys: ["warehouses"],
  owner: async (deps, account, call) => {
    const me = await deps.databricks.me(account, call.signal)
    return ownerOf(me, deps.auth.account(account).host)
  },
  async fetch(deps, account, from, to, scope, call, { limit }) {
    void limit
    const warehouses = scope?.warehouses
    const wanted = warehouses === undefined ? undefined : new Set((Array.isArray(warehouses) ? warehouses : [warehouses]).map(String))
    const me = await deps.databricks.me(account, call.signal)
    const candidates: Candidate[] = []
    let pageToken: string | undefined
    let pages = 0
    let truncated = false
    let oldest: number | undefined
    do {
      const page = await deps.databricks.history(
        account,
        {
          userIds: [Number(me.id)],
          startMs: from,
          endMs: to,
          maxResults: 1000,
          includeMetrics: false,
          ...(pageToken === undefined ? {} : { pageToken }),
        },
        call.signal,
      )
      for (const query of page.items) {
        const start = query.queryStartTimeMs
        if (start < from || start > to) continue
        if (query.isFinal !== true || !TERMINAL.has(query.status)) continue
        if (wanted && query.warehouseId !== undefined && !wanted.has(query.warehouseId)) continue
        const candidate = queryCandidate(query, hostName(deps.auth.account(account).host))
        candidates.push(candidate)
        if (oldest === undefined || start < oldest) oldest = start
      }
      pageToken = page.nextPageToken
      pages += 1
      if (pages >= HISTORY_PAGES && pageToken !== undefined) {
        truncated = true
        break
      }
    } while (pageToken !== undefined)
    return { candidates, truncated, ...(oldest === undefined ? {} : { oldestStart: oldest }) }
  },
}

function queryCandidate(query: HistoryQuery, host: string): Candidate {
  const end = query.queryEndTimeMs ?? query.queryStartTimeMs + (query.durationMs ?? 0)
  const duration = query.durationMs ?? Math.max(0, end - query.queryStartTimeMs)
  // The port carries the statement's type, status, warehouse and tags. `client_application` and the user's name are not
  // on the port yet (a contract request): the actor is named by its id, and the label set is what the port holds.
  const labels = [query.statementType, query.status, query.queryTags?.oc_tool].filter((label): label is string => typeof label === "string" && label.length > 0)
  return {
    id: `${host}:${query.queryId}`,
    start: query.queryStartTimeMs,
    end,
    draft: {
      kind: "x-databricks/query",
      title: `${query.statementType ?? "statement"} on ${query.warehouseId ?? "a warehouse"}: ${query.status}, ${durationText(duration)}, ${query.rowsProduced ?? 0} rows`,
      labels,
      actors: query.userId === undefined ? [] : [{ role: "author", id: `databricks:${host}:user:${query.userId}` }],
    },
  }
}

const userActor = (host: string, name: string) => (name.includes("@") ? `mailto:${name}` : `databricks:${host}:user:${name}`)

function durationText(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

// ── runs: the Jobs API's finished runs ───────────────────────────────────

const RUN_TERMINAL = new Set(["TERMINATED", "SKIPPED", "INTERNAL_ERROR"])

const runs: SourceAdapter = {
  source: "runs",
  lookbackMs: RUN_LOOKBACK_MS,
  retentionMs: RUN_RETENTION_MS,
  limitMax: 500,
  scopeKeys: ["jobs"],
  // A run source is a workspace's, not one person's: the declaration keeps identity reads to probe, so the page names
  // the workspace account and probe names the signed-in identity (the design's `permission.identity` rule).
  owner: async (deps, account) => workspaceOwner(deps.auth.account(account).host, account),
  async pending(deps, account, state, call) {
    const ids = pendingOf(state)
    const candidates: Candidate[] = []
    const failed: { id: string; code: string }[] = []
    for (const id of ids) {
      try {
        const run = await deps.databricks.getRun(account, id, call.signal)
        if (run.state.lifeCycleState !== undefined && RUN_TERMINAL.has(run.state.lifeCycleState) && run.endTime !== undefined) candidates.push(runCandidate(run, hostName(deps.auth.account(account).host)))
      } catch (error) {
        failed.push({ id: `${hostName(deps.auth.account(account).host)}:${id}`, code: sourceErrorOf(error).code })
      }
    }
    return { candidates, failed }
  },
  async fetch(deps, account, from, to, scope, call, { limit, resume }) {
    const host = hostName(deps.auth.account(account).host)
    // A run page is filled to the cursor's own capacity: every fetched run is then delivered, and the token moves past
    // the page, so a same-start burst larger than a page drains exactly once without re-reading a page.
    const target = Math.min(limit, MAX_HASHES)
    const jobs = jobsOf(scope)
    const candidates: Candidate[] = []
    const active = new Set<number>()
    let pagesWalked = 0
    let lastToken: { readonly jobId?: number; readonly token: string } | undefined
    let stopped = false
    const walk = async (jobId: number | undefined, token: string | undefined) => {
      let pageToken = token
      do {
        const page = await deps.databricks.listRuns(
          account,
          {
            ...(jobId === undefined ? {} : { jobId }),
            startTimeFrom: from,
            startTimeTo: to,
            limit: 25,
            ...(pageToken === undefined ? {} : { pageToken }),
          },
          call.signal,
        )
        const items = page.items.filter((run) => run.startTime >= from && run.startTime <= to)
        // Stop before a page that would not fit, so the token always names the first page not yet read: a same-start
        // burst drains exactly once, and the page never exceeds the consumer's limit.
        if (candidates.length > 0 && candidates.length + items.length > target) {
          stopped = true
          lastToken = pageToken === undefined ? undefined : { ...(jobId === undefined ? {} : { jobId }), token: pageToken }
          return
        }
        for (const run of items) {
          if (!RUN_TERMINAL.has(run.state.lifeCycleState) || run.endTime === undefined) {
            active.add(run.runId)
            continue
          }
          candidates.push(runCandidate(run, host))
        }
        const next = page.nextPageToken
        pagesWalked += 1
        lastToken = next === undefined ? undefined : { ...(jobId === undefined ? {} : { jobId }), token: next }
        if (candidates.length >= target || pagesWalked >= RUN_PAGES) {
          stopped = true
          if (pagesWalked >= RUN_PAGES && next !== undefined) lastToken = { ...(jobId === undefined ? {} : { jobId }), token: next }
          return
        }
        pageToken = next
      } while (pageToken !== undefined)
    }
    const scoped = jobs.length > 0 ? jobs : [undefined]
    const resumeJob = resume?.jobId
    const startAt = resumeJob === undefined ? 0 : Math.max(0, scoped.findIndex((jobId) => jobId === resumeJob))
    for (let index = startAt; index < scoped.length; index++) {
      const jobId = scoped[index]
      await walk(jobId, index === startAt ? resume?.token : undefined)
      if (stopped) break
    }
    // A token is only safe to carry when the last page was fully consumed: all fetched runs are in this page or were
    // already emitted, so the next read resumes at the page after it.
    const more = lastToken !== undefined
    return {
      candidates,
      truncated: more,
      ...(more && lastToken ? { resume: lastToken } : {}),
      pending: [...active].slice(0, MAX_PENDING),
      pendingOverflow: active.size > MAX_PENDING,
    }
  },
}

const jobsOf = (scope: Scope | undefined): number[] => {
  const jobs = scope?.jobs
  if (jobs === undefined) return []
  const list = Array.isArray(jobs) ? jobs : [jobs]
  return list.map((id) => Number(id)).filter((id) => Number.isFinite(id))
}

function runCandidate(run: RunInfo, host: string): Candidate {
  const end = run.endTime ?? run.startTime
  const result = run.state.resultState ?? run.state.lifeCycleState
  const duration = end - run.startTime
  const labels = [run.triggerType, result, run.runType].filter((label): label is string => typeof label === "string" && label.length > 0)
  return {
    id: `${host}:${run.runId}`,
    start: run.startTime,
    end,
    draft: {
      kind: "x-databricks/run",
      title: `${run.runName ?? (run.jobId === undefined ? "run" : `job ${run.jobId}`)} run: ${result}, ${durationText(duration)}`,
      labels,
      actors: run.creatorUserName === undefined ? [] : [{ role: "author", id: userActor(host, run.creatorUserName), name: run.creatorUserName }],
    },
  }
}

const ADAPTERS: Record<SourceName, SourceAdapter> = { queries, runs }
