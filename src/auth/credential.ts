/**
 * What a Databricks sign-in stores in OpenCode's credential `metadata`, next to the tokens (design §3.1, §3.4).
 *
 * The host owns the credential store; this record is what makes one stored credential mean one workspace, one scope
 * grant and one role. It holds no secret: the client ID is public by Databricks' own rule for a public app connection
 * [11][12], and the role is a group ID. The tokens themselves stay in the credential's own fields, which the host
 * refreshes through the callback this package registers.
 *
 * Two fields are security-relevant:
 * - `host`: the workspace the token was minted for. A later change of `accounts.<alias>.host` cannot redirect it,
 *   because the token call compares them and answers `AUTH_REQUIRED` on a difference.
 * - `roleGroupId`: the group the token was issued as, passed at authorize as `assume_group=<group-id>` [9][13]. A later
 *   change of `accounts.<alias>.role` cannot change the identity an agent runs as: the mismatch is `AUTH_REQUIRED`
 *   until the person signs in again.
 */
import * as z from "zod"

/** The family's sentinel for a sign-in Jelly holds the refresh token for: this plugin must never renew it (gws). */
export const HOST_OWNED_REFRESH = "jelly-host-owns-refresh"

const SignIn = z.object({
  version: z.literal(1),
  host: z.string().min(1).max(2048),
  clientId: z.string().min(1).max(256),
  scopes: z.enum(["fine", "all-apis"]),
  requestedScopes: z.array(z.string().min(1).max(64)).max(32),
  grantedScopes: z.array(z.string().min(1).max(64)).max(64),
  roleGroupId: z.string().regex(/^\d{1,40}$/u).optional(),
})

export type SignIn = z.output<typeof SignIn>

export interface SignInInput {
  readonly host: string
  readonly clientId: string
  readonly scopes: SignIn["scopes"]
  readonly requestedScopes: readonly string[]
  readonly grantedScopes: readonly string[]
  readonly roleGroupId?: string
}

/** The metadata a completed sign-in leaves, in the shape this module reads back. */
export function signInMetadata(input: SignInInput): Record<string, unknown> {
  const record: SignIn = {
    version: 1,
    host: input.host,
    clientId: input.clientId,
    scopes: input.scopes,
    requestedScopes: [...input.requestedScopes],
    grantedScopes: [...input.grantedScopes],
    ...(input.roleGroupId !== undefined ? { roleGroupId: input.roleGroupId } : {}),
  }
  return record
}

/** The stored record, or undefined when the metadata is missing or malformed (then the sign-in is unusable). */
export function readSignIn(metadata: Readonly<Record<string, unknown>> | undefined): SignIn | undefined {
  const parsed = SignIn.safeParse(metadata)
  return parsed.success ? parsed.data : undefined
}

/** True when the credential is Jelly's copy for an agent: the host renews it, so this plugin must not. */
export function isHostOwnedRefresh(credential: { readonly refresh?: string }): boolean {
  return credential.refresh === HOST_OWNED_REFRESH
}

/** The role a stored sign-in was bound to, as `AccountInfo.role`. */
export function boundRole(stored: SignIn | undefined): { readonly groupId: string } | undefined {
  return stored?.roleGroupId !== undefined ? { groupId: stored.roleGroupId } : undefined
}
