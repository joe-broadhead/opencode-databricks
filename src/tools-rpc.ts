/**
 * The tools RPC (`databricks.databricks.tools`), through the source contract's shared module
 * (`@we-the-rebel-alliance/source-contract/tools-rpc`, tag v0.2.0, bundled into dist/index.js):
 *
 *   POST /api/rpc/databricks.databricks.tools/<method>
 *   { "input": { "sessionID": "<session>", "input": <the tool's input> } }
 *
 * Methods: every read tool (from its spec, so the model's tool and the script's method cannot drift), `probe` and
 * `saved_list` (the saved snapshot's `scope.suggest`). The export and change tools are never methods (design §4).
 * A script runs as a session and its agent; the rule for the method's action is resolved before dispatch.
 */
import type { NextSteps, PluginMethod, ToolsRpcPlugin } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { toolsRpcId } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { PLUGIN_ID } from "./constants.js"
import { PROBE_ACTION, RPC_METHODS, type ToolName, TOOLS } from "./domain/actions.js"
import { DatabricksError } from "./domain/errors.js"
import type { Deps } from "./registry.js"
import { type Handlers, scriptMethod } from "./tool-spec.js"

/** The RPC's id: the plugin's id and `.tools`. Scripts call it by name, so it never changes. */
export const TOOLS_RPC_ID = toolsRpcId(PLUGIN_ID)

/** Source methods that are not tools (package E builds them). Day 0: stubs that assert, then NOT_IMPLEMENTED. */
function sourceMethod(name: "probe" | "saved_list", action: string, deps: () => Deps): PluginMethod {
  return {
    kind: "plugin",
    name,
    action,
    class: "read",
    description: name === "probe" ? "Who the account is, for a source's consent: reads no content." : "Your saved SQL queries with their SQL and sha256, for binding the databricks.saved source.",
    input: { type: "object", properties: { account: { type: "string" } }, additionalProperties: false },
    output: { type: "object" },
    run: async (input, call) => {
      const account = (input as { account?: string } | undefined)?.account ?? Object.keys(deps().options.accounts ?? {})[0] ?? "default"
      const operation = name === "probe" ? "scim.me.get" : "sql.queries.list"
      await deps().permission.assert({ action, resource: `${account}:${operation}`, sessionID: call.sessionID, messageID: call.messageID, callID: call.id }, call.signal)
      return { state: "refused", error: "NOT_IMPLEMENTED", message: `${name} is not built yet (package E).`, next: new DatabricksError("NOT_IMPLEMENTED").nextStep }
    },
  }
}

export function methods(deps: () => Deps, handlers: Handlers): PluginMethod[] {
  const tools = TOOLS.filter((tool) => tool.rpc).map((tool) => scriptMethod(tool.name as ToolName, deps, handlers))
  return [...tools, sourceMethod("probe", PROBE_ACTION, deps), sourceMethod("saved_list", "databricks.saved_read", deps)]
}

/** The method names, in the order describe lists them. Equals RPC_METHODS (src/domain/actions.ts). */
export const METHOD_NAMES: readonly string[] = RPC_METHODS

/** The next step for each code. Each is one sentence that ends with a full stop. */
export const NEXT_STEPS: NextSteps = {
  SESSION_UNKNOWN: `Create a session in the location you mean, such as POST /api/session with {"agent":"build"} sent with the header "x-opencode-directory: <dir>" or the location[directory] query, and pass its id.`,
  SESSION_AGENT_REQUIRED: `Create a session that names an agent this project has, with its project as the location, such as POST /api/session with {"agent":"build","location":{"directory":"/path/to/project"}}, and pass its id.`,
  PERMISSION_DENIED: "Add an allow rule for the method's action to the session's agent or to the session, or use a session whose agent allows it.",
  CANCELLED: "Call the method again if you still need the result.",
}

/** The plugin's own errors, thrown by a method, as a code, what happened and the next step. */
export function pluginError(error: unknown): { code: string; what: string; next: string } | undefined {
  return error instanceof DatabricksError ? { code: error.code, what: error.detail.replace(/\.$/u, ""), next: error.nextStep } : undefined
}

export const PLUGIN: ToolsRpcPlugin = { id: PLUGIN_ID, nextSteps: NEXT_STEPS, pluginError }
