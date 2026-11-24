/**
 * Package E's sources: the four methods a source contract consumer calls — `events_list` (both event sources),
 * `saved_read` (the snapshot), `probe` and `saved_list` — and the two model tools they back (`databricks_events_list`,
 * `databricks_saved_read`).
 *
 * The split is the family's: the **model tool** answers the plugin's result shape (`{ state, … }`), and a source-contract
 * failure becomes one of this plugin's codes through `DatabricksError` (design §12); the **tools-RPC method** answers the
 * contract's page or snapshot and throws the contract's `SourceError`, which the tools RPC maps (source-contract#22).
 * `probe` and `saved_list` are methods only: they never run in a model session, so the identity and bind grants they
 * assert (`databricks.read`) never widen a model tool's action.
 */
import type { PluginMethod } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { PROBE, SourceError } from "@we-the-rebel-alliance/source-contract/events"
import { DatabricksError } from "../domain/errors.js"
import type { Deps } from "../registry.js"
import type { Call } from "../tool-spec.js"
import type { Handler } from "../tool-spec.js"
import { accountOf } from "../tools/reads/context.js"
import { sourceErrorOf, toolCodeOf } from "./errors.js"
import { eventsPage, type PageRequest } from "./events.js"
import { probe } from "./probe.js"
import { savedList, savedRead, tableOf } from "./saved.js"

/** The account a method reads: its input's, or the first configured (a source method always names one in practice). */
const accountFor = (input: { readonly account?: string }, deps: Deps): string => accountOf(input, deps)

/** A contract failure as the model's result: the plugin's code, the same words. A denial or a bug is rethrown. */
const asToolError = (error: unknown): never => {
  if (!(error instanceof SourceError) && !(error instanceof DatabricksError)) throw error
  const source = error instanceof SourceError ? error : sourceErrorOf(error)
  throw new DatabricksError(toolCodeOf(source.code) as never, source.message.replace(/^\S+: /u, ""), source.next)
}

/** `databricks_events_list`: the two event sources, as the model sees them. */
const eventsList: Handler<"events_list"> = async (input, call, deps) => {
  const notes: string[] = []
  try {
    const page = await eventsPage(deps, {
      account: accountFor(input, deps),
      source: input.source,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      call,
      // The model's own tool: the family's asserts, and it reads the identity itself when no probe has recorded it.
      mode: "tool",
      notes,
    })
    return { state: "ok", ...page, source: input.source, ...(notes.length ? { message: notes.join(" ") } : {}) }
  } catch (error) {
    return asToolError(error)
  }
}

/** `databricks_saved_read`: the snapshot source as the model sees it: a `table` of columns and rows. */
const savedReadTool: Handler<"saved_read"> = async (input, call, deps) => {
  try {
    const snapshot = await savedRead(
      deps,
      { account: accountFor(input, deps), query: input.query, sha: input.sha },
      call,
      "tool",
    )
    return { state: "ok", trust: "untrusted" as const, table: tableOf(snapshot), cost: snapshot.cost }
  } catch (error) {
    return asToolError(error)
  }
}

export const SOURCE_HANDLERS = { events_list: eventsList, saved_read: savedReadTool } as const

const object = (properties: Record<string, unknown>, required: readonly string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length ? { required: [...required] } : {}),
  additionalProperties: false,
})

const callOf = (call: unknown): Call => call as unknown as Call

/** The four tools-RPC methods a source contract consumer calls. */
export function sourceMethods(deps: () => Deps): PluginMethod[] {
  const events: PluginMethod = {
    kind: "plugin",
    class: "read",
    name: "events_list",
    action: "databricks.events_list",
    description: "The databricks.queries and databricks.runs event sources: the person's finished statements, and the workspace's finished job runs.",
    input: object(
      {
        account: { type: "string" },
        source: { type: "string", enum: ["queries", "runs"] },
        cursor: { type: "string" },
        since: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        scope: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
      },
      ["source"],
    ),
    output: { type: "object" },
    run: async (input, call) => {
      const value = input as Record<string, unknown>
      const request: PageRequest = {
        account: accountFor(value as { account?: string }, deps()),
        source: value.source as PageRequest["source"],
        ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}),
        ...(typeof value.since === "string" ? { since: value.since } : {}),
        ...(typeof value.limit === "number" ? { limit: value.limit } : {}),
        ...(value.scope !== undefined ? { scope: value.scope as Record<string, string[]> } : {}),
        call: callOf(call),
      }
      return eventsPage(deps(), request)
    },
  }

  const snapshot: PluginMethod = {
    kind: "plugin",
    class: "read",
    name: "saved_read",
    action: "databricks.saved_read",
    description: "Read one of your saved SQL queries, on its warehouse, only while that warehouse is already running.",
    input: object({ account: { type: "string" }, query: { type: "string" }, sha: { type: "string" } }, ["query", "sha"]),
    output: { type: "object" },
    run: async (input, call) => {
      const value = input as { account?: string; query: string; sha: string }
      return savedRead(deps(), { account: accountFor(value, deps()), query: value.query, sha: value.sha }, callOf(call))
    },
  }

  const probeMethod: PluginMethod = {
    kind: "plugin",
    class: "read",
    name: PROBE,
    action: "databricks.probe",
    description: "Who the account is, for a source's consent: reads no content.",
    input: object({ source: { type: "string" }, account: { type: "string" } }),
    output: { type: "object" },
    run: async (input, call) => probe(deps(), input, callOf(call)),
  }

  const savedListMethod: PluginMethod = {
    kind: "plugin",
    class: "read",
    name: "saved_list",
    action: "databricks.saved_list",
    description: "Your saved SQL queries with their SQL and sha256, for binding the databricks.saved source.",
    input: object({ account: { type: "string" }, source: { type: "string" } }),
    output: { type: "object" },
    run: async (input, call) => savedList(deps(), input as { account?: string; source?: string }, callOf(call)),
  }

  return [events, snapshot, probeMethod, savedListMethod]
}

export { eventsPage, probe, savedList, savedRead }
