/**
 * `/databricks-doctor`: what a sign-in really allows (design §3.4, §14; review of #5, M2, M3, and the accepted role
 * decision).
 *
 * The design's point is that a role is weaker than "read-only" sounds: roles inherit the workspace `users` group's
 * grants, workspace users get CREATE privileges on the workspace catalog's `default` schema [38], and a connection turns
 * `http_request` into the connection's own credential. So the doctor proves the role by its effect, and it says exactly
 * what it checked:
 *
 * - the sign-in and its scopes (`AUTH_REQUIRED`, `AUTH_SCOPE_MISSING`);
 * - the identity `GET /scim/v2/Me` names [30], with its groups when SCIM returns them;
 * - Unity Catalog `effective-permissions` [8] for the role's own principals, on every catalog the identity can use, on
 *   the workspace catalog's `default` schema (from UC Get Current Metastore Assignment, or every catalog's `default`
 *   schema when that is unavailable), and on external functions under a catalog or schema where the role holds
 *   `EXECUTE` and on each external function in a `default` schema;
 * - `USE CONNECTION` on every visible connection, which would let `http_request` act with the connection's credential;
 * - each warehouse's auto-stop and statement timeout, which are the admin-side cost settings (§6.2).
 *
 * **Completeness (review M3).** Every list is paged to its end. If a cap is reached, a `NOT_CHECKED` check says so and
 * the report cannot certify a role over it. The report names the level of each grant check, so "what doctor checked" is
 * not read as a whole-metastore claim.
 *
 * **Principals (review M2).** `effective-permissions` returns entries for every principal unless a `principal` is
 * given [grants API]. Under a role, only the role group's own entries are counted (plus the `users` and `account users`
 * groups it inherits, when SCIM names them); another principal's grant is not the role's. When SCIM does not name the
 * role group, every entry is counted as a conservative superset and the check says so.
 *
 * **What can be certified (the accepted decision).** Under fine-grained scopes, `enforcement: "role"` is earned over the
 * Unity Catalog and connection checks: "SQL writes refused on what doctor checked; secret scopes and serving endpoints
 * not checked; job runs use each job's Run as identity". Under `all-apis`, secret scopes and serving endpoints are
 * reachable and remain `NOT_CHECKED`, so they block the claim. Jobs are `OK` without the `jobs` scope (no job can run
 * through that token) and `NOT_CHECKED` with it.
 *
 * The call set is free (Unity Catalog reads and warehouse reads); nothing is started and no statement runs.
 */
import { ROLE_ENFORCEMENT_TEXT } from "../domain/contract.js"
import { DatabricksError, WARNINGS } from "../domain/errors.js"
import type { Options } from "../options.js"
import type { AccountInfo, AuthPort, DatabricksPort, Identity, Page, Token } from "../ports.js"
import { reasonOf } from "../redact.js"
import { accountSettings, type AccountSettings } from "./accounts.js"
import { apiScopes, widerThanFeatures } from "./scopes.js"

export type DoctorStatus =
  | "OK"
  | "AUTH_REQUIRED"
  | "AUTH_SCOPE_MISSING"
  | "AUTH_CLIENT_INVALID"
  | "HOST_INVALID"
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

/** The credential a report's checks ran against, so a certification is bound to what was checked (review R2-L1). */
export interface ReportBinding {
  readonly host: string
  readonly roleGroupId?: string
  readonly grantedScopes: readonly string[]
}

export interface DoctorReport {
  readonly alias: string
  readonly mode: AccountSettings["mode"]
  readonly host?: string
  readonly cloud?: string
  readonly identity?: Identity
  readonly role?: { readonly groupId: string; readonly name?: string }
  readonly enforcement: "role" | "role-requested" | "identity" | "service-principal"
  /** The exact guarantee `enforcement: "role"` carries, and its exclusions. */
  readonly claim?: string
  /** The credential this report checked; `certify` accepts it only while it is still the one in force. */
  readonly binding?: ReportBinding
  readonly checks: readonly DoctorCheck[]
  readonly warnings: readonly DoctorWarning[]
  readonly nextStep: string
}

