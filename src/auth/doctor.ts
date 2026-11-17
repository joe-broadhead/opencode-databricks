/**
 * `/databricks-doctor`: what a sign-in really allows (design §3.4, §14).
 *
 * The design's point is that a role is weaker than "read-only" sounds: roles inherit the workspace `users` group's
 * grants, workspace users get CREATE privileges on the workspace catalog's `default` schema [38], and a connection turns
 * `http_request` into the connection's own credential. So the doctor proves the role by its effect:
 * - the sign-in and its scopes (`AUTH_REQUIRED`, `AUTH_SCOPE_MISSING`);
 * - the identity `GET /scim/v2/Me` names [30];
 * - Unity Catalog `effective-permissions` [8] on every catalog the identity can use, and on the workspace catalog's
 *   `default` schema by name; `EXECUTE` on a Unity Catalog function whose body is EXTERNAL;
 * - each warehouse's auto-stop and statement timeout, which are the admin-side cost settings (§6.2);
 * - the families the design names but this version's `DatabricksPort` cannot read: connections, secret scopes, serving
 *   endpoints and job permissions. They are reported `NOT_CHECKED` with that reason, never assumed clean, and a role is
 *   certified only when every check ran and passed. `docs/ownership.md` makes the port a Day 0 contract file, so the
 *   request is in this package's pull request ("Contract requests") rather than a port edit here.
 *
 * Anything beyond `USE_CATALOG`, `USE_SCHEMA`, `SELECT`, `READ_VOLUME`, `BROWSE` and `EXECUTE` on a pure SQL function
 * is `ROLE_CAN_WRITE`, naming the grant. The call set is free (Unity Catalog reads and warehouse reads); nothing is
 * started and no statement runs.
 */
import { DatabricksError, WARNINGS } from "../domain/errors.js"
import type { Options } from "../options.js"
import type { AccountInfo, AuthPort, DatabricksPort, Identity, Token } from "../ports.js"
import { reasonOf } from "../redact.js"
import { accountSettings, type AccountSettings } from "./accounts.js"
import { apiScopes, widerThanFeatures } from "./scopes.js"

export type DoctorStatus =
  | "OK"
  | "AUTH_REQUIRED"
  | "AUTH_SCOPE_MISSING"
  | "AUTH_CLIENT_INVALID"
  | "HOST_INVALID"
  | "HEADLESS_REFUSED"
  | "ROLE_CAN_WRITE"
  | "PERMISSION_DENIED"
  | "WAREHOUSE_FORBIDDEN"
  | "UNAVAILABLE"
  | "NOT_CHECKED"

const STATUSES: readonly string[] = [
  "OK",
  "AUTH_REQUIRED",
  "AUTH_SCOPE_MISSING",
  "AUTH_CLIENT_INVALID",
  "HOST_INVALID",
  "HEADLESS_REFUSED",
  "ROLE_CAN_WRITE",
  "PERMISSION_DENIED",
  "WAREHOUSE_FORBIDDEN",
  "UNAVAILABLE",
  "NOT_CHECKED",
]

export interface DoctorCheck {
  readonly id: string
  readonly status: DoctorStatus
  readonly detail: string
  readonly next?: string
}

export interface DoctorWarning {
  readonly code: keyof typeof WARNINGS
  readonly message: string
}

export interface DoctorReport {
  readonly alias: string
  readonly mode: AccountSettings["mode"]
  readonly host?: string
  readonly cloud?: string
  readonly identity?: Identity
  readonly role?: { readonly groupId: string }
  readonly enforcement: "role" | "role-requested" | "identity" | "service-principal"
  readonly checks: readonly DoctorCheck[]
  readonly warnings: readonly DoctorWarning[]
  readonly nextStep: string
}

/** A role family this package cannot read through the port; a later port adds it, and a test injects it. */
export interface RoleFamilyCheck {
  readonly id: string
  readonly label: string
  readonly run: () => Promise<DoctorCheck>
}

export interface DoctorInput {
  readonly options: Options
  readonly auth: AuthPort
  readonly databricks: DatabricksPort
  readonly signal: AbortSignal
  readonly now: () => number
  readonly families?: readonly RoleFamilyCheck[]
}

