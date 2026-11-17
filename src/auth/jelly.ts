/**
 * A Jelly-hosted engine, where a headless mode must not run (design §3.2, §18.5).
 *
 * A hosted engine's environment and CLI belong to the host, not to the person, so `pat`, `m2m` and `cli` would run as
 * whatever identity the machine happens to hold. They are refused with `HEADLESS_REFUSED` unless the person sets
 * `allowHeadlessInHost`.
 *
 * Detection uses the surfaces Jelly documents for a hosted engine. Its `installEngineHandoff` installs three public
 * in-process keys: `jelly.plugin-secrets`, `jelly.engine-seal` and `jelly.action-key` (ADR 0016), and the core plugin
 * installs them while its module loads, before any plugin's setup runs. Any one of them marks a hosted engine. It can
 * still fail open if the handoff fetch failed ("an engine without it runs"); Jelly starts engines from an almost empty
 * environment, so `pat` and `m2m` then find no variable and answer AUTH_REQUIRED, and only `cli` could find a binary on
 * PATH. This is the residual `docs/auth.md` records, and Jelly is asked for one explicit, always-set marker.
 *
 * Jelly also marks the agent's copy of a sign-in with `jelly-host-owns-refresh` in place of the refresh token, which
 * `refresh.ts` honours; that marker is not a hosted-engine flag.
 */
import { DatabricksError } from "../domain/errors.js"

export const JELLY_PLUGIN_SECRETS = Symbol.for("jelly.plugin-secrets")
export const JELLY_ENGINE_SEAL = Symbol.for("jelly.engine-seal")
export const JELLY_ACTION_KEY = Symbol.for("jelly.action-key")
const MARKERS = [JELLY_PLUGIN_SECRETS, JELLY_ENGINE_SEAL, JELLY_ACTION_KEY]

/** Whether this process is a Jelly-hosted engine. */
export function isHostedEngine(scope: Record<PropertyKey, unknown> = globalThis as unknown as Record<PropertyKey, unknown>): boolean {
  return MARKERS.some((marker) => scope[marker] !== undefined)
}

/** The refusal, worded with the two ways out. */
export function headlessRefused(alias: string, mode: string): DatabricksError {
  return new DatabricksError(
    "HEADLESS_REFUSED",
    `Account ${alias} uses mode ${mode}, which this plugin refuses in a Jelly-hosted engine: the machine's environment and CLI are the host's identity, not yours.`,
    "Sign in interactively with /connect, or set the option allowHeadlessInHost if this engine really is yours.",
  )
}
