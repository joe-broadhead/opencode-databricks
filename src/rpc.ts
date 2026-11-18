// The status contract shared by the server part, the /databricks-status command and the TUI view. Portable and small:
// it imports only the RPC definition helper, constants and (type only, so it is erased) the tool contract, and the rest
// is plain JSON Schema, so the TUI bundle carries no zod.
//
// The statuses of `databricks_status` (src/domain/contract.ts) and of the view are one shape: the view adds what only
// OpenCode can answer (agents without the default rules, a shadowed skill, the host version) and the row formatting.
// Everything here is built from the plugin's own words and validated names: warehouse and identity names are
// sanitized before they get here (design §5.8).
import { Rpc } from "@opencode/plugin/rpc"
import { ACCESS_VALUES, type Access, DISPLAY_NAME, NAMESPACE, PLUGIN_ID } from "./constants.js"
import type { Output } from "./domain/contract.js"

export const STATES = ["ready", "sign_in_required", "not_configured"] as const
const EFFECTS = ["allow", "ask", "deny"] as const
const WRITES = ["without asking", "ask", "never"] as const
const ENFORCEMENTS = ["role", "role-requested", "identity", "service-principal"] as const
const MODES = ["interactive", "pat", "m2m", "cli"] as const
const CLOUDS = ["aws", "azure", "gcp", "custom"] as const
const WAREHOUSE_STATES = ["STARTING", "RUNNING", "STOPPING", "STOPPED", "DELETING", "DELETED"] as const
const WAREHOUSE_TYPES = ["serverless", "pro", "classic"] as const
const BUDGET_STATES = ["off", "ok", "warn", "reached"] as const
const AUTOMATION_MODES = ["auto", "on", "off"] as const

export type Rule = { readonly action: string; readonly resource: string; readonly effect: (typeof EFFECTS)[number] }
export type SkillPath = { readonly id: string; readonly path: string }
export type Enforcement = (typeof ENFORCEMENTS)[number]
export type AccountStatus = Output<"status">["accounts"][number]
export type RunningItem = Output<"status">["running"][number]
export type Spend = NonNullable<Output<"status">["spend"]>
export type CleanupAction = NonNullable<Output<"status">["cleanup"]>[number]

export type Status = {
  readonly version: string
  readonly state: (typeof STATES)[number]
  readonly access: Access
  /** `without asking` at access all (design §5.6). */
  readonly writes: (typeof WRITES)[number]
  /** The §5.6 disclosure, verbatim. */
  readonly disclosure: string
  /** Masks and row filters run functions the plugin cannot see (review round 3, LOW 1). */
  readonly policies: string
  readonly accounts: readonly AccountStatus[]
  readonly running: readonly RunningItem[]
  readonly spend?: Spend
  readonly automation: { readonly mode: (typeof AUTOMATION_MODES)[number]; readonly active: boolean }
  readonly cleanup?: readonly CleanupAction[]
  readonly unguardedAgents: readonly string[]
  readonly permissionsBlock?: readonly Rule[]
  readonly shadowedSkills?: readonly SkillPath[]
  /** What this process could not read, or the last refusal of an automation sweep. */
  readonly problems?: readonly string[]
  readonly host: { readonly version: string; readonly range: string; readonly tested: boolean }
  readonly hostWarning?: string
  readonly nextStep: string
}

const text = { type: "string" } as const
const texts = { type: "array", items: text } as const
const number = { type: "number" } as const
const integer = { type: "integer" } as const
const object = (properties: Record<string, object>, required: readonly string[]) => ({ type: "object", properties, required, additionalProperties: false }) as const

const rule = object({ action: text, resource: text, effect: { enum: EFFECTS } }, ["action", "resource", "effect"])
const skillPath = object({ id: text, path: text }, ["id", "path"])

