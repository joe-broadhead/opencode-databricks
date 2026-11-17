/**
 * A Jelly-hosted engine, where a headless mode must not run (design §3.2, §18.5).
 *
 * A hosted engine's environment and CLI belong to the host, not to the person, so `pat`, `m2m` and `cli` would run as
 * whatever identity the machine happens to hold. They are refused with `HEADLESS_REFUSED` unless the person sets
 * `allowHeadlessInHost`.
 *
 * Detection uses the one surface Jelly documents for a hosted engine: it hands plugin secrets over in memory through
 * `globalThis[Symbol.for("jelly.plugin-secrets")]` (design §18.5). Jelly itself also marks the agent's copy of a sign-in
 * by putting `jelly-host-owns-refresh` in place of the refresh token, which `refresh.ts` honours; that marker is not a
 * hosted-engine flag. The symbol is exposed so a simulated host can be built from the same definition the plugin uses.
 */
import { DatabricksError } from "../domain/errors.js"

export const JELLY_PLUGIN_SECRETS = Symbol.for("jelly.plugin-secrets")

/** Whether this process is a Jelly-hosted engine. */
export function isHostedEngine(scope: Record<PropertyKey, unknown> = globalThis as unknown as Record<PropertyKey, unknown>): boolean {
  return scope[JELLY_PLUGIN_SECRETS] !== undefined
}

/** The refusal, worded with the two ways out. */
export function headlessRefused(alias: string, mode: string): DatabricksError {
  return new DatabricksError(
    "HEADLESS_REFUSED",
    `Account ${alias} uses mode ${mode}, which this plugin refuses in a Jelly-hosted engine: the machine's environment and CLI are the host's identity, not yours.`,
    "Sign in interactively with /connect, or set the option allowHeadlessInHost if this engine really is yours.",
  )
}