const MAX_CATALOGS = 1000
const CATALOG_PAGE = 100
const MAX_CATALOG_PAGES = 10
const MAX_EXTERNAL_FUNCTIONS = 50
const MAX_FUNCTION_PAGES = 5
const MAX_WAREHOUSES = 100

/** Privileges that only read; everything else is a write grant for the role check. */
const SAFE = new Set(["USE_CATALOG", "USE_SCHEMA", "SELECT", "READ_VOLUME", "BROWSE", "EXECUTE"])

function statusOf(error: unknown): DoctorStatus {
  return error instanceof DatabricksError && STATUSES.includes(error.code) ? (error.code as DoctorStatus) : "UNAVAILABLE"
}

function check(id: string, status: DoctorStatus, detail: string, next?: string): DoctorCheck {
  return { id, status, detail, ...(next !== undefined ? { next } : {}) }
}

function failed(id: string, error: unknown): DoctorCheck {
  if (error instanceof DatabricksError) return check(id, statusOf(error), error.detail, error.nextStep)
  return check(id, "UNAVAILABLE", `The check could not run: ${reasonOf(error)}.`, "Try again; if it persists, run /databricks-doctor in a new session.")
}

/** The grants that exceed reading, from `effective-permissions` entries [8]. */
export function writeGrants(entries: readonly { readonly principal: string; readonly privileges: readonly string[] }[]): string[] {
  const privileges = new Set<string>()
  for (const entry of entries) for (const privilege of entry.privileges) if (!SAFE.has(privilege)) privileges.add(privilege)
  return [...privileges].sort()
}

function grantCheck(id: string, kind: string, name: string, grants: readonly string[], role: boolean): DoctorCheck {
  if (grants.length === 0) return check(id, "OK", `No grant beyond reading on ${kind} ${name}.`)
  const named = grants.join(", ")
  if (!role) return check(id, "OK", `The identity holds ${named} on ${kind} ${name}; no role is bound, so this is your own access.`)
  return check(
    id,
    "ROLE_CAN_WRITE",
    `The role can ${named} on ${kind} ${name}.`,
    `Ask the account admin to revoke ${named} from the role in Unity Catalog, or sign in with a role that has only USE and SELECT.`,
  )
}

async function catalogs(input: DoctorInput, account: string, role: boolean): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = []
  let pageToken: string | undefined
  let seen = 0
  try {
    for (let page = 0; page < MAX_CATALOG_PAGES && seen < MAX_CATALOGS; page += 1) {
      const answer = await input.databricks.listCatalogs(account, { maxResults: CATALOG_PAGE, ...(pageToken !== undefined ? { pageToken } : {}) }, input.signal)
      for (const catalog of answer.items) {
        if (seen >= MAX_CATALOGS) break
        seen += 1
        const effective = await input.databricks.effectivePermissions(account, { type: "catalog", fullName: catalog.name }, input.signal)
        checks.push(grantCheck(`privileges:catalog:${catalog.name}`, "catalog", catalog.name, writeGrants(effective), role))
      }
      pageToken = answer.nextPageToken
      if (!pageToken) break
    }
  } catch (error) {
    checks.push(failed("privileges:catalogs", error))
    return checks
  }
  if (seen === 0) checks.push(check("privileges:catalogs", "OK", "No catalog is visible to this identity, so there was nothing to check."))
  return checks
}