const account = object(
  {
    alias: text,
    mode: { enum: MODES },
    host: text,
    cloud: { enum: CLOUDS },
    identity: object({ userName: text, id: text, displayName: text }, ["userName", "id"]),
    role: text,
    enforcement: { enum: ENFORCEMENTS },
    writes: { enum: WRITES },
    scopes: texts,
    warehouse: object(
      { id: text, state: { enum: WAREHOUSE_STATES }, type: { enum: WAREHOUSE_TYPES }, size: text, autoStopMinutes: number, usdPerHour: number },
      ["id", "state", "type", "size", "autoStopMinutes", "usdPerHour"],
    ),
  },
  ["alias", "mode", "enforcement", "writes", "scopes"],
)
const running = object({ kind: { enum: ["statement", "run"] }, id: text, warehouse: text, startedAt: text, tool: text }, ["kind", "id", "startedAt", "tool"])
const spend = object(
  {
    startsToday: number,
    dbuHoursToday: number,
    dbuHoursSession: number,
    estimate: { type: "boolean" },
    budget: object({ state: { enum: BUDGET_STATES }, limit: number }, ["state"]),
  },
  ["startsToday", "dbuHoursToday", "dbuHoursSession", "estimate", "budget"],
)
const automation = object({ mode: { enum: AUTOMATION_MODES }, active: { type: "boolean" } }, ["mode", "active"])
const cleanup = object({ what: text, usdPerHour: number, next: text }, ["what", "next"])

export const STATUS_SCHEMA = object(
  {
    version: text,
    state: { enum: STATES },
    access: { enum: ACCESS_VALUES },
    writes: { enum: WRITES },
    disclosure: text,
    policies: text,
    accounts: { type: "array", items: account },
    running: { type: "array", items: running },
    spend,
    automation,
    cleanup: { type: "array", items: cleanup },
    unguardedAgents: texts,
    permissionsBlock: { type: "array", items: rule },
    shadowedSkills: { type: "array", items: skillPath },
    problems: texts,
    host: object({ version: text, range: text, tested: { type: "boolean" } }, ["version", "range", "tested"]),
    hostWarning: text,
    nextStep: text,
  },
  ["version", "state", "access", "writes", "disclosure", "policies", "accounts", "running", "automation", "unguardedAgents", "host", "nextStep"],
)

export const DatabricksRpc = Rpc.define({
  id: PLUGIN_ID,
  methods: {
    status: {
      input: object({}, []),
      output: STATUS_SCHEMA,
      errors: { unavailable: object({ reason: text }, ["reason"]) },
    },
  },
  events: {},
})

type Record_ = Record<string, unknown>
const isRecord = (value: unknown): value is Record_ => typeof value === "object" && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === "string"
const isTexts = (value: unknown) => Array.isArray(value) && value.every(isText)
const isNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value)
const only = (value: Record_, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key))
const missing = (value: Record_, keys: readonly string[]) => keys.every((key) => value[key] !== undefined)
const isOptional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value)
const inList = (value: unknown, list: readonly string[]) => typeof value === "string" && list.includes(value)
const isRule = (value: unknown) => isRecord(value) && only(value, ["action", "resource", "effect"]) && isText(value.action) && isText(value.resource) && inList(value.effect, EFFECTS)
const isSkillPath = (value: unknown) => isRecord(value) && only(value, ["id", "path"]) && isText(value.id) && isText(value.path)
const isIdentity = (value: unknown) => isRecord(value) && only(value, ["userName", "id", "displayName"]) && isText(value.userName) && isText(value.id) && isOptional(value.displayName, isText)

const isWarehouse = (value: unknown) =>
  isRecord(value) &&
  only(value, ["id", "state", "type", "size", "autoStopMinutes", "usdPerHour"]) &&
  isText(value.id) &&
  inList(value.state, WAREHOUSE_STATES) &&
  inList(value.type, WAREHOUSE_TYPES) &&
  isText(value.size) &&
  isNumber(value.autoStopMinutes) &&
  isNumber(value.usdPerHour)

const isAccount = (value: unknown) =>
  isRecord(value) &&
  only(value, ["alias", "mode", "host", "cloud", "identity", "role", "enforcement", "writes", "scopes", "warehouse"]) &&
  isText(value.alias) &&
  inList(value.mode, MODES) &&
  isOptional(value.host, isText) &&
  isOptional(value.cloud, (cloud) => inList(cloud, CLOUDS)) &&
  isOptional(value.identity, isIdentity) &&
  isOptional(value.role, isText) &&
  inList(value.enforcement, ENFORCEMENTS) &&
  inList(value.writes, WRITES) &&
  isTexts(value.scopes) &&
  isOptional(value.warehouse, isWarehouse)

