/**
 * Renewing an interactive sign-in (design §3.2, §3.4, review M3).
 *
 * Databricks' partner guide's refresh request is `POST <workspace>/oidc/v1/token` with
 * `grant_type=refresh_token&refresh_token=…&client_id=…`, and its answer carries the next access token and refresh token.
 * A public app connection sends no secret [11][12], and the refresh carries no `assume_group`: the role was bound when
 * the refresh token was issued, which is live check L3's "a refresh without assume_group stays the role".
 *
 * Single-use refresh tokens (Beta, `enable_single_use_refresh_tokens` [12]) invalidate the old token on each refresh, so
 * two refreshes of the same sign-in would sign each other out. Within this process, refreshes of one account are
 * serialized and a caller that arrives with a token we have already rotated receives the newest credential without a
 * request. Across processes, the credential store is the host's: OpenCode writes the credential this callback returns,
 * and a second process reads that stored copy before it renews. This module never holds a refresh token of its own
 * outside the callback's return value.
 *
 * Jelly's copy of a sign-in for an agent carries `jelly-host-owns-refresh` in place of the refresh token; the host
 * renews it, so this module refuses without a network call.
 */
import { DatabricksError } from "../domain/errors.js"
import { isHostOwnedRefresh, readSignIn, signInMetadata } from "./credential.js"
import { requestToken } from "./token.js"
import type { HostCredential } from "./types.js"

export interface RefreshState {
  /** The newest credential this process has seen per account: a rotation the host has not stored back yet. */
  readonly latest: Map<string, HostCredential>
  /** One chain per account, so two refreshes never race on a single-use token. */
  readonly chains: Map<string, Promise<HostCredential>>
}

export const refreshState = (): RefreshState => ({ latest: new Map(), chains: new Map() })

export interface RefreshInput {
  readonly alias: string
  readonly name: string
  readonly credential: HostCredential
  readonly fetch: typeof globalThis.fetch
  readonly now: () => number
  readonly signal?: AbortSignal
  readonly state: RefreshState
  /** Tests point this at a local endpoint; production leaves it to the workspace. */
  readonly tokenEndpoint?: string
}

const cannotRenew = (alias: string, name: string, what: string) =>
  new DatabricksError("AUTH_REQUIRED", `${what} for ${alias}, so it cannot be renewed.`, `Run /connect and choose ${name}, and sign in again.`)

export async function refreshSignIn(input: RefreshInput): Promise<HostCredential> {
  const { alias, name, credential, state } = input
  if (isHostOwnedRefresh(credential)) {
    throw new DatabricksError("AUTH_REQUIRED", `The Databricks sign-in for ${alias} is renewed by the host, not by this plugin.`, `Wait for the host to refresh it, or run /connect and choose ${name} to sign in again.`)
  }
  const stored = readSignIn(credential.metadata)
  if (!stored) throw cannotRenew(alias, name, "The stored sign-in has no workspace record")
  if (!credential.refresh) throw cannotRenew(alias, name, "The stored sign-in has no refresh token")

  const run = async (): Promise<HostCredential> => {
    // A caller that waited behind another refresh has the rotated credential, not the one it arrived with.
    const latest = state.latest.get(alias)
    if (latest && latest.refresh !== credential.refresh) return latest
    const token = await requestToken({
      endpoint: input.tokenEndpoint ?? `${stored.host}/oidc/v1/token`,
      form: {
        grant_type: "refresh_token",
        refresh_token: credential.refresh,
        client_id: stored.clientId,
      },
      fetch: input.fetch,
      signal: input.signal ?? new AbortController().signal,
    })
    const metadata = signInMetadata({
      host: stored.host,
      clientId: stored.clientId,
      scopes: stored.scopes,
      requestedScopes: stored.requestedScopes,
      grantedScopes: token.scopes ?? stored.grantedScopes,
      ...(stored.roleGroupId !== undefined ? { roleGroupId: stored.roleGroupId } : {}),
    })
    const renewed: HostCredential = {
      ...credential,
      refresh: token.refreshToken ?? credential.refresh,
      access: token.accessToken,
      expires: Math.floor(input.now() + token.expiresIn * 1000),
      metadata,
    }
    state.latest.set(alias, renewed)
    return renewed
  }

  const prior = state.chains.get(alias)
  const chained = prior ? prior.catch(() => undefined).then(run) : run()
  state.chains.set(alias, chained)
  try {
    return await chained
  } finally {
    if (state.chains.get(alias) === chained) state.chains.delete(alias)
  }
}
