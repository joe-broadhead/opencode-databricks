/**
 * `status` (contract §11): the plugin's identity, its host range, every account alias and its sign-in state, and the
 * agents that lack the generated access rules. `statusAnswer` assembles the answer; this handler only asks the accounts
 * and the host for what it needs.
 */
import { accountStatuses, accountsOf, redactReason, statusAnswer, STATUS_SCHEMA } from "@we-the-rebel-alliance/plugin-contract/accounts"
import type { MethodCall, MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import type { Manifest } from "@we-the-rebel-alliance/plugin-contract/manifest"
import { DatabricksError } from "../domain/errors.js"
import type { Deps } from "./deps.js"
import { ownerOf } from "./sources/owner.js"

export interface StatusParts {
  readonly manifest: Manifest
  readonly version: string
  readonly hostVersion: string
  readonly deps: Deps
  readonly accountProblems: readonly string[]
}

export function createStatusHandler(parts: StatusParts): MethodHandler {
  const { manifest, version, hostVersion, deps, accountProblems } = parts
  return {
    description: "The plugin's state, host range, account aliases and their sign-in state.",
    input: { type: "object", properties: {}, additionalProperties: false },
    output: STATUS_SCHEMA,
    async run(_input, call) {
      const plan = accountsOf(manifest, deps.options as unknown as Record<string, unknown>)
      if (!plan.ok) {
        return statusAnswer({
          manifest,
          version,
          hostVersion,
          accounts: [],
          problems: [...accountProblems, ...plan.problems],
          unguardedAgents: await call.unguardedAgents(),
        })
      }
      const signals: Record<string, { state: "ready" | "needs_sign_in" | "error"; owner?: { id: string; label: string }; reason?: string }> = {}
      for (const profile of plan.value.accounts) {
        try {
          const host = deps.auth.account(profile.alias).host
          const me = await deps.databricks.me(profile.alias, call.signal)
          signals[profile.alias] = { state: "ready", owner: ownerOf(me, host) }
        } catch (error) {
          if (error instanceof DatabricksError && (error.code === "AUTH_REQUIRED" || error.code === "AUTH_CLIENT_INVALID")) {
            signals[profile.alias] = { state: "needs_sign_in" }
          } else {
            const reason = error instanceof Error ? error.message : String(error)
            signals[profile.alias] = { state: "error", reason: redactReason(reason).slice(0, 160) }
          }
        }
      }
      return statusAnswer({
        manifest,
        version,
        hostVersion,
        accounts: accountStatuses(plan.value.accounts, signals),
        problems: [...accountProblems],
        unguardedAgents: await call.unguardedAgents(),
      })
    },
  }
}
