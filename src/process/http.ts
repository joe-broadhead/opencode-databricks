/**
 * The transport under every Databricks call: `fetch`, the token, the retry rules and the statement-submit policy
 * (design §9). Nothing here decides what to call; `client.ts` holds the endpoints.
 *
 * - **Retries.** Only idempotent GETs and control calls are retried: on 429, on a 5xx and on the error codes Databricks
 *   marks temporary, with jittered exponential backoff that honours `Retry-After`, three tries in all. Then
 *   `RATE_LIMITED` (which names the server's wait) or `UNAVAILABLE`.
 * - **No blind statement retry.** `POST /api/2.0/sql/statements` has no idempotency key (Statement Execution API), so a
 *   submit whose answer never arrived is **never** sent again. `submitStatement` recovers instead: it lists Query
 *   History for that warehouse over the last two minutes and joins the statement whose `oc_call` tag (Query History
 *   API's `query_tags`) or exact wrapped `query_text` matches. If there is none, the call fails `UNAVAILABLE` and says
 *   it may have run.
 * - **A stopped call stops its statement.** `call.signal` aborts the request; the statement the call started is then
 *   cancelled with `POST /api/2.0/sql/statements/{id}/cancel`, so a stopped read does not keep a warehouse busy
 *   (design §9, §7 layer 2a).
 * - **Nothing over 10 MiB is parsed whole** (§9). A larger JSON answer fails `UNAVAILABLE`; result bytes are streamed
 *   through an external link instead (`links.ts`).
 * - **Secrets.** The bearer token is added here and nowhere else; an error carries Databricks' text only in
 *   `providerError`, redacted and with the token cut out by value.
 *
 * References: Statement Execution `POST /api/2.0/sql/statements`, `GET …/{statement_id}`,
 * `POST …/{statement_id}/cancel`; Query History `GET /api/2.0/sql/history/queries` (`filter_by.warehouse_ids`,
 * `filter_by.query_start_time_range`, `query_tags`, `is_final`, `max_results` ≤ 1000);
 * https://docs.databricks.com/api/statement-execution/v1/execute-statement and
 * https://docs.databricks.com/api/query-history/v1/list-queries.
 */
import { type Operation, SCOPE_OF } from "../domain/actions.js"
import { DatabricksError } from "../domain/errors.js"
import type { AuthPort, Token } from "../ports.js"
import { redact, withoutSecret } from "../redact.js"
import type { HistoryQuery, StatementAnswer } from "../ports.js"
import { statementBody, toHistoryQuery, toStatementAnswer } from "./statements.js"

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** A whole JSON answer's cap (design §9: "No response over 10 MiB is parsed whole"). */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024
/** Tries in all, initial attempt included. */
export const MAX_ATTEMPTS = 3
/** The first backoff, doubled each try and jittered; a `Retry-After` replaces it. */
export const RETRY_BASE_MS = 250
/** The longest one wait may be. A `Retry-After` beyond it fails the call at once instead of holding it for hours. */
export const MAX_RETRY_WAIT_MS = 30_000
/** Requests in flight per account (design §9). */
export const MAX_CONCURRENT_PER_ACCOUNT = 6
/** How far back Query History is read for an ambiguous submit (design §9: two minutes). */
export const RECOVERY_WINDOW_MS = 120_000
/** How far a history record's start may precede this call's own clock before it is another call's (clock skew). */
export const RECOVERY_SKEW_MS = 5_000

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
const RETRYABLE_CODES = new Set(["TEMPORARILY_UNAVAILABLE", "WORKSPACE_TEMPORARILY_UNAVAILABLE", "SERVICE_UNDER_MAINTENANCE", "REQUEST_LIMIT_EXCEEDED", "INTERNAL_ERROR"])

/** One queued request waiting for a slot in its account's limiter. */
interface Waiter {
  readonly signal: AbortSignal
  readonly resolve: () => void
  readonly onAbort: () => void
}

export type QueryValue = string | number | boolean | null | undefined | readonly (string | number | boolean)[]

