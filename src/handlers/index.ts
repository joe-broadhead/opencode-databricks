/**
 * The one handler table the contract's register wires through doors 1–3. Each entry is one method the manifest declares:
 * the input schema without the account selector, the answer schema, and the work. The register adds the account, asks
 * the permission, mints a planId and checks every answer.
 */
import * as z from "zod"
import { EVENTS_LIST_INPUT_SCHEMA, LIST_OPTIONS_SCHEMA, PAGE_SCHEMA, PROBE_SCHEMA, errorCodeOf, type ErrorCode } from "@we-the-rebel-alliance/plugin-contract/events"
import { STATUS_SCHEMA } from "@we-the-rebel-alliance/plugin-contract/accounts"
import { refusal, RegisterError, type MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import type { Manifest } from "@we-the-rebel-alliance/plugin-contract/manifest"
import { DatabricksError } from "../domain/errors.js"
import { methodOf, type MethodName } from "../methods.js"
import type { Deps } from "./deps.js"
import { Inputs, Outputs } from "./schemas.js"
import type { Call, Handler } from "./types.js"
import { READ_HANDLERS } from "./reads/index.js"
import { CHANGE_HANDLERS } from "./changes/index.js"
import save from "./save/index.js"
import { SOURCE_HANDLERS, probe, savedList } from "./sources/index.js"
import { createStatusHandler } from "./status.js"

export interface HandlerParts {
  readonly deps: Deps
  readonly manifest: Manifest
  readonly version: string
  readonly hostVersion: string
  readonly accountProblems: readonly string[]
}

/** The contract code a plugin code maps to (contract §12). */
function contractCode(code: string): ErrorCode {
  switch (code) {
    case "AUTH_REQUIRED":
    case "AUTH_CLIENT_INVALID":
      return "NEEDS_SIGN_IN"
    case "AUTH_SCOPE_MISSING":
      return "SCOPE_MISSING"
    case "BUDGET_REACHED":
      return "BUDGET_EXCEEDED"
    case "RATE_LIMITED":
      return "RATE_LIMITED"
    case "PERMISSION_DENIED":
    case "FENCED":
    case "INLINE_WITHHELD":
    case "SECRET_FUNCTION_REFUSED":
    case "ADMIN_DISABLED":
      return "PERMISSION_DENIED"
    case "TOO_LARGE":
    case "SAVE_LIMIT":
      return "TOO_LARGE"
    case "PLAN_NOT_FOUND":
    case "PLAN_ALREADY_USED":
    case "PLAN_EXPIRED":
    case "PLAN_CALLER_MISMATCH":
    case "PLAN_CHANGED":
    case "CATEGORY_MISMATCH":
      return "PLAN_INVALID"
    case "HOST_UNTESTED":
      return "HOST_UNTESTED"
    case "OPTIONS_INVALID":
      return "OPTIONS_INVALID"
    case "INPUT_INVALID":
    case "WAREHOUSE_REQUIRED":
    case "WAREHOUSE_STOPPED":
    case "START_REFUSED":
    case "RUN_SIZE_REFUSED":
    case "WAREHOUSE_FORBIDDEN":
    case "STOP_NOT_PERMITTED":
    case "NOT_FOUND":
    case "SQL_INVALID":
    case "STATEMENT_NOT_READ":
    case "SQL_UNSUPPORTED":
    case "IDENTIFIER_REFUSED":
    case "SESSION_STATEMENT_REFUSED":
    case "PATH_NOT_DEFAULT":
    case "NEEDS_PLAN":
    case "FUNCTION_NAME_PARTIAL":
    case "FUNCTION_REFUSED":
    case "DEPENDENCIES_UNKNOWN":
    case "FENCE_UNVERIFIABLE":
    case "STATEMENT_UNKNOWN":
    case "ADMIN_REASON_REQUIRED":
    case "SAVE_PATH_REFUSED":
    case "SAVE_EXISTS":
    case "EXTERNAL_LINK_REFUSED":
    case "STATEMENT_FAILED":
    case "RUN_TIMEOUT":
    case "RESULTS_EXPIRED":
      return "INPUT_INVALID"
    default:
      return "UNAVAILABLE"
  }
}

/** A handler's failure as the contract's refusal; a `RegisterError` passes through unchanged. */
function toRegisterError(error: unknown): RegisterError {
  if (error instanceof RegisterError) return error
  if (error instanceof DatabricksError) {
    return new RegisterError(refusal(contractCode(error.code), error.detail, error.nextStep))
  }
  const held = error as { code?: unknown; what?: unknown; next?: unknown; message?: unknown } | undefined
  if (held && typeof held.code === "string" && typeof held.what === "string" && typeof held.next === "string") {
    return new RegisterError(refusal(errorCodeOf(held.code) ?? "UNAVAILABLE", held.what, held.next))
  }
  const reason = error instanceof Error ? error.message.split("\n", 1)[0] ?? "unknown error" : String(error)
  return new RegisterError(refusal("UNAVAILABLE", reason.slice(0, 300), "Try again; if it keeps failing, check the plugin's status."))
}

function jsonSchema(schema: z.ZodType, io: "input" | "output"): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { target: "draft-2020-12", io, unrepresentable: "any" }) as Record<string, unknown>
  delete generated["$schema"]
  return generated
}

