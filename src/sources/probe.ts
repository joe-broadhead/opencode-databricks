/**
 * `probe` (design §11.4): who the account is, for a source's consent. It reads no content, only
 * `GET /api/2.0/preview/scim/v2/Me` [30], and answers the source contract's `{ source, account, owner, trust }`. The
 * design's `owner.id` is `mailto:<userName>` for a user and `databricks:<host>:principal:<id>` for a service principal;
 * `verified: false` is never written, because a v0.1.x consumer refuses it.
 *
 * It asserts `databricks.probe` on `*` first, then the identity operation's grant (`databricks.read` on
 * `<account>:scim.me.get`), the rule a consumer's `probeRules` fences the call with. The account is required by this
 * plugin's method: three aliases mean no silent first one is read.
 */
import { probeResult, type ProbeResult } from "@we-the-rebel-alliance/source-contract/events"
import type { Deps } from "../registry.js"
import type { Call } from "../tool-spec.js"
import { assertOperation } from "./assert.js"
import { sourceError, sourceErrorOf } from "./errors.js"
import { ownerOf } from "./owner.js"

/** The source ids a probe may name: the short name or the descriptor's id. */
const SOURCES: Readonly<Record<string, string>> = {
  queries: "queries",
  runs: "runs",
  saved: "saved",
  "databricks.queries": "queries",
  "databricks.runs": "runs",
  "databricks.saved": "saved",
}

export async function probe(deps: Deps, input: unknown, call: Call): Promise<ProbeResult> {
  // The source contract's `parseProbeInput` accepts only a lowercase source name, and a source whose descriptor has no
  // `input.source` is probed by its dotted id (`databricks.saved`), so the check is here and accepts both forms.
  if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input))) throw sourceError("INPUT_INVALID", "The probe input must be an object with source and account.", "Pass only source and account.")
  const raw = (input ?? {}) as Record<string, unknown>
  const unknown = Object.keys(raw).filter((key) => key !== "source" && key !== "account")
  if (unknown.length > 0) throw sourceError("INPUT_INVALID", `The probe input names ${unknown.join(", ")}, which probe does not read.`, "Pass only source and account.")
  if (raw.source !== undefined && typeof raw.source !== "string") throw sourceError("INPUT_INVALID", "probe's source must be a string.", "Pass one of databricks.queries, databricks.runs or databricks.saved.")
  if (raw.account !== undefined && typeof raw.account !== "string") throw sourceError("INPUT_INVALID", "probe's account must be a string.", "Pass the account probe answers for.")
  const parsed = { value: { source: raw.source as string | undefined, account: raw.account as string | undefined } }
  const asked = parsed.value.source ?? "queries"
  const name = SOURCES[asked]
  if (name === undefined) throw sourceError("SOURCE_UNKNOWN", `This plugin has no source "${asked}".`, "Pass one of databricks.queries, databricks.runs or databricks.saved.")
  await deps.permission.assert({ action: "databricks.probe", resource: "*", sessionID: call.sessionID, messageID: call.messageID, callID: call.id }, call.signal)
  if (parsed.value.account === undefined) {
    // A probe names its account: with aliases, reading the first one silently would read a workspace nobody asked for.
    // The answer is the family's error result, because a tools-RPC method's caller may be the model's session.
    return { state: "refused", error: "INPUT_INVALID", message: "The probe did not name an account.", next: "Pass the account to probe, as the source's binding names it." } as unknown as ProbeResult
  }
  const account = parsed.value.account
  try {
    deps.auth.account(account)
  } catch {
    throw sourceError("ACCOUNT_MISMATCH", `This plugin is not signed in to "${account}".`, "Pass an account this plugin has, or sign in with /connect.")
  }
  await assertOperation(deps.permission, call, "databricks.probe", "scim.me.get", account)
  try {
    const me = await deps.databricks.me(account, call.signal)
    // The answer names the source by its lowercase name (the contract's `source` pattern), also when the descriptor,
    // having no `input.source`, asked for the dotted id.
    return probeResult({ source: name, account, owner: ownerOf(me, deps.auth.account(account).host) })
  } catch (error) {
    throw sourceErrorOf(error)
  }
}
