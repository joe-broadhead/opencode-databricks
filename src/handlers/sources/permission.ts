/**
 * The 4a source-read gate that v0 has no permission-only action for: the contract already asserts each method's own
 * action, and this assert keeps an old `databricks.read` allow/ask/deny rule in force on every declared operation.
 */
import { DatabricksError } from "../../domain/errors.js"
import { methodOf, type MethodName } from "../../methods.js"
import type { Deps } from "../deps.js"
import type { Call } from "../types.js"

/** The four methods 4a covered with `databricks.read`: method action on `*`, then read on each operation. */
export type ReadMethod = "events_list" | "saved_read" | "probe" | "saved_list"

/** Assert `databricks.read` on `<account>:<operation>` for every operation the method declares, before any provider call. */
export async function assertReadOperations(deps: Deps, call: Call, method: ReadMethod, account: string): Promise<void> {
  for (const operation of methodOf(method as MethodName).operations) {
    const resource = `${account}:${operation}`
    try {
      await deps.permission.assert({
        sessionID: call.sessionID,
        action: "databricks.read",
        resources: [resource],
        ...(call.messageID && call.id ? { source: { type: "tool" as const, messageID: call.messageID, id: call.id } } : {}),
      })
    } catch {
      if (call.signal.aborted) throw new DatabricksError("CANCELLED", "The call was stopped.")
      throw new DatabricksError(
        "PERMISSION_DENIED",
        `The source read was refused: databricks.read on ${resource}.`,
        "Allow databricks.read for this operation, or change the rule that denied it.",
      )
    }
  }
}