/** A role family this package's checks could not run; a test injects its own set. */
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

const MAX_CATALOGS = 10_000
const CATALOG_PAGE = 100
const MAX_CATALOG_PAGES = 100
const MAX_SCHEMAS = 500
const SCHEMA_PAGE = 100
const MAX_SCHEMA_PAGES = 20
const MAX_FUNCTIONS = 500
const MAX_FUNCTION_PAGES = 20
const MAX_CONNECTIONS = 1000
const CONNECTION_PAGE = 100
const MAX_CONNECTION_PAGES = 10

/** Privileges that only read. `EXECUTE` is safe on a pure SQL function; above function level it is checked for one. */
const SAFE = new Set(["USE_CATALOG", "USE_SCHEMA", "SELECT", "READ_VOLUME", "BROWSE", "EXECUTE"])
const FUNCTION_WRITE = new Set(["EXECUTE", "MANAGE", "ALL_PRIVILEGES"])

type Permissions = readonly { readonly principal: string; readonly privileges: readonly string[] }[]

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

function notImplemented(error: unknown): boolean {
  return error instanceof DatabricksError && (error.code === "NOT_IMPLEMENTED" || error.code === "UNAVAILABLE")
}

/** The grants that exceed reading, from `effective-permissions` entries [8]. */
export function writeGrants(entries: Permissions): string[] {
  const privileges = new Set<string>()
  for (const entry of entries) for (const privilege of entry.privileges) if (!SAFE.has(privilege)) privileges.add(privilege)
  return [...privileges].sort()
}

/**
 * The principals whose grants are the role's own: the role group, plus the `users` and `account users` groups it
 * inherits (design §3.4), when SCIM names them. Without a name the entries are counted as a superset, which can only
 * over-report, never over-certify.
 */
export interface RolePrincipals {
  readonly names: readonly string[]
  readonly resolved: boolean
  readonly note?: string
}

const INHERITED_GROUPS = ["users", "account users"] as const

export function rolePrincipals(identity: Identity | undefined, roleGroupId: string | undefined): RolePrincipals {
  if (!roleGroupId) return { names: [], resolved: false }
  const own = identity?.groups?.find((group) => group.id === roleGroupId)
  if (!own?.displayName) {
    return {
      names: [],
      resolved: false,
      note: "SCIM Me did not return the role group's name, so every principal's grants were counted; a grant another principal holds is not the role's.",
    }
  }
  // A role inherits these two groups' grants (design §3.4), and SCIM is not documented to list them: query them by name
  // whatever SCIM returns, or a role whose only write grant comes through `account users` would look clean (R2-M1).
  return { names: [own.displayName, ...INHERITED_GROUPS], resolved: true }
}

/**
 * The effective permissions for the role's principals. The accepted `principal` argument filters on the server; a port
 * that does not know it (before the keeper's contract PR) ignores it, and the local filter below still applies.
 */
async function permissionsFor(port: DatabricksPort, account: string, securable: { readonly type: string; readonly fullName: string }, signal: AbortSignal, principals: RolePrincipals): Promise<Permissions> {
  if (!principals.resolved || principals.names.length === 0) return port.effectivePermissions(account, securable, signal)
  const answers = await Promise.all(principals.names.map((name) => port.effectivePermissions(account, securable, signal, name)))
  const wanted = new Set(principals.names.map((name) => name.toLowerCase()))
  return answers.flat().filter((entry) => wanted.has(entry.principal.toLowerCase()))
}

