/**
 * Renewing an interactive sign-in (design §3.2, §3.4; review M1, M4).
 *
 * Databricks' partner guide's refresh request is `POST <workspace>/oidc/v1/token` with
 * `grant_type=refresh_token&refresh_token=…&client_id=…`, and its answer carries the next access token and refresh token.
 * A public app connection sends no secret [11][12], and the refresh carries no `assume_group`: the role was bound when
 * the refresh token was issued, which is live check L3's "a refresh without assume_group stays the role".
 *
 * **One sign-in, never an older one (review M1).** Each sign-in records a `generation` (the millisecond it was made) and
 * its binding (host, client ID, role group) in the credential's metadata. In memory this process keeps the newest
 * credential it has seen per account, and which refresh token it replaced:
 * - a caller that brings the token this process just consumed gets the newest credential back, without a request;
 * - a caller whose sign-in is older than the newest one gets the newest one back, never the older identity;
 * - anything else is renewed, and becomes the newest.
 * So a rotation in this process or another can never silently restore an older sign-in, drop a role, or switch a
 * workspace back.
 *
 * Single-use refresh tokens (Beta, `enable_single_use_refresh_tokens` [12]) invalidate the old token on each refresh.
 * Within this process, refreshes of one account are serialized, so two callers never race; across processes the
 * credential store is the host's (M4: see `docs/auth.md` Known limits).
 */
import { DatabricksError } from "../domain/errors.js"
import { readSignIn, signInMetadata, type SignIn } from "./credential.js"
import { parseWorkspaceHost } from "./host.js"
import { requestToken } from "./token.js"
import type { HostCredential } from "./types.js"

export interface LatestCredential {
  readonly credential: HostCredential
  /** The millisecond the sign-in that owns this credential was made; larger is newer. */
  readonly generation: number
  /** The refresh token this credential replaced, when it came from a rotation. */
  readonly rotatedFrom?: string
}

export interface RefreshState {
  /** The newest credential this process has seen per account, with what it replaced. */
  readonly latest: Map<string, LatestCredential>
  /** One chain per account, so two refreshes never race on a single-use token. */
  readonly chains: Map<string, Promise<HostCredential>>
}

export const refreshState = (): RefreshState => ({ latest: new Map(), chains: new Map() })

/** The sign-in generation of a credential; 0 for a record made before generations existed. */
export const generationOf = (credential: HostCredential): number => readSignIn(credential.metadata)?.generation ?? 0

/** What makes two credentials the same sign-in: the workspace, the client and the bound role. */
function bindingOf(credential: HostCredential): string | undefined {
  const stored = readSignIn(credential.metadata)
  return stored ? `${stored.host}\u0000${stored.clientId}\u0000${stored.roleGroupId ?? ""}` : undefined
}

export const sameSignIn = (left: HostCredential, right: HostCredential): boolean => {
  const binding = bindingOf(left)
  return binding !== undefined && binding === bindingOf(right)
}

export interface RefreshInput {
  readonly alias: string
  readonly name: string
  readonly credential: HostCredential
  readonly fetch: typeof globalThis.fetch
  readonly now: () => number
  readonly allowCustomHost?: boolean
  readonly signal?: AbortSignal
  readonly state: RefreshState
  /** Tests point this at a local endpoint; production leaves it to the workspace. */
  readonly tokenEndpoint?: string
}

const cannotRenew = (alias: string, name: string, what: string) =>
  new DatabricksError("AUTH_REQUIRED", `${what} for ${alias}, so it cannot be renewed.`, `Run /connect and choose ${name}, and sign in again.`)

export async function refreshSignIn(input: RefreshInput): Promise<HostCredential> {
  const { alias, name, credential, state } = input
  const stored: SignIn | undefined = readSignIn(credential.metadata)
  if (!stored) throw cannotRenew(alias, name, "The stored sign-in has no workspace record")
  if (!credential.refresh) throw cannotRenew(alias, name, "The stored sign-in has no refresh token")
  // The endpoint comes from the stored workspace, validated again here: a refresh must never post a token to a host
  // this plugin would not accept from the options (review LOW 3).
  const host = parseWorkspaceHost(stored.host, input.allowCustomHost ?? false).host
  const generation = stored.generation ?? 0

  const run = async (): Promise<HostCredential> => {
    const latest = state.latest.get(alias)
    if (latest) {
      // The caller brings the token this process consumed: it gets the rotation's answer without another request.
      if (latest.rotatedFrom === credential.refresh && latest.generation === generation && sameSignIn(latest.credential, credential)) return latest.credential
      // A newer sign-in exists: an older one is never restored over it.
      if (latest.generation > generation) return latest.credential
    }
    const token = await requestToken({
      endpoint: input.tokenEndpoint ?? `${host}/oidc/v1/token`,
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
      ...(stored.generation !== undefined ? { generation: stored.generation } : {}),
    })
    const renewed: HostCredential = {
      ...credential,
      refresh: token.refreshToken ?? credential.refresh,
      access: token.accessToken,
      expires: Math.floor(input.now() + token.expiresIn * 1000),
      metadata,
    }
    state.latest.set(alias, { credential: renewed, generation, rotatedFrom: credential.refresh })
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
