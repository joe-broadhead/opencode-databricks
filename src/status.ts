/**
 * Status (design §4, §14, §7 layer 3): one computation, used by three faces — the `databricks_status` tool, the
 * `/databricks-status` command and the TUI dialog — so they cannot drift.
 *
 * Every Databricks call here is free (control plane, no warehouse): `Me`, the warehouse list and Query History. The one
 * exception is `include: ["spend"]`, the reconciliation of the local estimate with `system.billing.usage` (design §6.2),
 * which runs one statement **through the read path** on the default warehouse, under the warehouse policy: it never
 * starts one. That statement is a read, and it is charged to the ledger like any other.
 *
 * Status never fails for a Databricks reason: an account that is not signed in, a missing scope or an unreachable
 * workspace becomes a `problem` and the rest is still reported. Nothing here changes anything: the status reports, and
 * `/databricks-cleanup` and the tools do the acting.
 */
import type { Plugin } from "@opencode/plugin"
import { accountSettings } from "./auth/accounts.js"
import type { Access } from "./constants.js"
import { DISPLAY_NAME, SUPPORTED_HOST, TESTED_HOSTS } from "./constants.js"
import { actionOf, type Feature, TOOLS } from "./domain/actions.js"
import { type AccountStatus, type CleanupAction, type Enforcement, type RunningItem, type Spend, type Status } from "./rpc.js"
import { type Output, POLICY_DISCLOSURE, WRITE_DISCLOSURE } from "./domain/contract.js"
import { DatabricksError } from "./domain/errors.js"
import { budgetOf, chargeStatement, reachedLimit } from "./guards/budget.js"
import { safeText } from "./guards/pattern.js"
import { sessionToken } from "./guards/path.js"
import { kindOf, sizeOf, usdPerHour } from "./guards/warehouse.js"
import { isTestedHost } from "./host-version.js"
import type { Options } from "./options.js"
import { defaultRules, unguardedAgents } from "./permissions.js"
import type { AccountInfo, DatabricksPort, HistoryQuery, LedgerPort, ReadGuardPort, StatementRequest, Token, Warehouse } from "./ports.js"
import type { AuthPort, Clock } from "./ports.js"
import { AGENT_STEP, DatabricksRpc, formatStatus, NOTHING_TO_DO, type SkillPath, STATUS_COMMAND } from "./rpc.js"
import { assertTool } from "./registry.js"
import type { Handler } from "./tool-spec.js"
import { PLUGIN_VERSION } from "./version.js"

const UNAVAILABLE = new DatabricksError("STATUS_UNAVAILABLE").message

/** The scopes a status call needs: the sign-in's base set (design §3.3), not a feature's. */
const BASE_SCOPES = ["sql", "unity-catalog", "query-history", "openid", "email", "profile", "offline_access"] as const
/** Query History is filtered by *start* time [24]; six hours bounds the scan and covers any idle period status reports. */
const HISTORY_WINDOW_MS = 6 * 60 * 60_000
/** Query History's page cap [24]. */
const HISTORY_PAGE = 1000
/** At most this many cleanup suggestions: the biggest first, so the dialog and the model stay readable. */
const MAX_CLEANUP = 10
/** Statements this plugin started are tagged `oc_plugin=databricks` and `oc_session=<hash>` (design §5.1 step 6). */
const PLUGIN_TAG = "databricks"
/** The tools whose statements are reads: the only ones automation or cleanup may cancel (design §7 layer 2(c)). */
const READ_TOOLS: ReadonlySet<string> = new Set(["status", "query", "profile", "explain", "table", "save", "saved_read", "path-check"])

const writesAt = (access: Access): AccountStatus["writes"] => (access === "all" ? "without asking" : access === "ask-changes" ? "ask" : "never")

/** The scopes an account asks for, before a token says what was granted (design §3.3). */
export function requestedScopes(options: Options, alias: string): string[] {
  const settings = accountSettings(options).find((account) => account.alias === alias)
  if (!settings) return [...BASE_SCOPES]
  if (settings.scopes === "all-apis") return ["all-apis", "offline_access"]
  const features: Record<Feature, string> = { jobs: "jobs", workspace: "workspace", files: "files" }
  return [...BASE_SCOPES, ...settings.features.map((feature) => features[feature])]
}

const iso = (ms: number) => new Date(ms).toISOString()
/** Money in the result is rounded to cents: 8.399999… is 8.4, and the contract's number is what a reader shows. */
const cents = (value: number) => Math.round(value * 100) / 100
const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000))