/** The workspace catalog's `default` schema, and EXECUTE on any EXTERNAL function in it (design §3.4). */
async function defaultSchema(input: DoctorInput, settings: AccountSettings, account: string, role: boolean): Promise<DoctorCheck[]> {
  const catalog = settings.catalog
  if (!catalog) {
    return [
      check(
        "privileges:default-schema",
        "NOT_CHECKED",
        "accounts.<alias>.catalog is not set, so the workspace catalog's default schema was not checked.",
        "Set accounts.<alias>.catalog to the workspace catalog (usually main), then run /databricks-doctor again.",
      ),
    ]
  }
  const fullName = `${catalog}.default`
  const checks: DoctorCheck[] = []
  try {
    const effective = await input.databricks.effectivePermissions(account, { type: "schema", fullName }, input.signal)
    checks.push(grantCheck("privileges:default-schema", "schema", fullName, writeGrants(effective), role))
  } catch (error) {
    checks.push(failed("privileges:default-schema", error))
    return checks
  }
  try {
    let pageToken: string | undefined
    let external = 0
    for (let page = 0; page < MAX_FUNCTION_PAGES && external < MAX_EXTERNAL_FUNCTIONS; page += 1) {
      const answer = await input.databricks.listFunctions(account, catalog, "default", { ...(pageToken !== undefined ? { pageToken } : {}) }, input.signal)
      for (const fn of answer.items) {
        if (fn.routineBody !== "EXTERNAL" || external >= MAX_EXTERNAL_FUNCTIONS) continue
        external += 1
        const name = `${catalog}.default.${fn.name}`
        const effective = await input.databricks.effectivePermissions(account, { type: "function", fullName: name }, input.signal)
        const executable = effective.flatMap((entry) => entry.privileges).some((privilege) => privilege === "EXECUTE" || privilege === "MANAGE" || privilege === "ALL PRIVILEGES")
        if (executable) {
          checks.push(
            check(
              `privileges:function:${name}`,
              role ? "ROLE_CAN_WRITE" : "OK",
              `${role ? "The role" : "The identity"} can EXECUTE the external function ${name}, which runs its own code.`,
              role ? "Ask the account admin to revoke EXECUTE on this function from the role." : undefined,
            ),
          )
        }
      }
      pageToken = answer.nextPageToken
      if (!pageToken) break
    }
  } catch (error) {
    checks.push(failed("privileges:functions", error))
  }
  return checks
}

async function warehouses(input: DoctorInput, account: string): Promise<{ readonly checks: DoctorCheck[]; readonly warnings: DoctorWarning[] }> {
  try {
    const seen = (await input.databricks.listWarehouses(account, input.signal)).slice(0, MAX_WAREHOUSES)
    const warnings: DoctorWarning[] = []
    for (const warehouse of seen) {
      if (warehouse.autoStopMins === 0) warnings.push({ code: "AUTO_STOP_OFF", message: `${warehouse.name} never auto-stops and bills until someone stops it.` })
      else if (warehouse.autoStopMins > 30) warnings.push({ code: "AUTO_STOP_LONG", message: `${warehouse.name} auto-stops after ${warehouse.autoStopMins} minutes.` })
    }
    const autoStop = seen.map((warehouse) => `${warehouse.name} ${warehouse.autoStopMins === 0 ? "never" : `${warehouse.autoStopMins} min`}`).join(", ")
    const timeouts = seen.map((warehouse) => `${warehouse.name}: ${warehouse.statementTimeoutSeconds !== undefined ? `${warehouse.statementTimeoutSeconds}s` : "workspace default (2 days)"}`)
    return {
      checks: [
        check(
          "warehouses",
          "OK",
          seen.length === 0 ? "No SQL warehouse is visible." : `${seen.length} SQL warehouse(s); auto-stop ${autoStop}. Statement timeout: ${timeouts.join("; ")}.`,
          seen.some((warehouse) => warehouse.statementTimeoutSeconds === undefined)
            ? "Ask an admin to set each warehouse's statement_timeout, so a runaway read has a server-side limit."
            : undefined,
        ),
      ],
      warnings,
    }
  } catch (error) {
    return { checks: [failed("warehouses", error)], warnings: [] }
  }
}

const NOT_RUN = "A role is certified only when every check ran; this version's Databricks port has no call for it."
const DEFAULT_FAMILIES: readonly RoleFamilyCheck[] = [
  { id: "role:connections", label: "USE CONNECTION on connections", run: async () => check("role:connections", "NOT_CHECKED", `Connections were not checked, so USE CONNECTION is unknown. ${NOT_RUN}`, "Sign in with a role that has no USE CONNECTION grant, or wait for the port's connection reads.") },
  { id: "role:secret-scopes", label: "READ on secret scopes", run: async () => check("role:secret-scopes", "NOT_CHECKED", `Secret scopes were not checked, so READ on them is unknown. ${NOT_RUN}`, "Sign in with a role that has no READ on secret scopes, or wait for the port's secret-scope reads.") },
  { id: "role:serving", label: "CAN QUERY on serving endpoints", run: async () => check("role:serving", "NOT_CHECKED", `Serving endpoints were not checked, so CAN QUERY is unknown. ${NOT_RUN}`, "Wait for the port's serving-endpoint reads; until then a role is not certified.") },
  { id: "role:jobs", label: "CAN MANAGE RUN on jobs", run: async () => check("role:jobs", "NOT_CHECKED", `Job permissions were not checked, so CAN MANAGE RUN is unknown. ${NOT_RUN}`, "Wait for the port's job-permission reads; until then a role is not certified.") },
]

