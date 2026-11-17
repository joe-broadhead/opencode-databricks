/**
 * The fence (design §5.6): `accounts.<alias>.fence: { allow?, deny? }` over `catalog.schema.table` patterns, checked on
 * every table the read path resolved — the caller's own references, a view's dependencies and a function body's tables.
 *
 * - `deny` wins over `allow`: one matching deny refuses, whatever `allow` says.
 * - With `allow` present, a table that matches none of it is refused too.
 * - A table whose name the plugin could not resolve never reaches this check: the resolver refuses it first, so a fence
 *   can never be bypassed by leaving a name unresolved.
 *
 * It is advisory (design §5.6): it sees what Unity Catalog returned, and the guarantee is still the identity's
 * privileges. A path read (`delta.\`/path\``) cannot be checked at all, so a set fence refuses it (`FENCE_UNVERIFIABLE`)
 * before this runs.
 */
import type { Options } from "../options.js"
import type { Refusal } from "./refusal.js"
import { firstMatch, quoted } from "./pattern.js"

export interface Fence {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
}

export function fenceOf(options: Options, account: string): Fence | undefined {
  const fence = options.accounts?.[account]?.fence
  if (!fence) return undefined
  if (!fence.allow?.length && !fence.deny?.length) return undefined
  return fence
}

/** Whether the account has a fence at all: a view with unknown dependencies is refused when it does. */
export function fenceApplies(options: Options, account: string): boolean {
  return fenceOf(options, account) !== undefined
}

/** The refusal for the first table the fence excludes, or undefined when every table passes. */
export function fenceRefusal(options: Options, account: string, tables: readonly string[]): Refusal | undefined {
  const fence = fenceOf(options, account)
  if (!fence) return undefined
  for (const table of tables) {
    const denied = firstMatch(fence.deny, table)
    if (denied) {
      return {
        code: "FENCED",
        detail: `The table ${quoted(table)} matches the fence's deny pattern ${quoted(denied)}.`,
        next: "Query a table the fence allows, or change the fence option for this account.",
      }
    }
    if (fence.allow?.length && !firstMatch(fence.allow, table)) {
      return {
        code: "FENCED",
        detail: `The table ${quoted(table)} matches none of the fence's allow patterns.`,
        next: "Query a table the fence allows, or add its catalog to the allow list.",
      }
    }
  }
  return undefined
}