/** One account's scan: what status shows, plus what the cleanup list needs. */
interface AccountScan {
  readonly account: AccountStatus
  readonly running: readonly RunningItem[]
  readonly cleanup: readonly CleanupAction[]
  readonly problems: readonly string[]
  readonly signedIn: boolean
  readonly warehouses: readonly { readonly warehouse: Warehouse; readonly idleMinutes?: number; readonly busy?: string }[]
}

const problem = (alias: string, error: unknown): string => {
  // The family form, next step included: the model needs the one call that fixes it.
  if (error instanceof DatabricksError) return `${alias}: ${error.message}`
  return `${alias}: ${DISPLAY_NAME} could not finish this check (${error instanceof Error ? error.message : "unknown error"}).`
}

/** A scan that could not start, for an account whose options or summary are unusable. */
function failedScan(ports: StatusPorts, alias: string, error: unknown): AccountScan {
  const settings = accountSettings(ports.options).find((account) => account.alias === alias)
  const enforcement: Enforcement = settings?.mode === "m2m" ? "service-principal" : settings?.role ? "role-requested" : "identity"
  return {
    account: { alias, mode: settings?.mode ?? "interactive", enforcement, writes: writesAt(ports.access), scopes: requestedScopes(ports.options, alias) },
    running: [],
    cleanup: [],
    problems: [problem(alias, error)],
    signedIn: false,
    warehouses: [],
  }
}

/** A token, or undefined with the refusal that explains why: a status call reports, it does not fail. */
async function tokenOf(deps: StatusPorts, alias: string, signal: AbortSignal): Promise<{ token?: Token; problem?: string }> {
  try {
    return { token: await deps.auth.token(alias, [...BASE_SCOPES], signal) }
  } catch (error) {
    return { problem: problem(alias, error) }
  }
}

const roleText = (role: AccountInfo["role"], enforcement: Enforcement): string | undefined => {
  if (!role) return undefined
  const name = role.name ?? role.groupId
  return enforcement === "role-requested" ? `${name} (requested)` : name
}

/** The per-warehouse last visible statement: Query History is per identity, so "idle" is "idle by the statements you see". */
function lastActivity(history: readonly HistoryQuery[], warehouseId: string): { end?: number; busy?: string } {
  const items = history.filter((item) => item.warehouseId === warehouseId)
  const end = items.reduce<number | undefined>((latest, item) => {
    const at = item.queryEndTimeMs ?? item.queryStartTimeMs
    return latest === undefined || at > latest ? at : latest
  }, undefined)
  const busy = items.find((item) => item.status === "RUNNING" || item.status === "QUEUED")
  return { ...(end === undefined ? {} : { end }), ...(busy ? { busy: busy.queryId } : {}) }
}

