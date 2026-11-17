// One status, computed fresh on every call, behind the /databricks-status command and the RPC method the TUI view uses.
// Day 0 makes no Databricks call: it reads the options, OpenCode's agents and skills, and the registry. Package F
// replaces `computeStatus` with the full status of design §14, keeping this file's registration.
import type { Plugin } from "@opencode/plugin"
import { type Access, DISPLAY_NAME, SUPPORTED_HOST, TESTED_HOSTS } from "./constants.js"
import { TOOLS } from "./domain/actions.js"
import { POLICY_DISCLOSURE, WRITE_DISCLOSURE } from "./domain/contract.js"
import { DatabricksError } from "./domain/errors.js"
import { isTestedHost } from "./host-version.js"
import type { Options } from "./options.js"
import { defaultRules, unguardedAgents } from "./permissions.js"
import { AGENT_STEP, DatabricksRpc, formatStatus, NOTHING_TO_DO, type SkillPath, type Status, STATUS_COMMAND } from "./rpc.js"
import { PLUGIN_VERSION } from "./version.js"

const UNAVAILABLE = new DatabricksError("STATUS_UNAVAILABLE").message

type StatusContext = {
  readonly agent: Pick<Plugin.Context["agent"], "list">
  readonly skill: Pick<Plugin.Context["skill"], "list">
}

export type StatusDeps = {
  readonly options: Options
  readonly hostVersion: string
  readonly hostWarning?: string
  readonly skills: readonly SkillPath[]
  readonly problems: () => readonly string[]
  /** How many tools have a real handler; the rest answer NOT_IMPLEMENTED. */
  readonly built: () => number
}

const writesAt = (access: Access): Status["writes"] => (access === "all" ? "without asking" : access === "ask-changes" ? "ask" : "never")

export async function computeStatus(ctx: StatusContext, deps: StatusDeps): Promise<Status> {
  const [agents, listed] = await Promise.all([ctx.agent.list(), ctx.skill.list().then((result) => result.data, () => undefined)])
  const access = deps.options.access
  const accounts = Object.entries(deps.options.accounts ?? {}).map(([alias, account]) => ({ alias, mode: account.mode }))
  const unguarded = unguardedAgents(agents.data, access)
  const shadowed = deps.skills.flatMap((skill) => {
    const found = (listed ?? []).find((item) => item.id === skill.id)
    return found && found.path !== skill.path ? [{ id: skill.id, path: found.path }] : []
  })
  const problems = deps.problems()
  const state: Status["state"] = accounts.length === 0 ? "not_configured" : "sign_in_required"
  return {
    version: PLUGIN_VERSION,
    state,
    access,
    writes: writesAt(access),
    disclosure: WRITE_DISCLOSURE,
    policies: POLICY_DISCLOSURE,
    accounts,
    tools: { declared: TOOLS.length, built: deps.built() },
    unguardedAgents: unguarded,
    ...(unguarded.length > 0 ? { permissionsBlock: defaultRules(access) } : {}),
    ...(shadowed.length > 0 ? { shadowedSkills: shadowed } : {}),
    ...(problems.length > 0 ? { problems: [...problems] } : {}),
    host: { version: deps.hostVersion, range: SUPPORTED_HOST, tested: isTestedHost(deps.hostVersion) },
    ...(deps.hostWarning ? { hostWarning: deps.hostWarning } : {}),
    nextStep:
      problems[0]?.split("Next step: ")[1] ??
      (state === "not_configured" ? `Run /connect and choose ${DISPLAY_NAME}, or add an account under the plugin option accounts.` : undefined) ??
      (unguarded.length > 0 ? AGENT_STEP : undefined) ??
      (shadowed.length > 0 ? `Rename or move the skill ${shadowed[0]!.id} at ${shadowed[0]!.path}, which OpenCode loads instead of the plugin's.` : undefined) ??
      (deps.hostWarning ? `If ${DISPLAY_NAME} misbehaves, use OpenCode ${TESTED_HOSTS.slice(0, -1).join(", ")} or ${TESTED_HOSTS.at(-1)}, where it is tested.` : undefined) ??
      NOTHING_TO_DO,
  }
}

type RegisterContext = StatusContext & {
  readonly command: Pick<Plugin.Context["command"], "transform">
  readonly rpc: Pick<Plugin.Context["rpc"], "register">
  readonly session: Pick<Plugin.Context["session"], "synthetic">
}

export async function registerStatus(ctx: RegisterContext, deps: StatusDeps): Promise<{ dispose(): Promise<void> }> {
  const compute = () => computeStatus(ctx, deps)
  const registrations: Array<{ dispose(): Promise<void> }> = []
  try {
    registrations.push(
      await ctx.command.transform((editor) => {
        editor.add({
          name: STATUS_COMMAND,
          description: `Show the ${DISPLAY_NAME} workspaces, what the agent may do, and what to do next`,
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
            return error("unavailable", UNAVAILABLE, { reason: "OpenCode did not report its agents or skills." })
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
