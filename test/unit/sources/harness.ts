// A harness for the sources' tests and the conformance kit: Day 0's fakes plus a strict REST fake, a fixed clock, and a
// permission port that records through whatever context the conformance kit hands it. No network, no Databricks.
import { createPlanStore } from "../../../src/domain/plans.js"
import { loadOptions } from "../../../src/options.js"
import type { Deps } from "../../../src/registry.js"
import type { PermissionPort } from "../../../src/ports.js"
import { FakeAuth, FakeReads, MemoryLedger, call as fakeCall, fakeClock, fakeDatabricks } from "../../fake/ports.js"
import { fakeRest, type FakeRest } from "./fake-rest.js"

/** The fixed clock every source test runs at: 2027-01-15T08:00:00Z. */
export const NOW = 1_800_000_000_000
export const DAY = 86_400_000

export function depsFor(rest: FakeRest, permission: PermissionPort, options: Record<string, unknown> = {}): Deps {
  const loaded = loadOptions({ accounts: { work: { warehouse: "wh-small" } }, ...options })
  const clock = fakeClock(NOW)
  return {
    options: loaded,
    access: loaded.access,
    auth: new FakeAuth(),
    databricks: fakeDatabricks(rest.answers, clock.now).port,
    reads: new FakeReads(),
    ledger: new MemoryLedger(),
    plans: createPlanStore({ ttlSeconds: 300, now: clock.now }),
    permission,
    clock,
  }
}

/** A permission that lets everything and records nothing: for a plain read test. */
export const openPermission: PermissionPort = { assert: async () => undefined }

/** A recording permission that refuses nothing. */
export const allowing = openPermission

export const call = (id = "call_src") => fakeCall(id, "ses_sources")

/** A two-event dataset for `queries`, and a small one for `runs`, both inside the first listing's 24 hours. */
export function recent() {
  return fakeRest({
    history: [],
    runs: [],
    saved: [{ id: "be6df0a0-c317-44df-9659-b4f206c5d027", name: "Revenue by region", queryText: "SELECT * FROM main.sales.orders", warehouseId: "wh-small", owner: "sam.rivera@example.com" }],
  })
}