function grantCheck(id: string, level: string, name: string, entries: Permissions, role: boolean, principals: RolePrincipals): DoctorCheck {
  const grants = writeGrants(entries)
  const note = principals.note ? ` ${principals.note}` : ""
  if (grants.length === 0) return check(id, "OK", `No grant beyond reading to ${role ? "the role" : "the identity"} on ${level} ${name}.${note}`)
  const named = grants.join(", ")
  if (!role) return check(id, "OK", `The identity holds ${named} on ${level} ${name}; no role is bound, so this is your own access.${note}`)
  return check(
    id,
    "ROLE_CAN_WRITE",
    `The role can ${named} on ${level} ${name}.${note}`,
    `Ask the account admin to revoke ${named} from the role in Unity Catalog, or sign in with a role that has only USE and SELECT.`,
  )
}

interface PageResult<T> {
  readonly items: readonly T[]
  readonly truncated: boolean
}

/** Page a list to its end, or say that a cap stopped it. */
async function pageAll<T>(fetchPage: (pageToken?: string) => Promise<Page<T>>, cap: number, pageCap: number): Promise<PageResult<T>> {
  const items: T[] = []
  let pageToken: string | undefined
  for (let page = 0; page < pageCap; page += 1) {
    const answer = await fetchPage(pageToken)
    for (const item of answer.items) {
      if (items.length >= cap) return { items, truncated: true }
      items.push(item)
    }
    pageToken = answer.nextPageToken
    if (!pageToken) return { items, truncated: false }
  }
  return { items, truncated: pageToken !== undefined }
}

/** The EXTERNAL functions under one catalog or schema, and whether a cap stopped the walk. */
async function externalFunctions(port: DatabricksPort, account: string, catalog: string, schema: string | undefined, signal: AbortSignal): Promise<PageResult<string>> {
  const schemas = schema !== undefined ? { items: [{ name: schema }], truncated: false } : await pageAll((pageToken) => port.listSchemas(account, catalog, { maxResults: SCHEMA_PAGE, ...(pageToken !== undefined ? { pageToken } : {}) }, signal), MAX_SCHEMAS, MAX_SCHEMA_PAGES)
  const external: string[] = []
  let truncated = schemas.truncated
  for (const entry of schemas.items) {
    const functions = await pageAll((pageToken) => port.listFunctions(account, catalog, entry.name, { ...(pageToken !== undefined ? { pageToken } : {}) }, signal), MAX_FUNCTIONS, MAX_FUNCTION_PAGES)
    if (functions.truncated) truncated = true
    for (const fn of functions.items) {
      if (fn.routineBody !== "EXTERNAL") continue
      if (external.length >= MAX_FUNCTIONS) return { items: external, truncated: true }
      external.push(`${catalog}.${entry.name}.${fn.name}`)
    }
  }
  return { items: external, truncated }
}

interface CatalogChecks {
  readonly checks: readonly DoctorCheck[]
  readonly catalogs: readonly string[]
}

