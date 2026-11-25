/**
 * What one handler sees: the call's identity and signal, the resolved account, and the plugin's ports. The contract's
 * `register` owns the doors, the account selector, the input check and the permission gate; these types are only the
 * shape of the work between the register and the provider.
 */
import type * as z from "zod"
import type { Inputs, Outputs } from "./schemas.js"
import type { MethodName } from "../methods.js"
import type { Deps } from "./deps.js"

/** The call a handler runs for, from the register. */
export interface Call {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  readonly signal: AbortSignal
  /** The account alias the register resolved. */
  readonly account: string
  /** A commit's plan: the planning handler's full answer, kept by the register. */
  readonly plan?: unknown
  /** The typed bus writer, always present after the contract's register wiring. */
  readonly bus?: import("@we-the-rebel-alliance/plugin-contract/bus").Bus
}

export type Handler<T extends MethodName> = (input: z.output<(typeof Inputs)[T]>, call: Call, deps: Deps) => Promise<unknown>

export type Handlers = { readonly [T in MethodName]: Handler<T> }