export interface HttpRequest {
  readonly account: string
  readonly operation: Operation
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
  /** A path on the workspace host, starting with `/`. */
  readonly path: string
  readonly query?: Readonly<Record<string, QueryValue>>
  readonly body?: unknown
  /** True only for a call that is safe to repeat: a GET, or a control call (`cancel`, `start`, `stop`). */
  readonly idempotent?: boolean
  readonly signal: AbortSignal
}

export interface HttpAnswer {
  readonly status: number
  readonly body: unknown
}

export interface HttpOptions {
  readonly auth: AuthPort
  /** The global fetch unless a test supplies one. */
  readonly fetch?: Fetch
  readonly maxResponseBytes?: number
  readonly maxAttempts?: number
  readonly retryBaseMs?: number
  /** Test seam: a test records the waits instead of sleeping. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  readonly maxConcurrentPerAccount?: number
}

/** A failed call, with the HTTP status when the server answered at all. */
export class HttpError extends DatabricksError {
  readonly status: number | undefined
  /** No answer arrived: the request may or may not have reached Databricks. */
  readonly noAnswer: boolean
  /** The answer arrived but was over the cap, so it was not read: its statement id is lost with it. */
  readonly overCap: boolean

  constructor(code: ConstructorParameters<typeof DatabricksError>[0], message: string | undefined, next: string | undefined, options: { status?: number; noAnswer?: boolean; overCap?: boolean; retryAfterSec?: number; providerError?: ConstructorParameters<typeof DatabricksError>[3] }) {
    super(code, message, next, options.providerError, options.retryAfterSec !== undefined ? { retryAfterSec: options.retryAfterSec } : undefined)
    this.status = options.status
    this.noAnswer = options.noAnswer ?? false
    this.overCap = options.overCap ?? false
  }
}

const isAbort = (error: unknown, signal: AbortSignal): boolean =>
  signal.aborted || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))

/**
 * A stop. `sent` says whether this call's request had been written to the wire: a stop before that has nothing to
 * recover or cancel, and a stop after it may have started a statement (design §9).
 */
export class Cancelled extends DatabricksError {
  readonly sent: boolean

  constructor(sent: boolean) {
    super("CANCELLED")
    this.sent = sent
  }
}

const cancelled = (sent: boolean) => new Cancelled(sent)

/** A Redact-safe provider error from Databricks' error body or a statement's `status.error`. */
export function providerErrorOf(body: unknown, token?: Token): { errorCode?: string; sqlState?: string; message?: string; trust: "untrusted" } | undefined {
  if (!body || typeof body !== "object") return undefined
  const record = body as Record<string, unknown>
  const nested = typeof record.error === "object" && record.error ? (record.error as Record<string, unknown>) : undefined
  const code = [record.error_code, record.errorCode, nested?.error_code].find((value): value is string => typeof value === "string")
  const message = [record.message, nested?.message, record.error_description].find((value): value is string => typeof value === "string")
  const sqlState = [record.sql_state, record.sqlState].find((value): value is string => typeof value === "string")
  if (!code && !message && !sqlState) return undefined
  const clean = (text: string) => redact(withoutSecret(text, token?.accessToken)).slice(0, 500)
  return {
    ...(code ? { errorCode: clean(code) } : {}),
    ...(sqlState ? { sqlState: clean(sqlState) } : {}),
    ...(message ? { message: clean(message) } : {}),
    trust: "untrusted",
  }
}

/** A `Retry-After` header as seconds: a number of seconds, or an HTTP date. */
export function retryAfterSec(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)
  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - now) / 1000)) : undefined
}

/** The status a failure maps to when the server answered, before any caller's own refinement. */
function statusError(status: number, body: unknown, token: Token, retryAfter?: number, askingForMs?: number): HttpError {
  const providerError = providerErrorOf(body, token)
  const message = providerError?.message ? undefined : `Databricks answered HTTP ${status}.`
  switch (status) {
    case 401:
      return new HttpError("AUTH_REQUIRED", "Databricks refused the access token.", undefined, { status, providerError })
    case 403:
      return new HttpError("PERMISSION_DENIED", message, undefined, { status, providerError })
    case 404:
      return new HttpError("NOT_FOUND", message, undefined, { status, providerError })
    case 429:
      return new HttpError(
        "RATE_LIMITED",
        askingForMs !== undefined
          ? `Databricks answered 429 and asked for a ${Math.ceil(askingForMs / 1000)} s wait, longer than a call may hold; make the same call after ${retryAfter ?? 1} s.`
          : `Databricks answered 429; make the same call after ${retryAfter ?? 1} s.`,
        undefined,
        { status, providerError, ...(retryAfter !== undefined ? { retryAfterSec: retryAfter } : {}) },
      )
    default:
      return new HttpError("UNAVAILABLE", message, undefined, { status, providerError })
  }
}