async function catalogsCheck(port: DatabricksPort, account: string, signal: AbortSignal, role: boolean, principals: RolePrincipals): Promise<CatalogChecks> {
  const checks: DoctorCheck[] = []
  let listed: PageResult<{ readonly name: string }>
  try {
    listed = await pageAll((pageToken) => port.listCatalogs(account, { maxResults: CATALOG_PAGE, ...(pageToken !== undefined ? { pageToken } : {}) }, signal), MAX_CATALOGS, MAX_CATALOG_PAGES)
  } catch (error) {
    return { checks: [failed("privileges:catalogs", error)], catalogs: [] }
  }
  if (listed.truncated) {
    checks.push(check("privileges:catalogs:truncated", "NOT_CHECKED", `More than ${MAX_CATALOGS} catalogs (or ${MAX_CATALOG_PAGES} pages); the rest were not checked, so a role is not certified.`, "Run /databricks-doctor again, or ask an admin to narrow the role's visible catalogs."))
  }
  if (listed.items.length === 0) {
    checks.push(check("privileges:catalogs", "OK", "No catalog is visible to this identity, so there was nothing to check."))
  }
  const catalogs = listed.items.map((catalog) => catalog.name)
  for (const catalog of catalogs) {
    let entries: Permissions
    try {
      entries = await permissionsFor(port, account, { type: "catalog", fullName: catalog }, signal, principals)
    } catch (error) {
      checks.push(failed(`privileges:catalog:${catalog}`, error))
      continue
    }
    const grants = writeGrants(entries)
    const held = new Set(entries.flatMap((entry) => entry.privileges))
    // EXECUTE above function level covers every function beneath it; it is safe only when none is EXTERNAL (M3).
    if (held.has("EXECUTE") || held.has("ALL_PRIVILEGES")) {
      let external: PageResult<string>
      try {
        external = await externalFunctions(port, account, catalog, undefined, signal)
      } catch (error) {
        checks.push(failed(`privileges:catalog:${catalog}`, error))
        continue
      }
      if (external.truncated) {
        checks.push(check(`privileges:catalog:${catalog}:truncated`, "NOT_CHECKED", `Could not finish listing the functions of ${catalog}, so its catalog-level EXECUTE was not checked completely; a role is not certified.`, "Run /databricks-doctor again."))
        continue
      }
      if (external.items.length > 0) {
        checks.push(
          check(
            `privileges:catalog:${catalog}`,
            role ? "ROLE_CAN_WRITE" : "OK",
            `${role ? "The role" : "The identity"} can EXECUTE at catalog ${catalog}, which covers the external function ${external.items[0]}.`,
            role ? `Ask the account admin to revoke EXECUTE on catalog ${catalog} from the role, or grant it only on SQL functions.` : undefined,
          ),
        )
        continue
      }
    }
    checks.push(grantCheck(`privileges:catalog:${catalog}`, "catalog", catalog, entries, role, principals))
  }
  return { checks, catalogs }
}

interface DefaultSchema {
  readonly catalog: string
  readonly schema: string
}

/** `default` schemas to check: the workspace catalog's when UC names it, else every catalog's own `default`. */
async function defaultSchemas(port: DatabricksPort, account: string, catalogs: readonly string[], signal: AbortSignal): Promise<{ readonly found: readonly DefaultSchema[]; readonly truncated: boolean }> {
  let workspace: string | undefined
  try {
    const assignment = await port.currentMetastoreAssignment(account, signal)
    workspace = assignment.defaultCatalogName
  } catch {
    // A port that cannot read the assignment yet: the fallback below still covers every `default` schema.
    workspace = undefined
  }
  const targets = workspace ? [workspace] : catalogs
  const found: DefaultSchema[] = []
  let truncated = false
  for (const catalog of targets) {
    const schemas = await pageAll((pageToken) => port.listSchemas(account, catalog, { maxResults: SCHEMA_PAGE, ...(pageToken !== undefined ? { pageToken } : {}) }, signal), MAX_SCHEMAS, MAX_SCHEMA_PAGES)
    if (schemas.truncated) truncated = true
    if (schemas.items.some((schema) => schema.name === "default")) found.push({ catalog, schema: "default" })
  }
  return { found, truncated }
}

