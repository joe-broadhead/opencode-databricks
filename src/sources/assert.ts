/**
 * What a source read asserts, before its first provider call (source-contract L1, `permission`'s `operationRule`):
 *
 * 1. its method's action on `*` (`databricks.events_list`, `databricks.saved_read`, `databricks.probe`,
 *    `databricks.saved_list`), the rule the tools RPC resolves a method on;
 * 2. then each operation it may call as the contract derives it: a dotted operation is `databricks.read` on
 *    `<account>:<operation>`.
 *
 * That is exactly what a consumer's fenced session holds (`sessionRules`, `probeRules`, the bind rules), so a person's
 * off switch for one operation is consulted, and the conformance kit runs under the grants the declaration derives,
 * not ones a test wrote. The rule is the contract's own `operationRule`, imported rather than restated.
 *
 * The **model's own tools** (`databricks_events_list`, `databricks_saved_read`) keep the family's rule instead
 * (`assertTool`, `src/registry.ts`): the tool's dotted action on `<account>:<operation>`, for each operation. Asserting
 * `databricks.read` there needs it declared as a permission-only Jelly tool first (the review's request 3, a Day 0
 * change), or OpenCode's namespace pattern would ask for or deny it.
 */
import { operationRule } from "@we-the-rebel-alliance/source-contract/permission"
import type { PermissionPort } from "../ports.js"
import type { Call } from "../tool-spec.js"

/** The permission port a source read uses; the conformance kit's recording permission fits it. */
export type SourceAssert = Pick<PermissionPort, "assert">

/** The operation grant a consumer's source session holds for a dotted operation. */
export const READ_ACTION = "databricks.read"

/** The source every derivation names: the namespace is its id's first segment, and every account is named. */
const SOURCE = { id: "databricks.sources", accounts: { named: true } } as const

/** The method's action on `*`, then `databricks.read` on `<account>:<operation>` for each operation, in order. */
export async function assertSourceRead(permission: SourceAssert, call: Call, action: string, operations: readonly string[], account: string): Promise<void> {
  await permission.assert({ action, resource: "*", sessionID: call.sessionID, messageID: call.messageID, callID: call.id }, call.signal)
  for (const operation of operations) await assertOperationRead(permission, call, operation, account)
}

/** The contract's operation grant alone: `databricks.read` on `<account>:<operation>`. */
export async function assertOperationRead(permission: SourceAssert, call: Call, operation: string, account: string): Promise<void> {
  const rule = operationRule(SOURCE as never, operation, account)
  await permission.assert({ action: rule.action, resource: rule.resource, sessionID: call.sessionID, messageID: call.messageID, callID: call.id }, call.signal)
}

/** `probe`'s and `saved_list`'s asserts: the same rule, for their one operation. */
export async function assertOperation(permission: SourceAssert, call: Call, action: string, operation: string, account: string): Promise<void> {
  await assertSourceRead(permission, call, action, [operation], account)
}

/** Who is reading: a consumer's source session (the contract's rules), or the model's own tool (the family's rule). */
export type ReadMode = "source" | "tool"

/** The model tool's asserts: its own action on `<account>:<operation>`, for each operation, the first one first. */
export async function assertToolRead(permission: SourceAssert, call: Call, action: string, operations: readonly string[], account: string): Promise<void> {
  for (const operation of operations) {
    await permission.assert({ action, resource: `${account}:${operation}`, sessionID: call.sessionID, messageID: call.messageID, callID: call.id }, call.signal)
  }
}

/** The asserts for `mode`, before a read's first provider call. */
export async function assertRead(mode: ReadMode, permission: SourceAssert, call: Call, action: string, operations: readonly string[], account: string): Promise<void> {
  if (mode === "tool") await assertToolRead(permission, call, action, operations, account)
  else await assertSourceRead(permission, call, action, operations, account)
}
