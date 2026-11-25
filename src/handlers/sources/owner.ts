/**
 * Whose a page is (the contract's `owner`): the signed-in identity `GET /api/2.0/preview/scim/v2/Me` [30] returns,
 * with a scheme-qualified id. A user's user name is an address, so the id is `mailto:<userName>`; a service principal
 * has no address, so its id is `databricks:<host>:principal:<id>`.
 *
 * The design's `verified: false` for a principal is **not written**: it is a v0.2.0-only key that a v0.1.x consumer
 * refuses (the source contract's `ownerShapeProblems` accepts only `false` or its absence), and the provider does name
 * the owner it returns. `probe` and the pages name the same owner where the page reads the identity.
 */
import type { Identity } from "../../ports.js"

export interface Owner {
  readonly id: string
  readonly label: string
}

/** The host a scheme-qualified id names: the workspace's host name, without its scheme. */
export const hostName = (host: string): string => {
  try {
    return new URL(host).hostname
  } catch {
    return host.replace(/^https?:\/\//u, "")
  }
}

export function ownerOf(identity: Identity, host: string): Owner {
  const name = hostName(host)
  const label = identity.displayName?.trim() || identity.userName
  return {
    id: identity.userName.includes("@") ? `mailto:${identity.userName}` : `databricks:${name}:principal:${identity.id}`,
    label: label.slice(0, 200),
  }
}

/**
 * The owner of a source that reads a workspace rather than one person's items (`databricks.runs`): its declaration keeps
 * the identity operation in `probe`, so its pages never assert it and name the workspace account instead.
 */
export function workspaceOwner(host: string, account: string): Owner {
  return { id: `databricks:${hostName(host)}:account:${account}`, label: `${account} workspace` }
}
