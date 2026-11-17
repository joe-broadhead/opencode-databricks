/**
 * One spec per tool, in opencode-gws's pattern: a spec feeds both the model's tool (`buildTool`) and the scripts'
 * tools RPC method (`scriptMethod`), so the two cannot drift apart. A tool validates its input with its zod schema
 * (src/domain/contract.ts), runs its handler, and returns `{ output, content, metadata }`. A plugin error is returned as
 * a result with `state`, `error`, `message` and `next` (the family form), never thrown at the model.
 */
import type { JsonSchema, MethodClass, PluginMethod } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import * as z from "zod"
import { NAMESPACE } from "./constants.js"
import { actionOf, type ToolName, TOOLS } from "./domain/actions.js"
import { Inputs, Outputs } from "./domain/contract.js"
import { DatabricksError } from "./domain/errors.js"
import type { Deps } from "./registry.js"

/** Inline cap for a direct call's text, in bytes. */
export const MAX_INLINE_BYTES = 32 * 1024

/** The call a spec runs for, from the model's tool context or a script's RPC call. */
export interface Call {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  readonly signal: AbortSignal
}

export type Handler<T extends ToolName> = (input: z.output<(typeof Inputs)[T]>, call: Call, deps: Deps) => Promise<z.output<(typeof Outputs)[T]>>

export type Handlers = { readonly [T in ToolName]: Handler<T> }

/** An error as the tool's result: the family form, Databricks' text only in providerError. */
export function errorResult(error: DatabricksError): Record<string, unknown> {
  return {
    state: error.state,
    error: error.code,
    message: error.detail,
    next: error.nextStep,
    ...(error.providerError ? { providerError: error.providerError } : {}),
    ...(error.retryAfterSec !== undefined ? { retryAfterSec: error.retryAfterSec } : {}),
  }
}

function parse(tool: ToolName, input: unknown): unknown {
  const result = Inputs[tool].safeParse(input)
  if (result.success) return result.data
  throw new DatabricksError("INPUT_INVALID", `The input does not fit databricks_${tool}: ${result.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}.`)
}

/** Runs one tool: parse, handle, and turn the plugin's own errors into results. Anything else is a bug and throws. */
export async function runTool(tool: ToolName, input: unknown, call: Call, deps: Deps, handlers: Handlers): Promise<Record<string, unknown>> {
  try {
    const parsed = parse(tool, input)
    return (await (handlers[tool] as Handler<ToolName>)(parsed as never, call, deps)) as Record<string, unknown>
  } catch (error) {
    if (error instanceof DatabricksError) return errorResult(error)
    if (call.signal.aborted) return errorResult(new DatabricksError("CANCELLED"))
    throw error
  }
}

/** Compact JSON for a direct call, cut at the inline cap. */
export function render(output: unknown, maxBytes = MAX_INLINE_BYTES): string {
  const text = JSON.stringify(output) ?? ""
  if (Buffer.byteLength(text) <= maxBytes) return text
  return `${Buffer.from(text).subarray(0, maxBytes).toString("utf8")}\n…[cut at ${maxBytes} bytes; use databricks_save for the full result]`
}

/** The model's tool, for `ctx.tool.transform`'s `editor.add`. */
export function buildTool(tool: ToolName, deps: () => Deps, handlers: Handlers) {
  const entry = TOOLS.find((item) => item.name === tool)!
  return {
    name: tool,
    description: entry.description,
    input: Inputs[tool],
    output: Outputs[tool],
    options: { namespace: NAMESPACE, permission: actionOf(tool), codemode: true },
    execute: async (raw: unknown, context: Call) => {
      const output = await runTool(tool, raw, context, deps(), handlers)
      return { output, content: render(output), metadata: { ...(typeof output.error === "string" ? { code: output.error } : {}) } }
    },
  }
}

const methodClass = (tool: ToolName): MethodClass => {
  const entry = TOOLS.find((item) => item.name === tool)!
  return entry.class === "read" ? "read" : entry.class === "export" ? "export" : entry.class === "destructive" ? "destructive" : "write"
}

function schemaOf(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  try {
    return z.toJSONSchema(schema, { io, unrepresentable: "any" }) as JsonSchema
  } catch {
    return { type: "object" }
  }
}

/** A read tool as a tools RPC method: the same input check, the same run. */
export function scriptMethod(tool: ToolName, deps: () => Deps, handlers: Handlers): PluginMethod {
  const entry = TOOLS.find((item) => item.name === tool)!
  return {
    kind: "plugin",
    name: tool,
    action: actionOf(tool),
    class: methodClass(tool),
    description: entry.description,
    input: schemaOf(Inputs[tool], "input"),
    output: schemaOf(Outputs[tool], "output"),
    run: async (input, call) => runTool(tool, input, call, deps(), handlers),
  }
}
