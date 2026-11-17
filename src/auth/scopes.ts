/**
 * The OAuth scopes: what a sign-in asks for, and what a call needs (design §3.3).
 *
 * Databricks scopes are per API family, never per read and write, so they never make a token read-only [8]. What they
 * do is make whole families unavailable: an account signed in without `jobs` can never run a job, whatever the plugin
 * does. The plugin asks for the base families every read needs, plus one scope per configured feature, or for
 * `all-apis` when the app was made in the account console with All APIs [11][12].
 *
 * The check before a call is the other half: `missingScopes` runs in the auth port, before package B's fetch exists, so
 * a call whose family was not granted answers `AUTH_SCOPE_MISSING` without touching Databricks.
 */
import type { Feature } from "../domain/actions.js"

/** The scopes every sign-in requests: the three API families the reads use, and the identity claims [8][9][30]. */
export const BASE_SCOPES: readonly string[] = ["sql", "unity-catalog", "query-history", "openid", "email", "profile", "offline_access"]

/** One API family per feature, in the order the sheet lists them (design §3.3). */
export const FEATURE_SCOPES: Readonly<Record<Feature, string>> = { jobs: "jobs", workspace: "workspace", files: "files" }

/** The sign-in form's choice: fine-grained scopes, or the one scope an All APIs app allows. */
export type ScopeChoice = "fine" | "all-apis"

export const SCOPE_CHOICES: readonly ScopeChoice[] = ["fine", "all-apis"]

/**
 * What a sign-in with this choice requests. `all-apis` is requested with `offline_access`, as Databricks' U2M example
 * does, so the sign-in can refresh [9]. Features are deduplicated and always come in the sheet's order.
 */
export function requestedScopes(features: readonly Feature[], choice: ScopeChoice): string[] {
  if (choice === "all-apis") return ["all-apis", "offline_access"]
  const selected = Object.keys(FEATURE_SCOPES).filter((feature): feature is Feature => features.includes(feature as Feature))
  return [...BASE_SCOPES, ...selected.map((feature) => FEATURE_SCOPES[feature])]
}

/** The API families a call needs, without the identity claims a sign-in also requests. */
export function apiScopes(features: readonly Feature[]): string[] {
  return requestedScopes(features, "fine").filter((scope) => !["openid", "email", "profile", "offline_access"].includes(scope))
}

/**
 * The scopes a token does not carry, or none. `any` is satisfied by any scoped token (SCIM `Me` [30]); `all-apis`
 * satisfies everything. A scope the sign-in never recorded cannot be proven, so it is missing.
 */
export function missingScopes(granted: readonly string[], needed: readonly string[]): string[] {
  if (granted.includes("all-apis")) return []
  return needed.filter((scope) => scope !== "any" && !granted.includes(scope))
}

/** True when the sign-in is wider than the account's features: status warns `SCOPE_WIDER_THAN_FEATURES` [11]. */
export function widerThanFeatures(granted: readonly string[], features: readonly Feature[]): boolean {
  if (granted.includes("all-apis")) return features.length === 0
  const featureScopes = Object.values(FEATURE_SCOPES)
  return granted.some((scope) => featureScopes.includes(scope) && !features.some((feature) => FEATURE_SCOPES[feature] === scope))
}

/** The feature a missing scope belongs to, when it is one; the next step names it. */
export function featureOfScope(scope: string): Feature | undefined {
  return (Object.keys(FEATURE_SCOPES) as Feature[]).find((feature) => FEATURE_SCOPES[feature] === scope)
}