/** Reads a response body up to `cap` bytes; a larger answer is refused rather than parsed whole. */
async function readCapped(response: Response, cap: number): Promise<string> {
  if (!response.body) return await response.text()
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > cap) {
      await reader.cancel().catch(() => undefined)
      throw new HttpError("UNAVAILABLE", `Databricks sent an answer over ${cap} bytes, which is not parsed whole.`, "Narrow the query, or save the result to a file instead.", { overCap: true })
    }
    parts.push(value)
  }
  return Buffer.concat(parts.map((part) => Buffer.from(part))).toString("utf8")
}

/** Parses a JSON body; an empty body is `undefined` and text that is not JSON is kept as text. */
function parseBody(text: string): unknown {
  if (text.trim() === "") return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Builds the query string: repeated keys for an array, everything else as one value. */
export function queryString(query: Readonly<Record<string, QueryValue>> | undefined): string {
  if (!query) return ""
  const parameters = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) for (const item of value) parameters.append(key, String(item))
    else parameters.append(key, String(value))
  }
  const text = parameters.toString()
  return text ? `?${text}` : ""
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(cancelled(false))
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop)
      resolve()
    }, ms)
    const stop = () => {
      clearTimeout(timer)
      reject(cancelled(false))
    }
    signal.addEventListener("abort", stop, { once: true })
  })

/**
 * The workspace HTTP client: one token per call, at most six requests in flight per account, retries as the design
 * sets them, and every error in the plugin's own table.
 */
export class WorkspaceHttp {
  private readonly auth: AuthPort
  private readonly fetchImpl: Fetch
  private readonly maxBytes: number
  private readonly maxAttempts: number
  private readonly baseMs: number
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly limit: number
  /** Slots in use per account: a wake-up hands its slot over, so the count never dips for another caller to take. */
  private readonly active = new Map<string, number>()
  private readonly waiting = new Map<string, Waiter[]>()

  constructor(options: HttpOptions) {
    this.auth = options.auth
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
    this.maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES
    this.maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS
    this.baseMs = options.retryBaseMs ?? RETRY_BASE_MS
    this.sleep = options.sleep ?? defaultSleep
    this.limit = options.maxConcurrentPerAccount ?? MAX_CONCURRENT_PER_ACCOUNT
  }

  /** The account's scopes: the operation's own family, or none for a call that any token reaches. */
  static scopesFor(operation: Operation): readonly string[] {
    const scope = SCOPE_OF[operation]
    return scope === "any" ? [] : [scope]
  }

  /**
   * At most `limit` requests in flight for one account; the rest wait their turn, in order. A waiter that stops while
   * queued leaves the queue and fails `CANCELLED` without a request.
   */
  private async enter(account: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw cancelled(false)
    const active = this.active.get(account) ?? 0
    if (active < this.limit) {
      this.active.set(account, active + 1)
      return
    }
    await new Promise<void>((resolve, reject) => {
      const queue = this.waiting.get(account) ?? []
      let waiter: Waiter
      waiter = {
        signal,
        resolve: () => {
          signal.removeEventListener("abort", onAbort)
          resolve()
        },
        onAbort: () => {
          const index = queue.indexOf(waiter)
          if (index >= 0) queue.splice(index, 1)
          reject(cancelled(false))
        },
      }
      const onAbort = waiter.onAbort
      signal.addEventListener("abort", onAbort, { once: true })
      queue.push(waiter)
      this.waiting.set(account, queue)
      // The signal may have stopped between the check above and the listener: then this waiter never runs.
      if (signal.aborted) onAbort()
    })
  }