async function scanAccount(deps: StatusPorts, alias: string, now: number, signal: AbortSignal): Promise<AccountScan> {
  const problems: string[] = []
  const settings = accountSettings(deps.options).find((account) => account.alias === alias)
  const info = deps.auth.accounts().find((account) => account.alias === alias)
  const enforcement: Enforcement = info?.enforcement ?? (settings?.mode === "m2m" ? "service-principal" : settings?.role ? "role-requested" : "identity")
  const role = info?.role ?? (settings?.role ? { groupId: settings.role } : undefined)
  const account: AccountStatus = {
    alias,
    mode: info?.mode ?? settings?.mode ?? "interactive",
    ...(info?.host ? { host: info.host } : {}),
    ...(info?.cloud ? { cloud: info.cloud } : {}),
    enforcement,
    writes: writesAt(deps.access),
    scopes: requestedScopes(deps.options, alias),
    ...(roleText(role, enforcement) ? { role: roleText(role, enforcement)! } : {}),
  }
  const token = await tokenOf(deps, alias, signal)
  if (!token.token) {
    const next: AccountStatus = { ...account }
    if (token.problem) problems.push(token.problem)
    return { account: next, running: [], cleanup: [], problems, signedIn: false, warehouses: [] }
  }
  const granted: AccountStatus = { ...account, scopes: [...token.token.scopes] }

  let identity: AccountStatus["identity"]
  try {
    const me = await deps.databricks.me(alias, signal)
    identity = { userName: me.userName, id: me.id, ...(me.displayName ? { displayName: me.displayName } : {}) }
  } catch (error) {
    problems.push(problem(alias, error))
  }

  let warehouses: readonly Warehouse[] = []
  try {
    warehouses = await deps.databricks.listWarehouses(alias, signal)
  } catch (error) {
    problems.push(problem(alias, error))
  }

  const defaultId = info?.warehouse ?? settings?.warehouse
  let defaultWarehouse: Warehouse | undefined = warehouses.find((warehouse) => warehouse.id === defaultId)
  if (defaultId && !defaultWarehouse) {
    try {
      defaultWarehouse = await deps.databricks.getWarehouse(alias, defaultId, signal)
    } catch (error) {
      problems.push(problem(alias, error))
    }
  }

  let history: readonly HistoryQuery[] = []
  try {
    const page = await deps.databricks.history(alias, { startMs: now - HISTORY_WINDOW_MS, maxResults: HISTORY_PAGE }, signal)
    history = page.items
  } catch (error) {
    problems.push(problem(alias, error))
  }

  const running: RunningItem[] = history
    .filter((item) => item.queryTags?.oc_plugin === PLUGIN_TAG && (item.status === "RUNNING" || item.status === "QUEUED"))
    .map((item) => ({
      kind: "statement" as const,
      // The result lists every account, so the id names its account; `next` carries the account for databricks_cancel.
      id: `${alias}:${safeText(item.queryId, 128)}`,
      ...(item.warehouseId ? { warehouse: item.warehouseId } : {}),
      startedAt: iso(item.queryStartTimeMs),
      tool: safeText(item.queryTags?.oc_tool ?? "query", 40),
    }))

  const cleanup: CleanupAction[] = []
  for (const item of history) {
    if (!(item.queryTags?.oc_plugin === PLUGIN_TAG && (item.status === "RUNNING" || item.status === "QUEUED"))) continue
    const tool = item.queryTags?.oc_tool ?? "query"
    const statementId = safeText(item.queryId, 128)
    if (READ_TOOLS.has(tool)) {
      cleanup.push({
        what: `a ${safeText(tool, 40)} statement this plugin started is still running on ${safeText(item.warehouseId ?? "a warehouse", 64)}, since ${iso(item.queryStartTimeMs)}`,
        next: `databricks_cancel({ account: ${JSON.stringify(alias)}, statementId: ${JSON.stringify(statementId)} }) if you do not need its result.`,
      })
    } else {
      cleanup.push({
        what: `a ${safeText(tool, 40)} statement this plugin started is still running on ${safeText(item.warehouseId ?? "a warehouse", 64)}; it is not cancelled here, because a change can leave partial effects`,
        next: `databricks_statement({ account: ${JSON.stringify(alias)}, statementId: ${JSON.stringify(statementId)}, wait: 30 }) to follow it.`,
      })
    }
  }

  const visible = warehouses.filter((warehouse) => warehouse.state === "RUNNING")
  const scanned = visible.map((warehouse) => {
    const activity = lastActivity(history, warehouse.id)
    return { warehouse, ...(activity.end === undefined ? {} : { idleMinutes: minutes(now - activity.end) }), ...(activity.busy ? { busy: safeText(activity.busy, 40) } : {}) }
  })
  for (const entry of [...scanned].sort((a, b) => usdPerHour(b.warehouse, deps.options) - usdPerHour(a.warehouse, deps.options))) {
    const price = cents(usdPerHour(entry.warehouse, deps.options))
    const idle = entry.busy ? `a statement is running on it (${entry.busy})` : entry.idleMinutes === undefined ? `no statement you can see in the last ${HISTORY_WINDOW_MS / 3_600_000} h` : `idle ${entry.idleMinutes} min by the statements you can see`
    cleanup.push({
      what: `warehouse ${safeText(entry.warehouse.name, 60)} is running at about $${price.toFixed(2)}/hour (${safeText(entry.warehouse.clusterSize, 24)} ${kindOf(entry.warehouse)}, auto-stop ${entry.warehouse.autoStopMins} min; ${idle})`,
      usdPerHour: price,
      next: `databricks_stop({ account: ${JSON.stringify(alias)}, warehouse: ${JSON.stringify(safeText(entry.warehouse.id, 64))} }) if nobody is using it.`,
    })
  }

  return {
    account: {
      ...granted,
      ...(identity ? { identity } : {}),
      ...(defaultWarehouse
        ? {
            warehouse: {
              id: safeText(defaultWarehouse.id, 64),
              state: defaultWarehouse.state,
              type: kindOf(defaultWarehouse),
              size: safeText(defaultWarehouse.clusterSize, 24),
              autoStopMinutes: defaultWarehouse.autoStopMins,
              usdPerHour: cents(usdPerHour(defaultWarehouse, deps.options)),
            },
          }
        : {}),
    },
    running,
    cleanup,
    problems,
    signedIn: true,
    warehouses: scanned,
  }
}

