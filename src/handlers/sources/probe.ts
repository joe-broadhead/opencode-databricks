/**
 * `probe` (contract §11): who the account is, for a source's consent. It reads no content, only the workspace's
 * `GET /api/2.0/preview/scim/v2/Me`, and answers the contract's `{ source?, account, owner, trust }`.
 */
import { refusal, RegisterError } from "@we-the-rebel-alliance/plugin-contract/register"
import { probeResult } from "@we-the-rebel-alliance/plugin-contract/events"
import type { Deps } from "../deps.js"
import type { Handler } from "../types.js"
import { ownerOf } from "./owner.js"
import { recordsOf } from "./records.js"

/** The source ids a probe may name: the short name or the descriptor's id. */
const SOURCES: Readonly<Record<string, string>> = {
  queries: "queries",
  runs: "runs",
  saved: "saved",
  "databricks.queries": "queries",
  "databricks.runs": "runs",
  "databricks.saved": "saved",
}

const probe: Handler<"probe"> = async (input, call, deps) => {
  const asked = input.source ?? "queries"
  const name = SOURCES[asked]
  if (name === undefined) throw new RegisterError(refusal("SOURCE_UNKNOWN", `This plugin has no source "${asked}".`, "Pass databricks.queries, databricks.runs or databricks.saved."))
  const account = input.account ?? Object.keys(deps.options.accounts ?? {})[0] ?? "default"
  let host: string
  try {
    host = deps.auth.account(account).host
  } catch {
    throw new RegisterError(refusal("ACCOUNT_UNKNOWN", `This plugin has no account "${account}".`, `Pass one of: ${Object.keys(deps.options.accounts ?? {}).join(", ") || "default"}.`))
  }
  const me = await deps.databricks.me(account, call.signal)
  recordsOf(deps).put(account, host, { userId: me.id, userName: me.userName, ...(me.displayName ? { displayName: me.displayName } : {}), at: deps.clock.now() })
  return probeResult({ source: name, account, owner: ownerOf(me, host) })
}

export default probe
