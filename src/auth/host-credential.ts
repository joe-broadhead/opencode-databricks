/**
 * Reading a sign-in from OpenCode's credential store (design §3.2; review of #5, M4).
 *
 * The store is the host's, and single-use refresh tokens (Beta [12]) mean a second process's rotation invalidates the
 * credential this process holds. When `resolve` fails, a second `active` and `resolve` reads what the winner has just
 * stored: the host persists the credential a refresh callback returns, so the second read usually succeeds. That is the
 * mitigation the review accepts; the residual race is in `docs/auth.md` and the README's Known limits.
 *
 * `resolve` may also renew a credential itself. Its failure is the sign-in's failure only after the second read.
 */
import { DatabricksError } from "../domain/errors.js"
import { integrationIdFor } from "./form.js"
import type { HostConnection, HostCredential } from "./types.js"

/** The two calls of `ctx.integration.connection` this package needs. */
export interface HostCredentialStore {
  active(integrationID: string): Promise<HostConnection | undefined>
  resolve(connection: HostConnection): Promise<HostCredential | undefined>
}

const oauth = (credential: HostCredential | undefined): HostCredential | undefined => (credential?.type === "oauth" ? credential : undefined)

/** One attempt, or undefined when the account has no active credential. */
async function attempt(store: HostCredentialStore, integrationID: string): Promise<HostCredential | undefined> {
  const connection = await store.active(integrationID)
  if (!connection) return undefined
  return oauth(await store.resolve(connection))
}

/**
 * The stored credential for `alias`. A failed first read is retried once, for a rotation another process just finished.
 * Throws AUTH_REQUIRED when both reads fail, and CANCELLED when the call was stopped.
 */
export async function readHostCredential(store: HostCredentialStore, alias: string, signal: AbortSignal): Promise<HostCredential | undefined> {
  if (signal.aborted) throw new DatabricksError("CANCELLED", "The call was stopped.")
  const integrationID = integrationIdFor(alias)
  let first: unknown
  try {
    const credential = await attempt(store, integrationID)
    if (credential) return credential
  } catch (error) {
    first = error
  }
  if (first === undefined) return undefined
  if (signal.aborted) throw new DatabricksError("CANCELLED", "The call was stopped.")
  try {
    return await attempt(store, integrationID)
  } catch {
    if (first instanceof DatabricksError) throw first
    throw new DatabricksError(
      "AUTH_REQUIRED",
      `The stored Databricks sign-in for ${alias} could not be renewed, in this process or another.`,
      `Run /connect and choose Databricks, or run opencode auth login databricks-${alias}.`,
    )
  }
}