async function defaultSchemaChecks(port: DatabricksPort, account: string, catalogs: readonly string[], signal: AbortSignal, role: boolean, principals: RolePrincipals): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = []
  let defaults: { readonly found: readonly DefaultSchema[]; readonly truncated: boolean }
  try {
    defaults = await defaultSchemas(port, account, catalogs, signal)
  } catch (error) {
    return [failed("privileges:default-schema", error)]
  }
  if (defaults.truncated) {
    checks.push(check("privileges:default-schema:truncated", "NOT_CHECKED", "Could not list every catalog's schemas, so the workspace catalog's default schema may be among the unread ones; a role is not certified.", "Run /databricks-doctor again."))
  }
  if (defaults.found.length === 0) {
    checks.push(check("privileges:default-schema", "NOT_CHECKED", "No catalog's default schema was visible, so the schema where workspace users hold CREATE was not checked; a role is not certified.", "Ask an admin for USE CATALOG on the workspace catalog, then run /databricks-doctor again."))
    return checks
  }
  for (const { catalog, schema } of defaults.found) {
    const fullName = `${catalog}.${schema}`
    let entries: Permissions
    try {
      entries = await permissionsFor(port, account, { type: "schema", fullName }, signal, principals)
    } catch (error) {
      checks.push(failed(`privileges:default-schema:${fullName}`, error))
      continue
    }
    let functions: PageResult<{ readonly name: string; readonly routineBody: string }>
    try {
      functions = await pageAll((pageToken) => port.listFunctions(account, catalog, schema, { ...(pageToken !== undefined ? { pageToken } : {}) }, signal), MAX_FUNCTIONS, MAX_FUNCTION_PAGES)
    } catch (error) {
      checks.push(failed(`privileges:functions:${fullName}`, error))
      continue
    }
    if (functions.truncated) {
      checks.push(check(`privileges:functions:${fullName}:truncated`, "NOT_CHECKED", `More than ${MAX_FUNCTIONS} functions in ${fullName}; not every EXTERNAL one was checked, so a role is not certified.`, "Run /databricks-doctor again, or ask an admin to narrow the role."))
    }
    const external = functions.items.filter((fn) => fn.routineBody === "EXTERNAL")
    const held = new Set(entries.flatMap((entry) => entry.privileges))
    // EXECUTE on the schema covers every function beneath it; it is safe only when none is EXTERNAL (M3).
    if ((held.has("EXECUTE") || held.has("ALL_PRIVILEGES")) && external.length > 0) {
      checks.push(
        check(
          `privileges:default-schema:${fullName}`,
          role ? "ROLE_CAN_WRITE" : "OK",
          `${role ? "The role" : "The identity"} can EXECUTE on schema ${fullName}, which covers the external function ${catalog}.${schema}.${external[0]!.name}.`,
          role ? `Ask the account admin to revoke EXECUTE on schema ${fullName} from the role, or grant it only on SQL functions.` : undefined,
        ),
      )
    } else {
      checks.push(grantCheck(`privileges:default-schema:${fullName}`, "schema", fullName, entries, role, principals))
    }
    for (const fn of external) {
      const name = `${catalog}.${schema}.${fn.name}`
      let functionEntries: Permissions
      try {
        functionEntries = await permissionsFor(port, account, { type: "function", fullName: name }, signal, principals)
      } catch (error) {
        checks.push(failed(`privileges:function:${name}`, error))
        continue
      }
      const granted = functionEntries.flatMap((entry) => entry.privileges).filter((privilege) => FUNCTION_WRITE.has(privilege))
      if (granted.length > 0) {
        checks.push(
          check(
            `privileges:function:${name}`,
            role ? "ROLE_CAN_WRITE" : "OK",
            `${role ? "The role" : "The identity"} can ${[...new Set(granted)].join(", ")} on the external function ${name}, which runs its own code.`,
            role ? "Ask the account admin to revoke EXECUTE on this function from the role." : undefined,
          ),
        )
      }
    }
  }
  return checks
}

