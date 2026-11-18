/**
 * What a source read asserts, before its first provider call: its own method action on `*`, then the operation it uses
 * on `<account>:<operation>` under that same action. The family's shape (`assertTool` in `src/registry.ts`) and the
 * plugin's declaration: `databricks.events_list` and `databricks.saved_read` are the actions, and the resources name the
 * operations (design §10.1: "source reads skip the table assert, because a source session allows only its declared
 * operations").
 *
 * `probe` and `saved_list` are tools-RPC methods, never model tools: they assert `databricks.probe` / `databricks.saved_list`
 * and the source contract's operation grant (`databricks.read`), which is the rule a consumer's fenced session holds
 * (`probeRules`, `bindGrantsFor`). They never run in an agent's session, so no model tool grows an undeclared action.
 */
import type { PermissionPort } from "../ports.js"
import type { Call } from "../tool-spec.js"

/** The permission port a source read uses; the conformance kit's recording permission fits it. */
export type SourceAssert = Pick<PermissionPort, "assert">

/** The operation grant a consumer's source session holds for a dotted operation (`databricks.read`). */
export const READ_ACTION = "databricks.read"

export async function assertSourceRead(permission: SourceAssert, call: Call, action: string, operations: readonly string[], account: string): Promise<void> {
  for (const operation of operations) {
    await permission.assert({ action, resource: `${account}:${operation}`, sessionID: call.sessionID, messageID: call.messageID, callID: call.id }, call.signal)
  }
}

/** `probe`'s and `saved_list`'s asserts: the method's action, then the contract's operation grant. */
export async function assertOperation(permission: SourceAssert, call: Call, action: string, operation: string, account: string): Promise<void> {
  await permission.assert({ action, resource: "*", sessionID: call.sessionID, messageID: call.messageID, callID: call.id }, call.signal)
  await permission.assert({ action: READ_ACTION, resource: `${account}:${operation}`, sessionID: call.sessionID, messageID: call.messageID, callID: call.id }, call.signal)
}