export interface StatusPorts {
  readonly options: Options
  readonly access: Access
  readonly auth: AuthPort
  readonly databricks: DatabricksPort
  readonly ledger: LedgerPort
  readonly reads: ReadGuardPort
  readonly clock: Clock
}

export interface Scan {
  readonly scans: readonly AccountScan[]
  readonly running: readonly RunningItem[]
  readonly cleanup: readonly CleanupAction[]
  readonly problems: readonly string[]
  readonly spend: Spend
  readonly automation: { readonly mode: Options["automation"]; readonly active: boolean }
}

/** Automation's consent (design §7): `auto` is on at `all` only; `on` is the person's standing yes; `off` never. */
export const automationOf = (options: Options): { mode: Options["automation"]; active: boolean } => ({
  mode: options.automation,
  active: options.automation === "on" || (options.automation === "auto" && options.access === "all"),
})

/** One scan of every configured account. Databricks failures become problems; nothing is thrown for them. */
export async function scanAccounts(ports: StatusPorts, sessionID: string, signal: AbortSignal): Promise<Scan> {
  const now = ports.clock.now()
  const aliases = accountSettings(ports.options).map((account) => account.alias)
  const scans = await Promise.all(aliases.map((alias) => scanAccount(ports, alias, now, signal).catch((error) => failedScan(ports, alias, error))))
  const running = scans.flatMap((scan) => scan.running)
  // Biggest saving first, then the statements; a UI list, so it is capped.
  const cleanup = scans.flatMap((scan) => scan.cleanup).sort((a, b) => (b.usdPerHour ?? 0) - (a.usdPerHour ?? 0)).slice(0, MAX_CLEANUP)
  const problems = scans.flatMap((scan) => scan.problems)

  let startsToday = 0
  let dbuHoursToday = 0
  let dbuHoursSession = 0
  for (const alias of aliases) {
    try {
      const totals = await ports.ledger.totals(alias, sessionID)
      startsToday += totals.startsToday
      dbuHoursToday += totals.dbuHoursToday
      dbuHoursSession += totals.dbuHoursSession
    } catch (error) {
      problems.push(`${alias}: the spend ledger could not be read (${error instanceof Error ? error.message : "unknown error"}).`)
    }
  }
  const budget = budgetOf(ports.options)
  const spent = budget ? reachedLimit(budget, { startsToday, dbuHoursToday, startsSession: 0, dbuHoursSession, estimate: true }) : undefined
  const state: Spend["budget"]["state"] = !budget ? "off" : spent ? (budget.action === "refuse" ? "reached" : "warn") : "ok"
  const limit = spent?.limit ?? budget?.daily?.dbuHours ?? budget?.daily?.starts ?? budget?.session?.dbuHours ?? budget?.session?.starts
  const spend: Spend = { startsToday, dbuHoursToday, dbuHoursSession, estimate: true, budget: { state, ...(limit === undefined ? {} : { limit }) } }

  return { scans, running, cleanup, problems, spend, automation: automationOf(ports.options) }
}

/**
 * `include: ["spend"]`: the estimate's reconciliation with `system.billing.usage` [25], for the default warehouse today.
 * One statement through the read path on a warehouse that is already running (no `start`), charged like any read.
 * Anything that stops it — no warehouse, no grant, a stopped warehouse — becomes a `problem`, never a failed status.
 */
