// A harness for the sources' tests and the conformance kit: Day 0's fakes plus a strict REST fake, a fixed clock, and a
// permission port that records through whatever context the conformance kit hands it. No network, no Databricks.
import { createPlanStore } from "../../../src/domain/plans.js"
import { loadOptions } from "../../../src/options.js"
import type { Deps } from "../../../src/registry.js"
import type { PermissionPort } from "../../../src/ports.js"
import { FakeAuth, FakeReads, MemoryLedger, call as fakeCall, fakeClock, fakeDatabricks } from "../../fake/ports.js"
import { memoryRecords, useRecords, type RecordStore } from "../../../src/sources/records.js"
import { FAKE_HOST, ME, fakeRest, type FakeRest } from "./fake-rest.js"

/** The fixed clock every source test runs at: 2027-01-15T08:00:00Z. */
export const NOW = 1_800_000_000_000
export const DAY = 86_400_000

/** The record `probe` writes for the fake's signed-in person (Sam), as a consumer's bind leaves it. */
export const probed = (): RecordStore => memoryRecords([{ account: "work", host: FAKE_HOST, record: { userId: ME.id, userName: ME.userName, displayName: ME.displayName, at: NOW } }])

/**
 * Dependencies over a REST fake. `records` is the probe record store: by default one where the account was probed, as a
 * consumer's bind leaves it; pass `memoryRecords()` for an account never probed.
 */
export function depsFor(rest: Pick<FakeRest, "answers">, permission: PermissionPort, options: Record<string, unknown> = {}, records: RecordStore = probed()): Deps {
  const loaded = loadOptions({ accounts: { work: { warehouse: "wh-small" } }, ...options })
  const clock = fakeClock(NOW)
  const deps: Deps = {
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
  useRecords(deps, records)
  return deps
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