const isRunning = (value: unknown) =>
  isRecord(value) && only(value, ["kind", "id", "warehouse", "startedAt", "tool"]) && inList(value.kind, ["statement", "run"]) && isText(value.id) && isOptional(value.warehouse, isText) && isText(value.startedAt) && isText(value.tool)

const isSpend = (value: unknown) =>
  isRecord(value) &&
  only(value, ["startsToday", "dbuHoursToday", "dbuHoursSession", "estimate", "budget"]) &&
  isNumber(value.startsToday) &&
  isNumber(value.dbuHoursToday) &&
  isNumber(value.dbuHoursSession) &&
  typeof value.estimate === "boolean" &&
  isRecord(value.budget) &&
  only(value.budget, ["state", "limit"]) &&
  inList(value.budget.state, BUDGET_STATES) &&
  isOptional(value.budget.limit, isNumber)

const isAutomation = (value: unknown) => isRecord(value) && only(value, ["mode", "active"]) && inList(value.mode, AUTOMATION_MODES) && typeof value.active === "boolean"
const isCleanup = (value: unknown) => isRecord(value) && only(value, ["what", "usdPerHour", "next"]) && isText(value.what) && isOptional(value.usdPerHour, isNumber) && isText(value.next)

/** JSON Schema outputs reach clients unchecked, so readers check a status against the schema's rules. */
export function isStatus(value: unknown): value is Status {
  if (!isRecord(value) || !only(value, Object.keys(STATUS_SCHEMA.properties))) return false
  const { host, accounts, running, spend, automation, cleanup } = value
  return (
    isText(value.version) &&
    inList(value.state, STATES) &&
    inList(value.access, ACCESS_VALUES) &&
    inList(value.writes, WRITES) &&
    isText(value.disclosure) &&
    isText(value.policies) &&
    Array.isArray(accounts) && accounts.every(isAccount) &&
    Array.isArray(running) && running.every(isRunning) &&
    isOptional(spend, isSpend) &&
    isAutomation(automation) &&
    isOptional(cleanup, (actions) => Array.isArray(actions) && actions.every(isCleanup)) &&
    isTexts(value.unguardedAgents) &&
    isOptional(value.permissionsBlock, (block) => Array.isArray(block) && block.every(isRule)) &&
    isOptional(value.shadowedSkills, (skills) => Array.isArray(skills) && skills.every(isSkillPath)) &&
    isOptional(value.problems, isTexts) &&
    isRecord(host) && only(host, ["version", "range", "tested"]) && isText(host.version) && isText(host.range) && typeof host.tested === "boolean" &&
    isOptional(value.hostWarning, isText) &&
    isText(value.nextStep)
  )
}

const STATE_LABELS: Record<Status["state"], string> = { ready: "ready", sign_in_required: "sign-in required", not_configured: "no workspace configured" }

export const NOTHING_TO_DO = "Nothing to do."
export const STATUS_COMMAND = `${NAMESPACE}-status`
export const CLEANUP_COMMAND = `${NAMESPACE}-cleanup`

/** The next step for agents without the default rules: one fixed sentence across the plugins. */
export const AGENT_STEP = `Put the default rules shown by /${STATUS_COMMAND} first in each listed agent's own permissions, in opencode.json or the agent's Markdown file, followed by your top-level rules for ${DISPLAY_NAME} tools.`

export type StatusRow = { readonly label: string; readonly value: string }

export function formatRules(rules: readonly Rule[]): string {
  return `[\n${rules.map((item) => `  ${JSON.stringify(item)}`).join(",\n")}\n]`
}

const ACCESS_TEXT: Record<Access, string> = {
  all: "every tool runs without asking, reads and changes alike",
  "ask-changes": "reads run without asking; each change and each warehouse start asks first",
  "read-only": "reads run, and may start a small serverless warehouse that bills until it auto-stops; changes never run",
}

const ENFORCEMENT_TEXT: Record<Enforcement, string> = {
  role: "a role, proven by /databricks-doctor",
  "role-requested": "a role, not yet proven: run /databricks-doctor",
  identity: "your own identity and privileges",
  "service-principal": "a service principal",
}

const dbus = (value: number) => (Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : "0")

function describeHost(status: Pick<Status, "host" | "hostWarning">): string {
  if (status.host.tested) return `${status.host.version} (tested)`
  if (status.hostWarning) return `${status.host.version} (untested: ${status.hostWarning})`
  return `${status.host.version} (untested; supported range ${status.host.range})`
}

