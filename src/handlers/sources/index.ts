/**
 * The three source reads (contract §7): `events_list` for the two event sources, `saved_read` for the snapshot, and the
 * `probe`/`saved_list` reads a consumer uses at bind time. The contract's register owns the account, the permission gate
 * and the answer schema; these handlers own the provider work.
 */
import type { Deps } from "../deps.js"
import type { Call, Handler } from "../types.js"
import { eventsPage, type PageRequest } from "./events.js"
import { savedRead } from "./saved.js"
import { assertReadOperations } from "./permission.js"

export { default as probe } from "./probe.js"
export { default as savedList } from "../saved_list.js"

/** `events_list`: the two event sources, as the contract's page. */
const eventsList: Handler<"events_list"> = async (input, call, deps) => {
  const account = input.account ?? Object.keys(deps.options.accounts ?? {})[0] ?? "default"
  await assertReadOperations(deps, call, "events_list", account)
  const request: PageRequest = {
    account,
    source: (input.source ?? "queries") as PageRequest["source"],
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.since === undefined ? {} : { since: input.since }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    call,
    mode: "tool",
  }
  return eventsPage(deps, request)
}

/** `saved_read`: the snapshot, which never starts a warehouse. */
const savedReadHandler: Handler<"saved_read"> = async (input, call, deps) => {
  const account = input.account ?? Object.keys(deps.options.accounts ?? {})[0] ?? "default"
  await assertReadOperations(deps, call, "saved_read", account)
  return savedRead(deps, { account, ...(input.query === undefined ? {} : { query: input.query }), ...(input.sha === undefined ? {} : { sha: input.sha }), ...(input.scope === undefined ? {} : { scope: input.scope }) }, call)
}

export const SOURCE_HANDLERS = { events_list: eventsList, saved_read: savedReadHandler } as const
export { eventsList, savedReadHandler as savedRead }