async function reconcileSpend(ports: StatusPorts, alias: string, sessionID: string, callID: string, signal: AbortSignal): Promise<{ line?: string; problem?: string }> {
  const settings = accountSettings(ports.options).find((account) => account.alias === alias)
  if (!settings) return { problem: "no account is configured, so there is no warehouse to reconcile against." }
  const info = ports.auth.accounts().find((account) => account.alias === alias)
  const warehouseId = info?.warehouse ?? settings.warehouse
  if (!warehouseId) return { problem: `${alias} has no default warehouse, so there is nothing to reconcile against; set accounts.${alias}.warehouse.` }
  const sql =
    "SELECT sum(usage_quantity) AS dbu FROM system.billing.usage WHERE usage_date = current_date AND usage_metadata:warehouse_id = :warehouse"
  try {
    const prepared = await ports.reads.prepare(
      {
        account: alias,
        sql,
        params: [{ name: "warehouse", value: warehouseId, type: "STRING" }],
        warehouse: warehouseId,
        tool: "status",
        sessionID,
        callID,
      },
      signal,
    )
    const started = ports.clock.now()
    const request: StatementRequest = {
      account: alias,
      operation: "sql.statements.query",
      statement: prepared.sent,
      warehouseId: prepared.warehouseId,
      parameters: [{ name: "warehouse", value: warehouseId, type: "STRING" }],
      rowLimit: 1,
      byteLimit: 64 * 1024,
      disposition: "INLINE",
      format: "JSON_ARRAY",
      waitTimeout: 50,
      onWaitTimeout: "CANCEL",
      queryTags: { oc_plugin: PLUGIN_TAG, oc_tool: "status", oc_session: sessionToken(sessionID), oc_call: callID },
    }
    const answer = await ports.databricks.submit(request, signal)
    const durationMs = Math.max(0, ports.clock.now() - started)
    const size = sizeOf(prepared.warehouse)
    if (size) {
      await chargeStatement(ports.ledger, ports.clock, ports.options, {
        account: alias,
        sessionId: sessionID,
        warehouseId: prepared.warehouseId,
        statementId: answer.statementId,
        size,
        autoStopMinutes: prepared.warehouse.autoStopMins,
        clusters: Math.max(1, prepared.warehouse.numClusters ?? prepared.warehouse.minNumClusters ?? 1),
        durationMs,
      })
    }
    const value = answer.rows?.[0]?.[0]
    if (answer.state !== "SUCCEEDED" || value === null || value === undefined) {
      return { problem: `${alias}: the reconciliation statement did not return a figure (${answer.state}).` }
    }
    const dbu = Number(value)
    if (!Number.isFinite(dbu)) return { problem: `${alias}: the reconciliation statement returned a value that is not a number.` }
    const totals = await ports.ledger.totals(alias, sessionID)
    return {
      line: `system.billing.usage reports ${Math.round(dbu * 1000) / 1000} DBU for ${safeText(warehouseId, 64)} today; this process's estimate is ${Math.round(totals.dbuHoursToday * 1000) / 1000} DBU-hours for every warehouse (both are estimates until the account's own prices apply [25]).`,
    }
  } catch (error) {
    return { problem: problem(alias, error) }
  }
}

const stateOf = (scan: Scan): Status["state"] => (scan.scans.length === 0 ? "not_configured" : scan.scans.some((item) => item.signedIn) ? "ready" : "sign_in_required")

type StatusContext = {
  readonly agent: Pick<Plugin.Context["agent"], "list">
  readonly skill: Pick<Plugin.Context["skill"], "list">
}

export type StatusExtras = {
  readonly hostVersion: string
  readonly hostWarning?: string
  readonly skills: readonly SkillPath[]
  /** What this process could not add: the default rules, the tools, a skill. */
  readonly problems: () => readonly string[]
}

/** The full status, for `/databricks-status`, the RPC and the TUI. */
export async function computeStatus(ctx: StatusContext, ports: StatusPorts, extras: StatusExtras): Promise<Status> {
  const [agents, listed] = await Promise.all([ctx.agent.list(), ctx.skill.list().then((result) => result.data, () => undefined)])
  const scan = await scanAccounts(ports, "", new AbortController().signal)
  const shadowed = extras.skills.flatMap((skill) => {
    const found = (listed ?? []).find((item) => item.id === skill.id)
    return found && found.path !== skill.path ? [{ id: skill.id, path: found.path }] : []
  })
  const problems = [...extras.problems(), ...scan.problems]
  const unguarded = unguardedAgents(agents.data, ports.options.access)
  const state = stateOf(scan)
  return {
    version: PLUGIN_VERSION,
    state,
    access: ports.options.access,
    writes: writesAt(ports.options.access),
    disclosure: WRITE_DISCLOSURE,
    policies: POLICY_DISCLOSURE,
    accounts: scan.scans.map((item) => item.account),
    running: scan.running,
    spend: scan.spend,
    automation: scan.automation,
    ...(scan.cleanup.length ? { cleanup: scan.cleanup } : {}),
    unguardedAgents: unguarded,
    ...(unguarded.length > 0 ? { permissionsBlock: defaultRules(ports.options.access) } : {}),
    ...(shadowed.length > 0 ? { shadowedSkills: shadowed } : {}),
    ...(problems.length > 0 ? { problems } : {}),
    host: { version: extras.hostVersion, range: SUPPORTED_HOST, tested: isTestedHost(extras.hostVersion) },
    ...(extras.hostWarning ? { hostWarning: extras.hostWarning } : {}),
    nextStep:
      problems[0] ??
      (state === "not_configured" ? `Run /connect and choose ${DISPLAY_NAME}, or add an account under the plugin option accounts.` : undefined) ??
      (state === "sign_in_required" ? `Run /connect and choose ${DISPLAY_NAME} to sign in to ${scan.scans.map((item) => item.account.alias).join(", ") || "your workspace"}.` : undefined) ??
      (unguarded.length > 0 ? AGENT_STEP : undefined) ??
      (shadowed.length > 0 ? `Rename or move the skill ${shadowed[0]!.id} at ${shadowed[0]!.path}, which OpenCode loads instead of the plugin's.` : undefined) ??
      (extras.hostWarning ? `If ${DISPLAY_NAME} misbehaves, use OpenCode ${TESTED_HOSTS.slice(0, -1).join(", ")} or ${TESTED_HOSTS.at(-1)}, where it is tested.` : undefined) ??
      NOTHING_TO_DO,
  }
}

