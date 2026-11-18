/**
 * The source contract's errors (design §11, `events`' `SourceError`): the code, what happened and one next step, in the
 * family form `CODE: What happened. Next step: What to do.` The source contract's table is the one a consumer reads
 * (`NEEDS_SIGN_IN`, `ACCOUNT_MISMATCH`, `CURSOR_INVALID`, `CURSOR_EXPIRED`, `RATE_LIMITED`, `TOO_LARGE`,
 * `PERMISSION_DENIED`, `UNAVAILABLE`, `SCOPE_MISSING`, `INPUT_INVALID`, `SOURCE_UNKNOWN`), and a Databricks failure is
 * translated into it here. Databricks' own text never appears: it is only ever in a tool result's `providerError`
 * (design §5.8), and the source contract has no such field.
 */
import { SourceError } from "@we-the-rebel-alliance/source-contract/events"
import { DatabricksError } from "../domain/errors.js"

/** A source-contract refusal, with its code in this plugin's own words. */
export function sourceError(code: string, what: string, next: string, extra: { readonly retryAfterSec?: number; readonly since?: string } = {}): SourceError {
  const error = new SourceError({ code, what, next, ...(extra.retryAfterSec === undefined ? {} : { retryAfterSec: extra.retryAfterSec }) })
  if (extra.since) (error as SourceError & { since?: string }).since = extra.since
  return error
}

/** The contract code a Databricks failure is, in the source contract's vocabulary. */
export function sourceCodeOf(error: DatabricksError): string {
  switch (error.code) {
    case "AUTH_REQUIRED":
      return "NEEDS_SIGN_IN"
    case "AUTH_SCOPE_MISSING":
      return "SCOPE_MISSING"
    case "RATE_LIMITED":
      return "RATE_LIMITED"
    case "PERMISSION_DENIED":
    case "WAREHOUSE_FORBIDDEN":
    case "FENCED":
      return "PERMISSION_DENIED"
    case "BUDGET_REACHED":
      return "BUDGET_EXCEEDED"
    case "INPUT_INVALID":
    case "NOT_FOUND":
      return "INPUT_INVALID"
    case "SAVE_LIMIT":
      return "TOO_LARGE"
    default:
      return "UNAVAILABLE"
  }
}

/** A Databricks failure as a source error: the plugin's own wording, the contract's code, the retry when known. */
export function sourceErrorOf(error: unknown): SourceError {
  if (error instanceof SourceError) return error
  if (error instanceof DatabricksError) {
    const code = sourceCodeOf(error)
    return sourceError(code, error.detail, error.nextStep, error.retryAfterSec === undefined ? {} : { retryAfterSec: error.retryAfterSec })
  }
  return sourceError("UNAVAILABLE", "The provider call failed.", "Call the source again later.")
}

/**
 * The plugin's own code for a tool result (design §12), when a source method is called as the model's tool: the tool's
 * contract has this plugin's codes, while a source method answers the source contract's. The source method keeps the
 * contract's code; only the model's view is translated.
 */
export function toolCodeOf(code: string): string {
  switch (code) {
    case "NEEDS_SIGN_IN":
      return "AUTH_REQUIRED"
    case "SCOPE_MISSING":
      return "AUTH_SCOPE_MISSING"
    case "PERMISSION_DENIED":
      return "PERMISSION_DENIED"
    case "RATE_LIMITED":
      return "RATE_LIMITED"
    case "BUDGET_EXCEEDED":
      return "BUDGET_REACHED"
    case "TOO_LARGE":
      return "SAVE_LIMIT"
    case "CURSOR_INVALID":
    case "CURSOR_EXPIRED":
    case "ACCOUNT_MISMATCH":
    case "INPUT_INVALID":
    case "SOURCE_UNKNOWN":
    case "SOURCE_DISABLED":
      return "INPUT_INVALID"
    default:
      return "UNAVAILABLE"
  }
}
