/**
 * The 4a source-read coverage was: the method action on `*`, then `databricks.read` on each declared operation, for
 * events_list, saved_read, probe and saved_list. The contract gate already asserts the method action; this test covers
 * the additional `databricks.read` rule, and that a deny stops each handler before its provider call.
 */
import { describe, expect, it } from "vitest"
import { methodOf } from "../../src/methods.js"
import { eventsList, probe, savedList, savedRead } from "../../src/handlers/sources/index.js"
import type { Deps, PermissionRequest } from "../../src/handlers/deps.js"
import { loadOptions } from "../../src/options.js"
import type { Call } from "../../src/handlers/types.js"

const account = { alias: "work", mode: "pat", host: "https://example.cloud.databricks.com", cloud: "aws", features: [], enforcement: "identity" } as const
const call: Call = { sessionID: "s", agent: "a", messageID: "m", id: "c", signal: new AbortController().signal, account: "work" }

let providerCalls = 0
const provider = async () => {
  providerCalls += 1
  throw new Error("provider reached")
}

function deps(requests: PermissionRequest[], deny = false): Deps {
  return {
    options: loadOptions({}),
    access: "all",
    auth: {
      account: () => account,
      accounts: () => [account],
      token: async () => ({ accessToken: "x", expiresAt: 0, scopes: [], host: account.host }),
    },
    databricks: {
      me: provider,
      getQuery: provider,
      listQueries: provider,
      getWarehouse: provider,
      submit: provider,
      waitForStatement: provider,
    },
    reads: { prepare: provider },
    ledger: {
      totals: async () => ({ startsToday: 0, dbuHoursToday: 0, startsSession: 0, dbuHoursSession: 0, estimate: true }),
      charge: async () => ({ recorded: true, totals: { startsToday: 0, dbuHoursToday: 0, startsSession: 0, dbuHoursSession: 0, estimate: true } }),
      starts: async () => [],
    },
    clock: { now: () => 0, uuid: () => "id" },
    permission: {
      assert: async (input: PermissionRequest) => {
        requests.push(input)
        if (deny) throw new Error("denied by the rule")
      },
    },
  } as unknown as Deps
}

const cases = [
  { method: "events_list" as const, invoke: (d: Deps) => eventsList({ account: "work", source: "queries" }, call, d) },
  { method: "saved_read" as const, invoke: (d: Deps) => savedRead({ account: "work", query: "q1" }, call, d) },
  { method: "probe" as const, invoke: (d: Deps) => probe({ account: "work", source: "queries" }, call, d) },
  { method: "saved_list" as const, invoke: (d: Deps) => savedList({ account: "work" }, call, d) },
]

describe("the 4a source-read gate", () => {
  it.each(cases)("$method asserts databricks.read on every declared operation", async ({ method, invoke }) => {
    const requests: PermissionRequest[] = []
    providerCalls = 0
    await expect(invoke(deps(requests))).rejects.toBeDefined()
    const expected = methodOf(method).operations.map((operation) => `work:${operation}`)
    expect(requests, method).toEqual(expected.map((resource) => ({
      sessionID: "s",
      action: "databricks.read",
      resources: [resource],
      source: { type: "tool", messageID: "m", id: "c" },
    })))
    expect(providerCalls, method).toBe(1)
  })

  it.each(cases)("$method refuses with PERMISSION_DENIED and never reaches the provider", async ({ method, invoke }) => {
    const requests: PermissionRequest[] = []
    providerCalls = 0
    const error = (await invoke(deps(requests, true)).catch((caught: unknown) => caught)) as { code?: string }
    expect(error.code, method).toBe("PERMISSION_DENIED")
    expect(requests, method).toHaveLength(1)
    expect(providerCalls, method).toBe(0)
  })
})