/** `databricks_status` (design §4): the same scan, in the tool's contract shape. */
export const statusHandler: Handler<"status"> = async (input, call, deps) => {
  // Status must answer before a sign-in exists: resolve the alias from the options, never through `auth.account()`,
  // which refuses a workspace that has not been signed in to yet.
  const alias = input.account ?? deps.auth.accounts()[0]?.alias ?? accountSettings(deps.options)[0]?.alias ?? "default"
  await assertTool("status", alias, call, deps)
  const scan = await scanAccounts(deps, call.sessionID, call.signal)
  const includeSpend = input.include?.includes("spend") ?? false
  const reconciled = includeSpend ? await reconcileSpend(deps, alias, call.sessionID, call.id, call.signal) : {}
  const problems = [...scan.problems, ...(reconciled.problem ? [reconciled.problem] : [])]
  const out: Output<"status"> = {
    state: "ok",
    access: deps.access,
    accounts: [...scan.scans.map((item) => item.account)],
    running: [...scan.running],
    spend: scan.spend,
    automation: scan.automation,
    disclosure: WRITE_DISCLOSURE,
    ...(scan.cleanup.length ? { cleanup: [...scan.cleanup] } : {}),
    ...(problems.length || reconciled.line
      ? { message: [...problems, ...(reconciled.line ? [reconciled.line] : [])].join(" ") }
      : {}),
    ...(problems.length ? { next: `Fix the first problem, or run /${STATUS_COMMAND} for the same detail.` } : {}),
    warnings: [{ code: "ESTIMATE_ONLY", message: "Spend figures are estimates from list prices and this plugin's own ledger; the account's system.billing tables are the authority." }],
  }
  return out
}

type RegisterContext = StatusContext & {
  readonly command: Pick<Plugin.Context["command"], "transform">
  readonly rpc: Pick<Plugin.Context["rpc"], "register">
  readonly session: Pick<Plugin.Context["session"], "synthetic">
}

/** Registers `/databricks-status` and the status RPC the TUI reads. */
export async function registerStatus(ctx: RegisterContext, ports: StatusPorts, extras: StatusExtras): Promise<{ dispose(): Promise<void> }> {
  const compute = () => computeStatus(ctx, ports, extras)
  const registrations: Array<{ dispose(): Promise<void> }> = []
  try {
    registrations.push(
      await ctx.command.transform((editor) => {
        editor.add({
          name: STATUS_COMMAND,
          description: `Show the ${DISPLAY_NAME} workspaces, what this process knows, what is running and what costs money`,
          execute: async ({ sessionID, delivery }) => {
            const text = await compute().then(formatStatus, () => UNAVAILABLE)
            await ctx.session.synthetic({ sessionID, delivery, text, description: `${DISPLAY_NAME} status`, resume: false })
          },
        })
      }),
    )
    registrations.push(
      await ctx.rpc.register(DatabricksRpc, {
        status: async (_input, { error }) => {
          try {
            return await compute()
          } catch {
            return error("unavailable", UNAVAILABLE, { reason: "OpenCode did not report its agents or skills, or Databricks status failed." })
          }
        },
      }),
    )
  } catch (cause) {
    for (const registration of registrations.splice(0).reverse()) await registration.dispose()
    throw cause
  }
  return {
    async dispose() {
      for (const registration of registrations.splice(0).reverse()) await registration.dispose()
    },
  }
}