async function connectionsCheck(port: DatabricksPort, account: string, signal: AbortSignal, role: boolean, principals: RolePrincipals): Promise<DoctorCheck> {
  let listed: PageResult<{ readonly name: string; readonly connectionType?: string }>
  try {
    listed = await pageAll((pageToken) => port.listConnections!(account, { ...(pageToken !== undefined ? { pageToken } : {}) }, signal), MAX_CONNECTIONS, MAX_CONNECTION_PAGES)
  } catch (error) {
    if (notImplemented(error)) return check("role:connections", "NOT_CHECKED", "The Databricks port cannot read connections yet, so USE CONNECTION was not checked; a role is not certified.", "A later port reads connections; until then a role is not certified.")
    return failed("role:connections", error)
  }
  if (listed.truncated) return check("role:connections:truncated", "NOT_CHECKED", `More than ${MAX_CONNECTIONS} connections; not every one was checked, so a role is not certified.`, "Run /databricks-doctor again.")
  if (listed.items.length === 0) return check("role:connections", "OK", "No connection is visible, so no connection can be used through this identity.")
  const writes: string[] = []
  for (const connection of listed.items) {
    let entries: Permissions
    try {
      entries = await permissionsFor(port, account, { type: "connection", fullName: connection.name }, signal, principals)
    } catch (error) {
      return failed("role:connections", error)
    }
    const grants = writeGrants(entries)
    if (grants.length > 0) writes.push(`${grants.join(", ")} on connection ${connection.name}`)
  }
  if (writes.length === 0) return check("role:connections", "OK", `Checked ${listed.items.length} connection(s): no USE or MANAGE grant to ${role ? "the role" : "the identity"}.${principals.note ? ` ${principals.note}` : ""}`)
  return check(
    "role:connections",
    role ? "ROLE_CAN_WRITE" : "OK",
    `${role ? "The role" : "The identity"} can ${writes.join("; ")}, so http_request could act with the connection's own credential.`,
    role ? "Ask the account admin to revoke USE CONNECTION on these connections from the role." : undefined,
  )
}