const PLAN_METHODS = new Set<MethodName>(["plan_write", "plan_delete", "plan_share", "plan_export", "plan_run", "plan_admin"])

function inputSchema(name: MethodName): Record<string, unknown> {
  if (name === "events_list") return EVENTS_LIST_INPUT_SCHEMA as unknown as Record<string, unknown>
  const entry = methodOf(name)
  const schema = entry.commits === undefined ? (Inputs[name] as z.ZodObject).omit({ account: true }) : Inputs[name]
  return jsonSchema(schema, "input")
}

function outputSchema(name: MethodName): Record<string, unknown> {
  if (name === "status") return STATUS_SCHEMA as unknown as Record<string, unknown>
  if (name === "probe") return PROBE_SCHEMA as unknown as Record<string, unknown>
  if (name === "events_list") return PAGE_SCHEMA as unknown as Record<string, unknown>
  if (name === "saved_list") return LIST_OPTIONS_SCHEMA as unknown as Record<string, unknown>
  if (PLAN_METHODS.has(name)) return { type: "object", additionalProperties: true }
  return jsonSchema(Outputs[name], "output")
}

/** The source a write nudges: a job or notebook run is the runs source; every other provider write is SQL history. */
function capabilityFor(name: MethodName, plan: unknown): string {
  if (name === "run") {
    const stored = plan as { plan?: { payload?: { kind?: unknown } } } | undefined
    const kind = stored?.plan?.payload?.kind
    return kind === "job" || kind === "notebook" ? "databricks.runs" : "databricks.queries"
  }
  return "databricks.queries"
}

/** The methods whose success is a provider write, and therefore a `changed` nudge. `save` writes a local file only. */
const WRITES = new Set<MethodName>(["write", "delete", "share", "export", "run", "admin", "cancel", "start", "stop"])

/** One declared method's handler, with the account added after the register checked the input. */
function wrap(name: MethodName, handler: Handler<MethodName>, deps: Deps): MethodHandler {
  const entry = methodOf(name)
  return {
    description: entry.description,
    input: inputSchema(name),
    output: outputSchema(name),
    async run(raw, call) {
      const withAccount = entry.commits === undefined && entry.accounts === "optional" ? { ...(raw as Record<string, unknown>), account: call.account } : (raw as Record<string, unknown>)
      const parsed = Inputs[name].safeParse(withAccount)
      if (!parsed.success) {
        throw new RegisterError(refusal("INPUT_INVALID", `The input does not fit ${name}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}`, "Pass only the input the method describes."))
      }
      const inner: Call = {
        sessionID: call.sessionID,
        agent: call.agent,
        messageID: call.messageID,
        id: call.id,
        signal: call.signal,
        account: call.account,
        ...(call.plan === undefined ? {} : { plan: call.plan }),
        bus: call.bus,
      }
      try {
        const answer = await handler(parsed.data as never, inner, deps)
        if (WRITES.has(name)) {
          await call.bus.emit("changed", { capability: capabilityFor(name, call.plan), account: call.account, reason: "write" }).catch(() => undefined)
        }
        return answer
      } catch (error) {
        throw toRegisterError(error)
      }
    },
  }
}

/** The handler table, from the manifest's method list. */
export function createHandlers(parts: HandlerParts): Readonly<Record<string, MethodHandler>> {
  const { deps, manifest, version, hostVersion, accountProblems } = parts
  const base: Partial<Record<MethodName, Handler<MethodName>>> = {
    ...READ_HANDLERS,
    ...CHANGE_HANDLERS,
    save,
    ...SOURCE_HANDLERS,
    probe,
    saved_list: savedList,
  }
  const table: Record<string, MethodHandler> = {}
  for (const name of Object.keys(manifest.methods)) {
    if (name.startsWith("mcp:")) continue
    const method = name as MethodName
    if (method === "status") {
      table.status = createStatusHandler({ manifest, version, hostVersion, deps, accountProblems })
      continue
    }
    const handler = base[method]
    if (handler === undefined) throw new Error(`databricks has no handler for ${method}`)
    table[method] = wrap(method, handler, deps)
  }
  return table
}