  /** Frees a slot: it passes straight to the next waiter, or the count goes down. */
  private leave(account: string): void {
    const next = this.waiting.get(account)?.shift()
    if (next) {
      next.resolve()
      return
    }
    this.active.set(account, Math.max(0, (this.active.get(account) ?? 1) - 1))
  }

  async request(request: HttpRequest): Promise<HttpAnswer> {
    if (request.signal.aborted) throw cancelled(false)
    const account = this.auth.account(request.account)
    const token = await this.auth.token(account.alias, WorkspaceHttp.scopesFor(request.operation), request.signal)
    // The token is minted for one host, and the request goes there: never to whatever the account says now.
    const url = `${token.host.replace(/\/$/u, "")}${request.path}${queryString(request.query)}`
    let attempt = 0
    for (;;) {
      attempt++
      await this.enter(account.alias, request.signal)
      let failure: DatabricksError | undefined
      let retryWait: number | undefined
      try {
        const response = await this.fetchImpl(url, {
          method: request.method,
          headers: {
            Authorization: `Bearer ${token.accessToken}`,
            Accept: "application/json",
            ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          redirect: "error",
          signal: request.signal,
        })
        const text = await readCapped(response, this.maxBytes)
        const body = parseBody(text)
        if (response.ok) return { status: response.status, body }
        const provider = providerErrorOf(body, token)
        const retryAfter = retryAfterSec(response.headers.get("retry-after"))
        const retryable = RETRYABLE_STATUS.has(response.status) || (provider?.errorCode !== undefined && RETRYABLE_CODES.has(provider.errorCode))
        const wait = retryAfter !== undefined ? retryAfter * 1000 : this.backoffMs(attempt)
        // A server that asks for a wait longer than a call may last ends the call now, with its number, not after hours.
        if (retryable && request.idempotent && attempt < this.maxAttempts && wait <= MAX_RETRY_WAIT_MS) retryWait = wait
        else failure = statusError(response.status, body, token, retryAfter, wait > MAX_RETRY_WAIT_MS ? wait : undefined)
      } catch (error) {
        if (isAbort(error, request.signal)) failure = cancelled(true)
        else if (error instanceof DatabricksError) failure = error
        else if (!request.idempotent || attempt >= this.maxAttempts) failure = this.transportError(error, token)
        else retryWait = this.backoffMs(attempt)
      } finally {
        this.leave(account.alias)
      }
      if (failure) throw failure
      await this.sleep(retryWait ?? 0, request.signal)
    }
  }

  /** The jittered backoff: the base doubled per try, at most 8 s, 50–100% of it. */
  private backoffMs(attempt: number): number {
    const ceiling = Math.min(this.baseMs * 2 ** (attempt - 1), 8_000)
    return Math.round(ceiling * (0.5 + Math.random() / 2))
  }

  private transportError(error: unknown, token: Token): HttpError {
    const text = error instanceof Error ? withoutSecret(error.message, token.accessToken) : String(error)
    return new HttpError("UNAVAILABLE", `Databricks could not be reached (${redact(text) || "no reason given"}).`, "Make the same call later.", { noAnswer: true })
  }
}

// ── the statement submit: no blind retry, history recovery, signal → cancel (design §9) ──────────────────────

/** The operations a submit may name. */
export type StatementOperation = "sql.statements.query" | "sql.statements.change"

export interface StatementRequestLike {
  readonly account: string
  readonly operation: StatementOperation
  readonly statement: string
  readonly warehouseId: string
  readonly catalog?: string
  readonly schema?: string
  readonly parameters?: readonly { readonly name: string; readonly value: string | null; readonly type?: string }[]
  readonly rowLimit?: number
  readonly byteLimit?: number
  readonly disposition: "INLINE" | "EXTERNAL_LINKS"
  readonly format: "JSON_ARRAY" | "ARROW_STREAM"
  readonly waitTimeout: number
  readonly onWaitTimeout: "CANCEL" | "CONTINUE"
  readonly queryTags: Readonly<Record<string, string>>
}

export interface SubmitOptions {
  readonly now?: () => number
  /** How long a recovery may take; a stopped call must not wait long. */
  readonly recoveryTimeoutMs?: number
}

/** A statement found in Query History: its id is the Query History `query_id`, which is the statement id. */
export interface Recovered {
  readonly statementId: string
}

export class Statements {
  private readonly identities = new Map<string, number>()

