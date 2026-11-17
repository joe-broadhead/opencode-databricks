// The status contract shared by the server part, the /databricks-status command and the TUI view. Portable and small:
// it imports only the RPC definition helper and constants, and the contract is plain JSON Schema, so the TUI bundle
// carries no zod. Day 0's status is the skeleton: accounts, access, the disclosures, the tool count, agents, host.
// Package F adds identity, warehouses, spend, running statements and automation (design §14).
import { Rpc } from "@opencode/plugin/rpc"
import { ACCESS_VALUES, type Access, DISPLAY_NAME, NAMESPACE, PLUGIN_ID } from "./constants.js"

export const STATES = ["ready", "sign_in_required", "not_configured"] as const
const EFFECTS = ["allow", "ask", "deny"] as const
const WRITES = ["without asking", "ask", "never"] as const

export type Rule = { readonly action: string; readonly resource: string; readonly effect: (typeof EFFECTS)[number] }
export type SkillPath = { readonly id: string; readonly path: string }

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
  readonly accounts: readonly { readonly alias: string; readonly mode: string }[]
  readonly tools: { readonly declared: number; readonly built: number }
  readonly unguardedAgents: readonly string[]
  readonly permissionsBlock?: readonly Rule[]
  readonly shadowedSkills?: readonly SkillPath[]
  readonly problems?: readonly string[]
  readonly host: { readonly version: string; readonly range: string; readonly tested: boolean }
  readonly hostWarning?: string
  readonly nextStep: string
}

const text = { type: "string" } as const
const texts = { type: "array", items: text } as const
const object = (properties: Record<string, object>, required: readonly string[]) => ({ type: "object", properties, required, additionalProperties: false }) as const

const rule = object({ action: text, resource: text, effect: { enum: EFFECTS } }, ["action", "resource", "effect"])
const skillPath = object({ id: text, path: text }, ["id", "path"])
const count = { type: "integer", minimum: 0 } as const

export const STATUS_SCHEMA = object(
  {
    version: text,
    state: { enum: STATES },
    access: { enum: ACCESS_VALUES },
    writes: { enum: WRITES },
    disclosure: text,
    policies: text,
    accounts: { type: "array", items: object({ alias: text, mode: text }, ["alias", "mode"]) },
    tools: object({ declared: count, built: count }, ["declared", "built"]),
    unguardedAgents: texts,
    permissionsBlock: { type: "array", items: rule },
    shadowedSkills: { type: "array", items: skillPath },
    problems: texts,
    host: object({ version: text, range: text, tested: { type: "boolean" } }, ["version", "range", "tested"]),
    hostWarning: text,
    nextStep: text,
  },
  ["version", "state", "access", "writes", "disclosure", "policies", "accounts", "tools", "unguardedAgents", "host", "nextStep"],
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
const only = (value: Record_, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key))
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value)
const isRule = (value: unknown) => isRecord(value) && only(value, ["action", "resource", "effect"]) && isText(value.action) && isText(value.resource) && EFFECTS.includes(value.effect as never)
const isSkillPath = (value: unknown) => isRecord(value) && only(value, ["id", "path"]) && isText(value.id) && isText(value.path)
const isCount = (value: unknown) => Number.isInteger(value) && (value as number) >= 0

/** JSON Schema outputs reach clients unchecked, so readers check a status against the schema's rules. */
export function isStatus(value: unknown): value is Status {
  if (!isRecord(value) || !only(value, Object.keys(STATUS_SCHEMA.properties))) return false
  const { tools, host, accounts } = value
  return (
    isText(value.version) &&
    STATES.includes(value.state as never) &&
    ACCESS_VALUES.includes(value.access as never) &&
    WRITES.includes(value.writes as never) &&
    isText(value.disclosure) &&
    isText(value.policies) &&
    Array.isArray(accounts) && accounts.every((item) => isRecord(item) && only(item, ["alias", "mode"]) && isText(item.alias) && isText(item.mode)) &&
    isRecord(tools) && only(tools, ["declared", "built"]) && isCount(tools.declared) && isCount(tools.built) &&
    isTexts(value.unguardedAgents) &&
    optional(value.permissionsBlock, (block) => Array.isArray(block) && block.every(isRule)) &&
    optional(value.shadowedSkills, (skills) => Array.isArray(skills) && skills.every(isSkillPath)) &&
    optional(value.problems, isTexts) &&
    isRecord(host) && only(host, ["version", "range", "tested"]) && isText(host.version) && isText(host.range) && typeof host.tested === "boolean" &&
    optional(value.hostWarning, isText) &&
    isText(value.nextStep)
  )
}

const STATE_LABELS: Record<Status["state"], string> = { ready: "ready", sign_in_required: "sign-in required", not_configured: "no workspace configured" }

export const NOTHING_TO_DO = "Nothing to do."
export const STATUS_COMMAND = `${NAMESPACE}-status`

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

function describeHost(status: Pick<Status, "host" | "hostWarning">): string {
  if (status.host.tested) return `${status.host.version} (tested)`
  if (status.hostWarning) return `${status.host.version} (untested: ${status.hostWarning})`
  return `${status.host.version} (untested; supported range ${status.host.range})`
}

/** The status as labelled rows, in the order the dialog and /databricks-status show them. */
export function statusRows(status: Status): StatusRow[] {
  return [
    { label: "Connection", value: STATE_LABELS[status.state] },
    { label: "Workspaces", value: status.accounts.length ? status.accounts.map((account) => `${account.alias} (${account.mode})`).join(", ") : "none" },
    { label: "Access", value: ACCESS_TEXT[status.access] },
    { label: "Writes", value: `${status.writes}. ${status.disclosure}` },
    { label: "Masks and filters", value: status.policies },
    { label: "Tools", value: `${status.tools.built} of ${status.tools.declared} built` },
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
