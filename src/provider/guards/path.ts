/**
 * The SQL path check (design §5.1, `PATH_RULE` in `src/domain/functions.ts`): a read that uses a keyword form
 * (`EXTRACT`, `TRIM(BOTH … FROM …)`, `BETWEEN`, …), a `LATERAL VIEW` generator, `count(*)`, an unqualified table or a
 * function body's keyword form resolves a name along the session's SQL path, which a workspace admin can change. The
 * plugin qualifies every explicit built-in call, so those are safe anywhere; these cannot be qualified in SQL.
 *
 * So before such a read runs, the guard asks the warehouse for `current_path()` [Databricks: `current_path` function]
 * and refuses `PATH_NOT_DEFAULT` unless `pathIsSafe` holds: `system.builtin` present, and nothing before it but
 * `system.session` (harmless: a statement sent alone has no temporary functions, and this plugin never creates one).
 *
 * - One query per account and warehouse, cached 5 minutes (`PATH_TTL_MS`); the answer is the session path, which
 *   `SET PATH` changes per session, and the Statement API runs every statement in a fresh session.
 * - The probe is a statement on the warehouse, so it runs only after the warehouse policy: the caller checks the
 *   warehouse first.
 * - No answer, a failed probe or an answer that is not a string is `UNAVAILABLE`: the plugin cannot prove the path, so it
 *   must not send the read.
 * - The probe is charged to no ledger: it is the guard's own one-row control statement, not a read the person asked for.
 */
import { DatabricksError } from "../../domain/errors.js"
import { pathIsSafe } from "../functions.js"
import type { Clock, DatabricksPort } from "../../ports.js"
import { analyzeRead } from "../sql/analyze.js"
import { safeText } from "./pattern.js"

export const PATH_TTL_MS = 5 * 60_000
/** The probe's text, before `analyzeRead` qualifies it: fixed, never the caller's. */
export const PATH_PROBE = "SELECT system.builtin.`current_path`()"

export interface PathPorts {
  readonly databricks: DatabricksPort
  readonly now: () => number
}

/** One cache per Databricks port (one per plugin setup, one per fake in a test). */
const caches = new WeakMap<object, Map<string, { readonly at: number; readonly path: string }>>()

function cacheOf(ports: PathPorts): Map<string, { at: number; path: string }> {
  let cache = caches.get(ports.databricks)
  if (!cache) {
    cache = new Map()
    caches.set(ports.databricks, cache)
  }
  return cache
}

export interface PathQuery {
  readonly account: string
  readonly warehouseId: string
  /** The session whose hash labels the probe in Query History. */
  readonly sessionID: string
}

/** The session path, from the cache or one probe statement. Throws rather than guessing. */
export async function sessionPath(ports: PathPorts, query: PathQuery, signal: AbortSignal): Promise<string> {
  const key = `${query.account}|${query.warehouseId}`
  const cache = cacheOf(ports)
  const cached = cache.get(key)
  const now = ports.now()
  if (cached && now - cached.at <= PATH_TTL_MS) return cached.path
  const probe = analyzeRead(PATH_PROBE)
  if (!probe.ok) throw new DatabricksError("SQL_UNSUPPORTED", "The plugin's own current_path() probe does not parse; refusing the read rather than guessing the path.", "Report this: the pinned grammar should parse it.")
  let answer: Awaited<ReturnType<DatabricksPort["submit"]>>
  try {
    answer = await ports.databricks.submit(
      {
        account: query.account,
        operation: "sql.statements.query",
        statement: probe.sent,
        warehouseId: query.warehouseId,
        rowLimit: 1,
        byteLimit: 64 * 1024,
        disposition: "INLINE",
        format: "JSON_ARRAY",
        waitTimeout: 50,
        onWaitTimeout: "CANCEL",
        queryTags: { oc_plugin: "databricks", oc_tool: "path-check", oc_session: sessionToken(query.sessionID), oc_call: "path-check" },
      },
      signal,
    )
  } catch (error) {
    if (error instanceof DatabricksError) throw new DatabricksError("UNAVAILABLE", `The plugin could not read current_path() to check this read's SQL path (${error.code}).`, "Try again, or write the call in its function form, which the plugin qualifies as system.builtin.")
    throw error
  }
  const value = answer.rows?.[0]?.[0]
  if (answer.state !== "SUCCEEDED" || typeof value !== "string") {
    throw new DatabricksError("UNAVAILABLE", "The plugin could not read current_path() to check this read's SQL path.", "Try again, or write the call in its function form, which the plugin qualifies as system.builtin.")
  }
  cache.set(key, { at: now, path: value })
  return value
}

/** The `PATH_NOT_DEFAULT` refusal, or nothing when the path keeps `system.builtin` before every user schema. */
export async function assertPathSafe(ports: PathPorts, query: PathQuery, signal: AbortSignal): Promise<void> {
  const path = await sessionPath(ports, query, signal)
  if (pathIsSafe(path)) return
  throw new DatabricksError(
    "PATH_NOT_DEFAULT",
    `The workspace's SQL path is ${safeText(path, 300)}, which does not put system.builtin before every user schema, so a keyword-form built-in or an unqualified name could resolve to a user object.`,
    "Ask an admin to restore the default path, or write the function call form, which the plugin qualifies as system.builtin.",
  )
}

/** A stable, short label for a session in a query tag: no session id leaves the process. */
export function sessionToken(sessionID: string): string {
  let hash = 0x811c9dc5
  for (const unit of sessionID) {
    hash ^= unit.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}