  constructor(private readonly http: WorkspaceHttp, private readonly options: SubmitOptions = {}) {}

  private get now(): number {
    return (this.options.now ?? Date.now)()
  }

  /** The history filter an ambiguous submit searches (design §9). */
  static recoveryQuery(warehouseId: string, startMs: number, endMs: number): Readonly<Record<string, QueryValue>> {
    return {
      "filter_by.warehouse_ids": [warehouseId],
      "filter_by.query_start_time_range.start_time_ms": startMs,
      "filter_by.query_start_time_range.end_time_ms": endMs,
      max_results: 1000,
    }
  }

  /**
   * Finds the statement an ambiguous submit started (design §9). Two matches are allowed, and no others:
   *
   * - this call's own `oc_call` tag, which is unique to the call (a record carrying *another* `oc_call` never matches);
   * - because query tags are Public Preview, the exact wrapped text of a record that carries **no** `oc_call` tag, that
   *   started no earlier than this submit (less a small clock skew), and that names this identity when Query History
   *   says who ran it.
   *
   * Without (a) and (b) the recovery would join — or cancel — another run of the same query, including a colleague's.
   */
  async recover(request: StatementRequestLike, checkpoint: { readonly startedAt: number }, signal: AbortSignal): Promise<Recovered | undefined> {
    const end = this.now
    const page = await this.http.request({
      account: request.account,
      operation: "sql.history.queries.list",
      method: "GET",
      path: "/api/2.0/sql/history/queries",
      query: Statements.recoveryQuery(request.warehouseId, checkpoint.startedAt - RECOVERY_WINDOW_MS, end),
      idempotent: true,
      signal,
    })
    const record = page.body as { res?: readonly unknown[] } | undefined
    const callTag = request.queryTags.oc_call
    const cutoff = checkpoint.startedAt - RECOVERY_SKEW_MS
    const identity = await this.currentUserId(request.account, signal)
    const mine = (item: HistoryQuery) =>
      identity === undefined ||
      item.userId === identity ||
      item.executedAsUserId === identity ||
      (item.userId === undefined && item.executedAsUserId === undefined)
    const matches = (record?.res ?? [])
      .map((item) => toHistoryQuery(item))
      .filter((item) => item.warehouseId === undefined || item.warehouseId === request.warehouseId)
      .filter((item) => item.queryStartTimeMs >= cutoff)
      .filter((item) => (callTag !== undefined && item.queryTags?.oc_call === callTag) || (item.queryTags?.oc_call === undefined && item.queryText === request.statement && mine(item)))
    const found = matches.sort((a, b) => b.queryStartTimeMs - a.queryStartTimeMs)[0]
    return found ? { statementId: found.queryId } : undefined
  }

  /** The identity's Query History user id, or undefined when the sign-in cannot read Me (the filter is then skipped). */
  private async currentUserId(account: string, signal: AbortSignal): Promise<number | undefined> {
    const cached = this.identities.get(account)
    if (cached !== undefined) return cached
    try {
      const answer = await this.http.request({ account, operation: "scim.me.get", method: "GET", path: "/api/2.0/preview/scim/v2/Me", idempotent: true, signal })
      const id = Number((answer.body as { id?: unknown } | undefined)?.id)
      if (!Number.isSafeInteger(id) || id <= 0) return undefined
      this.identities.set(account, id)
      return id
    } catch {
      return undefined
    }
  }