function accountsText(accounts: readonly AccountStatus[]): string {
  if (accounts.length === 0) return "none"
  return accounts
    .map((account) => `${account.alias} (${account.mode}): ${account.identity?.userName ?? "not signed in"}; runs as ${ENFORCEMENT_TEXT[account.enforcement]}${account.role ? ` (${account.role})` : ""}`)
    .join("; ")
}

function warehousesText(accounts: readonly AccountStatus[]): string {
  const described = accounts.filter((account) => account.warehouse !== undefined).map((account) => {
    const warehouse = account.warehouse!
    return `${account.alias}: ${warehouse.id} ${warehouse.state}, ${warehouse.size} ${warehouse.type}, auto-stop ${warehouse.autoStopMinutes} min, ~$${warehouse.usdPerHour.toFixed(2)}/h`
  })
  return described.length ? described.join("; ") : "none configured"
}

function runningText(running: readonly RunningItem[]): string {
  if (running.length === 0) return "nothing this plugin started is still running"
  return running.map((item) => `${item.tool} on ${item.warehouse ?? "a warehouse"} (${item.id}, started ${item.startedAt})`).join("; ")
}

function spendText(spend: Spend): string {
  const budget = spend.budget.state === "off" ? "no budget" : `budget ${spend.budget.state}${spend.budget.limit === undefined ? "" : ` (${spend.budget.limit})`}`
  return `today ${spend.startsToday} start${spend.startsToday === 1 ? "" : "s"}, ${dbus(spend.dbuHoursToday)} DBU-hours; this session ${dbus(spend.dbuHoursSession)}; an estimate, not a bill; ${budget}`
}

const AUTOMATION_TEXT = (status: Status): string => {
  const consent = status.automation.mode === "on" ? "you set automation: \"on\"" : status.automation.mode === "off" ? "you set automation: \"off\"" : status.automation.active ? "auto, on at access all" : "auto, off because access is not all"
  return `${consent}; ${status.automation.active ? "it cancels this plugin's own orphaned reads and stops nothing else" : "it cancels this plugin's own orphaned reads; add automation: \"on\" to consent, which this version uses for nothing else"}`
}

function cleanupText(cleanup: readonly CleanupAction[] | undefined): string {
  if (!cleanup || cleanup.length === 0) return "nothing to clean up"
  return cleanup.map((action) => `${action.what} ${action.next}`).join("; ")
}

/** The status as labelled rows, in the order the dialog and /databricks-status show them. */
export function statusRows(status: Status): StatusRow[] {
  return [
    { label: "Connection", value: STATE_LABELS[status.state] },
    { label: "Workspaces", value: accountsText(status.accounts) },
    { label: "Access", value: ACCESS_TEXT[status.access] },
    { label: "Writes", value: `${status.writes}. ${status.disclosure}` },
    { label: "Masks and filters", value: status.policies },
    { label: "Warehouses", value: warehousesText(status.accounts) },
    { label: "Running", value: runningText(status.running) },
    ...(status.spend ? [{ label: "Spend", value: spendText(status.spend) }] : []),
    { label: "Automation", value: AUTOMATION_TEXT(status) },
    { label: "Cleanup", value: cleanupText(status.cleanup) },
    { label: "Agents without default rules", value: status.unguardedAgents.length > 0 ? status.unguardedAgents.join(", ") : "none" },
    ...(status.shadowedSkills?.length ? [{ label: "Skills", value: status.shadowedSkills.map((skill) => `${skill.id} replaced by ${skill.path}`).join("; ") }] : []),
    ...(status.problems?.length ? [{ label: "Problems", value: status.problems.join(" ") }] : []),
    { label: "OpenCode", value: describeHost(status) },
    { label: "Next step", value: status.nextStep },
  ]
}

export function formatStatus(status: Status): string {
  const lines: string[] = [`${DISPLAY_NAME} status`]
  for (const row of statusRows(status)) {
    lines.push(`${row.label}: ${row.value}`)
    if (row.label === "Agents without default rules" && status.unguardedAgents.length > 0) lines.push(formatRules(status.permissionsBlock ?? []))
  }
  return lines.join("\n")
}
