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
import { RPC_METHODS, type ToolName, TOOLS } from "./domain/actions.js"
import { DatabricksError } from "./domain/errors.js"
import type { Deps } from "./registry.js"
import { type Handlers, scriptMethod } from "./tool-spec.js"
import { sourceMethods } from "./sources/index.js"

/** The RPC's id: the plugin's id and `.tools`. Scripts call it by name, so it never changes. */
export const TOOLS_RPC_ID = toolsRpcId(PLUGIN_ID)

/**
 * The methods: every read tool from its spec, then package E's source methods (`events_list`, `saved_read`, `probe`,
 * `saved_list`), which answer the source contract's page and snapshot and throw its `SourceError`. `events_list` and
 * `saved_read` are replaced there rather than built by `scriptMethod`, because the contract's page (with `source`,
 * `account`, `owner`, `more`) is not the model tool's result shape.
 */
export function methods(deps: () => Deps, handlers: Handlers): PluginMethod[] {
  const fromSources = new Set(["events_list", "saved_read"])
  const tools = TOOLS.filter((tool) => tool.rpc && !fromSources.has(tool.name)).map((tool) => scriptMethod(tool.name as ToolName, deps, handlers))
  return [...tools, ...sourceMethods(deps)]
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