/** One account's report. */
async function reportFor(input: DoctorInput, settings: AccountSettings): Promise<DoctorReport> {
  const alias = settings.alias
  const checks: DoctorCheck[] = []
  const warnings: DoctorWarning[] = []
  let identity: Identity | undefined
  let token: Token | undefined
  let info: AccountInfo | undefined

  try {
    info = input.auth.account(alias)
  } catch (error) {
    checks.push(failed("configuration", error))
  }

  try {
    token = await input.auth.token(alias, apiScopes(settings.features), input.signal)
    checks.push(check("sign-in", "OK", `A token is available and carries the scopes this plugin needs${settings.mode === "interactive" ? "" : ` (mode ${settings.mode})`}.`))
  } catch (error) {
    checks.push(failed("sign-in", error))
  }

  if (token) {
    try {
      identity = await input.databricks.me(alias, input.signal)
      checks.push(check("identity", "OK", `Signed in as ${identity.displayName ?? identity.userName} (${identity.userName}).`))
    } catch (error) {
      checks.push(failed("identity", error))
    }
    const roleBound = info?.role !== undefined
    checks.push(...(await catalogs(input, alias, roleBound)))
    checks.push(...(await defaultSchema(input, settings, alias, roleBound)))
    const house = await warehouses(input, alias)
    checks.push(...house.checks)
    warnings.push(...house.warnings)
    if (widerThanFeatures(token.scopes, settings.features)) warnings.push({ code: "SCOPE_WIDER_THAN_FEATURES", message: WARNINGS.SCOPE_WIDER_THAN_FEATURES })
    for (const family of input.families ?? DEFAULT_FAMILIES) {
      try {
        checks.push(await family.run())
      } catch (error) {
        checks.push(failed(family.id, error))
      }
    }
  } else {
    checks.push(check("identity", "NOT_CHECKED", "No token, so the identity was not read.", "Fix the sign-in first."))
    checks.push(check("privileges", "NOT_CHECKED", "No token, so no privilege was checked.", "Fix the sign-in first."))
    for (const family of input.families ?? DEFAULT_FAMILIES) checks.push(check(family.id, "NOT_CHECKED", "No token, so the role family was not checked.", "Fix the sign-in first."))
  }

  const role = info?.role
  const enforcement: DoctorReport["enforcement"] =
    info === undefined
      ? settings.mode === "m2m"
        ? "service-principal"
        : "identity"
      : info.mode === "m2m"
        ? "service-principal"
        : role !== undefined
          ? checks.every((item) => item.status === "OK")
            ? "role"
            : "role-requested"
          : "identity"
  for (const item of checks) if (item.status === "ROLE_CAN_WRITE") warnings.push({ code: "ROLE_CAN_WRITE", message: item.detail })
  return {
    alias,
    mode: settings.mode,
    ...(info?.host !== undefined ? { host: info.host } : settings.host !== undefined ? { host: settings.host } : {}),
    ...(info?.cloud !== undefined ? { cloud: info.cloud } : {}),
    ...(identity !== undefined ? { identity } : {}),
    ...(role !== undefined ? { role } : {}),
    enforcement,
    checks,
    warnings,
    nextStep: checks.find((item) => item.next !== undefined)?.next ?? "No next step: every check this version can run passed.",
  }
}

/** Every configured account's report, in configuration order. */
export async function runDoctor(input: DoctorInput): Promise<DoctorReport[]> {
  const reports: DoctorReport[] = []
  for (const settings of accountSettings(input.options)) {
    if (input.signal.aborted) break
    reports.push(await reportFor(input, settings))
  }
  return reports
}