async function warehousesCheck(port: DatabricksPort, account: string, signal: AbortSignal): Promise<{ readonly checks: DoctorCheck[]; readonly warnings: DoctorWarning[] }> {
  try {
    const warehouses = await port.listWarehouses(account, signal)
    const warnings: DoctorWarning[] = []
    for (const warehouse of warehouses) {
      if (warehouse.autoStopMins === 0) warnings.push({ code: "AUTO_STOP_OFF", message: `${warehouse.name} never auto-stops and bills until someone stops it.` })
      else if (warehouse.autoStopMins > 30) warnings.push({ code: "AUTO_STOP_LONG", message: `${warehouse.name} auto-stops after ${warehouse.autoStopMins} minutes.` })
    }
    const autoStop = warehouses.map((warehouse) => `${warehouse.name} ${warehouse.autoStopMins === 0 ? "never" : `${warehouse.autoStopMins} min`}`).join(", ")
    const timeouts = warehouses.map((warehouse) => `${warehouse.name}: ${warehouse.statementTimeoutSeconds !== undefined ? `${warehouse.statementTimeoutSeconds}s` : "workspace default (2 days)"}`)
    return {
      checks: [
        check(
          "warehouses",
          "OK",
          warehouses.length === 0 ? "No SQL warehouse is visible." : `${warehouses.length} SQL warehouse(s); auto-stop ${autoStop}. Statement timeout: ${timeouts.join("; ")}.`,
          warehouses.some((warehouse) => warehouse.statementTimeoutSeconds === undefined)
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

/** The families that are not Unity Catalog reads, under the accepted decision: secrets and serving are not checked, jobs
 * are OK without the `jobs` scope and NOT_CHECKED with it. */
function remainingFamilies(token: Token): DoctorCheck[] {
  const fine = !token.scopes.includes("all-apis")
  const hasJobs = token.scopes.includes("jobs")
  return [
    check(
      "role:jobs",
      hasJobs ? "NOT_CHECKED" : "OK",
      hasJobs
        ? "The token carries the jobs scope, so job permissions needed checking and were not; job runs use each job's Run as identity."
        : "No job can run through this token: the jobs scope is not granted.",
      hasJobs ? "Ask an admin to review the role's job permissions, or sign in without the jobs feature." : undefined,
    ),
    check(
      "role:secret-scopes",
      "NOT_CHECKED",
      fine
        ? "Secret scopes were not checked: under fine-grained scopes they are reachable only through SQL functions the read path refuses or plans."
        : "Secret scopes were not checked, and this all-apis token can reach them, so a role is not certified.",
      fine ? undefined : "Sign in with fine-grained scopes to earn a role, or ask an admin to review the role's secret-scope grants.",
    ),
    check(
      "role:serving",
      "NOT_CHECKED",
      fine
        ? "Serving endpoints were not checked: under fine-grained scopes they are reachable only through SQL functions the read path refuses or plans."
        : "Serving endpoints were not checked, and this all-apis token can reach them, so a role is not certified.",
      fine ? undefined : "Sign in with fine-grained scopes to earn a role, or ask an admin to review the role's serving grants.",
    ),
  ]
}

/** One account's report. */
async function reportFor(input: DoctorInput, settings: AccountSettings): Promise<DoctorReport> {
  const port = input.databricks as DatabricksPort
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

  let principals: RolePrincipals = { names: [], resolved: false }
  let binding: ReportBinding | undefined
  if (token) {
    binding = { host: token.host, ...(info?.role?.groupId !== undefined ? { roleGroupId: info.role.groupId } : {}), grantedScopes: [...token.scopes] }
    try {
      identity = await port.me(alias, input.signal)
      checks.push(check("identity", "OK", `Signed in as ${identity.displayName ?? identity.userName} (${identity.userName}).`))
    } catch (error) {
      checks.push(failed("identity", error))
    }
    const roleBound = info?.role !== undefined
    principals = rolePrincipals(identity, info?.role?.groupId)
    const catalogChecks = await catalogsCheck(port, alias, input.signal, roleBound, principals)
    checks.push(...catalogChecks.checks)
    checks.push(...(await defaultSchemaChecks(port, alias, catalogChecks.catalogs, input.signal, roleBound, principals)))
    if (input.families) {
      for (const family of input.families) {
        try {
          checks.push(await family.run())
        } catch (error) {
          checks.push(failed(family.id, error))
        }
      }
    } else {
      checks.push(await connectionsCheck(port, alias, input.signal, roleBound, principals))
      checks.push(...remainingFamilies(token))
    }
    const house = await warehousesCheck(port, alias, input.signal)
    checks.push(...house.checks)
    warnings.push(...house.warnings)
    if (widerThanFeatures(token.scopes, settings.features)) warnings.push({ code: "SCOPE_WIDER_THAN_FEATURES", message: WARNINGS.SCOPE_WIDER_THAN_FEATURES })
  } else {
    checks.push(check("identity", "NOT_CHECKED", "No token, so the identity was not read.", "Fix the sign-in first."))
    checks.push(check("privileges", "NOT_CHECKED", "No token, so no privilege was checked.", "Fix the sign-in first."))
    for (const family of input.families ?? [{ id: "role:connections" }, { id: "role:jobs" }, { id: "role:secret-scopes" }, { id: "role:serving" }]) {
      checks.push(check(family.id, "NOT_CHECKED", "No token, so the role family was not checked.", "Fix the sign-in first."))
    }
  }

  const role = info?.role
  const fine = token !== undefined && !token.scopes.includes("all-apis")
  // A check that did not run blocks `role`, except where the guarantee explicitly excludes it (the accepted decision).
  const allowed = (item: DoctorCheck) => item.id === "role:jobs" || (fine && (item.id === "role:secret-scopes" || item.id === "role:serving"))
  const complete = token !== undefined && checks.every((item) => item.status === "OK" || (item.status === "NOT_CHECKED" && allowed(item)))
  const enforcement: DoctorReport["enforcement"] =
    info === undefined
      ? settings.mode === "m2m"
        ? "service-principal"
        : "identity"
      : info.mode === "m2m"
        ? "service-principal"
        : role !== undefined
          ? complete
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
    ...(role !== undefined ? { role: { ...role, ...(principals.resolved && principals.names[0] !== undefined ? { name: principals.names[0] } : {}) } } : {}),
    enforcement,
    ...(enforcement === "role" ? { claim: ROLE_ENFORCEMENT_TEXT } : {}),
    ...(binding !== undefined ? { binding } : {}),
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
