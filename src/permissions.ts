// Default permission rules for the plugin's actions, inserted into each agent right after its base `* * allow` rule.
// OpenCode applies the last matching rule, so the agent's own stricter rules, the user's `permissions` rules and saved
// approvals all still win. The `access` option generates the block from the one tool table (src/domain/actions.ts), and
// it gives every action the effect Jelly's own rules give it at the same level (test/unit/jelly.test.ts).
import type { Plugin } from "@opencode/plugin"
import { type Access, NAMESPACE } from "./constants.js"
import { actionOf, PERMISSION_ONLY, START_ACTION, TOOLS } from "./domain/actions.js"
import { errorText } from "./domain/errors.js"
import { reasonOf } from "./redact.js"

export type Effect = "allow" | "ask" | "deny"
export type Rule = { readonly action: string; readonly resource: string; readonly effect: Effect }

/** What a change gets at each access (OD-29): allowed, asked, denied. */
export function changeEffect(access: Access): Effect {
  return access === "all" ? "allow" : access === "ask-changes" ? "ask" : "deny"
}

/** A warehouse start: allowed at all, asked at ask-changes, allowed at read-only (design §5.5, §6.2, §10.3). */
export function startEffect(access: Access): Effect {
  return access === "ask-changes" ? "ask" : "allow"
}

const rule = (action: string, effect: Effect): Rule => ({ action, resource: "*", effect })

/**
 * Broad first, narrow last. `databricks.*` gives every action the change effect, so an action this table does not
 * know (a tool added later) is treated like a change; then each read, `databricks.probe` and `databricks.read` is allowed, `databricks.start`
 * gets its own effect, and each change gets the change effect.
 */
export function defaultRules(access: Access = "all"): Rule[] {
  const change = changeEffect(access)
  return [
    rule(`${NAMESPACE}.*`, change),
    ...TOOLS.filter((tool) => tool.readOnly).map((tool) => rule(actionOf(tool.name), "allow")),
    ...PERMISSION_ONLY.map((entry) => rule(entry.action, entry.action === START_ACTION ? startEffect(access) : "allow")),
    ...TOOLS.filter((tool) => !tool.readOnly).map((tool) => rule(actionOf(tool.name), change)),
  ]
}

const isBaseAllow = (item: Rule) => item.action === "*" && item.resource === "*" && item.effect === "allow"
const same = (a: Rule, b: Rule) => a.action === b.action && a.resource === b.resource && a.effect === b.effect

/** Inserts `defaults` right after the first base allow rule, unless the block is already after it. */
export function insertDefaults<R extends Rule>(rules: readonly R[], defaults: readonly R[]): R[] {
  const base = rules.findIndex(isBaseAllow)
  if (base === -1 || hasBlockAfter(rules, base, defaults)) return [...rules]
  return [...rules.slice(0, base + 1), ...defaults.map((item) => ({ ...item })), ...rules.slice(base + 1)]
}

/** OpenCode's wildcards: `*` matches any run of characters and `?` one character, over the whole text. */
export const matches = (pattern: string, value: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(value)

/** The effect of `rules` for one call: the last rule whose action and resource both match wins, and no match asks. */
export function effectOf(rules: readonly Rule[], action: string, resource = "*"): Effect {
  return rules.findLast((item) => matches(item.action, action) && matches(item.resource, resource))?.effect ?? "ask"
}

/** Agents without the block whose own rules would let an unknown action of this plugin run without asking. */
export function unguardedAgents(agents: readonly { readonly id: string; readonly permissions: readonly Rule[] }[], access: Access = "all"): string[] {
  const defaults = defaultRules(access)
  return agents
    .filter((agent) => !hasBlockAfter(agent.permissions, agent.permissions.findIndex(isBaseAllow), defaults))
    .filter((agent) => effectOf(agent.permissions, `${NAMESPACE}.unknown_tool`) === "allow")
    .map((agent) => agent.id)
}

function hasBlockAfter(rules: readonly Rule[], base: number, defaults: readonly Rule[]): boolean {
  if (base === -1) return false
  for (let start = base + 1; start + defaults.length <= rules.length; start++) {
    if (defaults.every((item, index) => rules[start + index] !== undefined && same(rules[start + index]!, item))) return true
  }
  return false
}

type AgentContext = { readonly agent: Pick<Plugin.Context["agent"], "transform"> }

/** Registers the default rules for every agent. Synchronous and never throws; a failure is kept for status. */
export async function registerPermissionDefaults(ctx: AgentContext, access: Access, report: (problem: string | undefined) => void): Promise<{ dispose(): Promise<void> }> {
  const defaults = defaultRules(access)
  return ctx.agent.transform((editor) => {
    try {
      for (const agent of editor.list()) {
        editor.update(agent.id, (item) => {
          item.permissions = insertDefaults(item.permissions, defaults)
        })
      }
      report(undefined)
    } catch (error) {
      report(errorText("RULES_NOT_ADDED", `The default permission rules could not be added (${reasonOf(error)}), so Databricks tools may run without asking.`, "Restart OpenCode."))
    }
  })
}