  /**
   * Submits once. A submit that may have reached the server is never sent again: if its answer never arrives, this
   * joins the statement from Query History instead, and answers `UNAVAILABLE` only when there is nothing to join.
   * A stopped call cancels the statement it started before it throws `CANCELLED`; a stop before anything was sent has
   * nothing to recover.
   */
  async submit(request: StatementRequestLike, signal: AbortSignal): Promise<StatementAnswer> {
    const body = statementBody(request)
    const checkpoint = { startedAt: this.now }
    let answer: HttpAnswer
    try {
      answer = await this.http.request({
        account: request.account,
        operation: request.operation,
        method: "POST",
        path: "/api/2.0/sql/statements",
        body,
        // The one call the design forbids retrying: no idempotency key exists (design §9).
        idempotent: false,
        signal,
      })
    } catch (error) {
      if (error instanceof DatabricksError && error.code === "CANCELLED") {
        // A stop before the request was sent has nothing that may have run; a stop after it cancels what it started.
        if (error instanceof Cancelled && !error.sent) throw error
        const confirmed = await this.cancelRecovered(request, checkpoint)
        throw confirmed ? error : new DatabricksError("CANCELLED", "The call was stopped, but Databricks did not confirm the cancel, so the statement may still be running.", "Check databricks_history; databricks_cancel can end it.")
      }
      if (!(error instanceof HttpError)) throw error
      const ambiguous = error.noAnswer || error.overCap === true || (error.status !== undefined && error.status >= 500)
      if (!ambiguous) {
        // A 400 or 422 is Databricks rejecting the request. Only a parse error is SQL_INVALID (the design's meaning);
        // an invalid parameter is the input's fault, not the SQL's.
        if (error.status === 400 || error.status === 422) throw rejected(error)
        throw error
      }
      const found = await this.recoverQuietly(request, checkpoint)
      if (!found) {
        throw new DatabricksError(
          "UNAVAILABLE",
          "The statement may have run, but Databricks did not answer and Query History has no record of it.",
          "Check databricks_history before calling again.",
        )
      }
      const joined = await this.getJoined(request.account, found.statementId)
      return { ...joined, ambiguous: true }
    }
    return toStatementAnswer(answer.body)
  }

  /** The statement a recovered submit names, read once so the caller gets its state and rows. */
  private async getJoined(account: string, statementId: string): Promise<StatementAnswer> {
    const safeId = redact(statementId).slice(0, 128)
    try {
      const answer = await this.http.request({
        account,
        operation: "sql.statements.get",
        method: "GET",
        path: `/api/2.0/sql/statements/${encodeURIComponent(statementId)}`,
        idempotent: true,
        signal: AbortSignal.timeout(this.options.recoveryTimeoutMs ?? 10_000),
      })
      return toStatementAnswer(answer.body)
    } catch (error) {
      // The history record named a statement this workspace will not answer (a different id space, a race, a timeout):
      // the call is still ambiguous, not "not found".
      throw new DatabricksError(
        "UNAVAILABLE",
        `The statement may have run; Query History named ${safeId}, and it could not be read.`,
        "Check databricks_history before calling again.",
        error instanceof DatabricksError ? error.providerError : undefined,
      )
    }
  }

  private async recoverQuietly(request: StatementRequestLike, checkpoint: { readonly startedAt: number }): Promise<Recovered | undefined> {
    const signal = AbortSignal.timeout(this.options.recoveryTimeoutMs ?? 10_000)
    try {
      return await this.recover(request, checkpoint, signal)
    } catch {
      return undefined
    }
  }

  /** Whether the cancel was confirmed; never throws. */
  private async cancelRecovered(request: StatementRequestLike, checkpoint: { readonly startedAt: number }): Promise<boolean> {
    const found = await this.recoverQuietly(request, checkpoint)
    if (!found) return false
    return this.http
      .request({
        account: request.account,
        operation: "sql.statements.cancel",
        method: "POST",
        path: `/api/2.0/sql/statements/${encodeURIComponent(found.statementId)}/cancel`,
        body: {},
        idempotent: true,
        signal: AbortSignal.timeout(this.options.recoveryTimeoutMs ?? 10_000),
      })
      .then(() => true, () => false)
  }
}

/** A 400 or 422 from the submit: a parse error is SQL_INVALID; anything else is an invalid request. */
function rejected(error: HttpError): DatabricksError {
  const provider = error.providerError
  const text = `${provider?.errorCode ?? ""} ${provider?.message ?? ""}`
  const parse = /PARSE_|SYNTAX|ParseException|SQLSTATE: 42/u.test(text)
  return parse
    ? new DatabricksError("SQL_INVALID", undefined, undefined, provider)
    : new DatabricksError("INPUT_INVALID", `Databricks rejected the request's parameters${provider?.errorCode ? ` (${redact(provider.errorCode)})` : ""}.`, "Check the call's parameters; databricks_explain checks a read's SQL.", provider)
}
