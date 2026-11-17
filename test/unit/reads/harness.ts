// A harness for the read path and the eight read tools: the Day 0 fakes (`test/fake/ports.ts`) plus the answers a guard
// needs from Databricks. Nothing here reaches the network; every value is invented.
import { DatabricksError } from "../../../src/domain/errors.js"
import { createPlanStore } from "../../../src/domain/plans.js"
import { loadOptions } from "../../../src/options.js"
import type { Deps } from "../../../src/registry.js"
import type { DatabricksPort, StatementAnswer, TableInfo, Warehouse } from "../../../src/ports.js"
import { FakeAuth, FakeReads, MemoryLedger, RecordingPermission, call, fakeClock, fakeDatabricks } from "../../fake/ports.js"

/** A serverless `Small` warehouse that is running: what most tests are allowed to use. */
export const runningWarehouse = (overrides: Partial<Warehouse> = {}): Warehouse => ({
  id: "wh-small",
  name: "bi-small",
  state: "RUNNING",
  warehouseType: "PRO",
  serverless: true,
  clusterSize: "Small",
  autoStopMins: 10,
  minNumClusters: 1,
  maxNumClusters: 1,
  ...overrides,
})

/** A table or a view; the shape `tables.get` answers with [27]. */
export const tableOf = (overrides: Partial<TableInfo> & { fullName: string }): TableInfo => ({ tableType: "MANAGED", columns: [{ name: "id", typeText: "BIGINT" }], ...overrides })

/** The session path the read path's own probe is answered with: `system.builtin` before every user schema. */
export const DEFAULT_PATH = "system.session,system.builtin,system.ai,main.default"

/** The probe's answer: one STRING column with the default path. */
export const pathAnswer = (path = DEFAULT_PATH): StatementAnswer => ({
  statementId: "st-path",
  state: "SUCCEEDED",
  manifest: { columns: [{ name: "current_path()", typeName: "STRING", typeText: "STRING", position: 0 }], totalRowCount: 1 },
  rows: [[path]],
})

/** A successful statement answer: one STRING column `value` with one row. */
export const answerOf = (overrides: Partial<StatementAnswer> = {}): StatementAnswer => ({
  statementId: "st-1",
  state: "SUCCEEDED",
  manifest: { columns: [{ name: "value", typeName: "STRING", typeText: "STRING", position: 0 }], totalRowCount: 1 },
  rows: [["ok"]],
  ...overrides,
})

export interface HarnessInput {
  readonly options?: Record<string, unknown>
  readonly answers?: Partial<Record<keyof DatabricksPort, (...args: unknown[]) => unknown>>
  readonly permission?: RecordingPermission
  readonly auth?: FakeAuth
}

export interface Harness {
  readonly deps: Deps
  readonly permission: RecordingPermission
  readonly databricks: ReturnType<typeof fakeDatabricks>
  readonly ledger: MemoryLedger
  readonly clock: ReturnType<typeof fakeClock>
  readonly auth: FakeAuth
  /** What a read tool's `call` looks like. */
  readonly call: (id?: string) => ReturnType<typeof call>
}

/** Deps over the fakes, with `getWarehouse` answering a running `Small` serverless warehouse by default. */
/** `submit` for a test: the probe is answered by the harness, every other statement by `submit`. */
export function submitFor(submit?: (statement: string) => unknown) {
  return (request: unknown) => {
    const statement = String((request as { statement?: string }).statement ?? "")
    if (statement.includes("current_path")) return pathAnswer()
    return submit ? submit(statement) : answerOf({ rows: [[DEFAULT_PATH]] })
  }
}

export function harness(input: HarnessInput = {}): Harness {
  const options = loadOptions({ accounts: { work: { warehouse: "wh-small" } }, ...input.options })
  const permission = input.permission ?? new RecordingPermission()
  const databricks = fakeDatabricks({
    getWarehouse: () => runningWarehouse(),
    // The read path's own `current_path()` probe is answered with the default path, so a path-sensitive read is
    // allowed; a tool test that expects rows answers `submit` itself, and `submitFor` keeps the probe's answer apart.
    submit: submitFor(),
    // An empty catalog: a name a test does not describe is not found, as Unity Catalog answers.
    getTable: () => Promise.reject(new DatabricksError("NOT_FOUND")),
    getFunction: () => Promise.reject(new DatabricksError("NOT_FOUND")),
    // Control calls that change nothing a test reads.
    startWarehouse: () => Promise.resolve(undefined),
    stopWarehouse: () => Promise.resolve(undefined),
    cancelStatement: () => Promise.resolve(undefined),
    ...input.answers,
  })
  const auth = input.auth ?? new FakeAuth()
  const ledger = new MemoryLedger()
  const clock = fakeClock()
  const deps: Deps = {
    options,
    access: options.access,
    auth,
    databricks: databricks.port,
    reads: new FakeReads(),
    ledger,
    plans: createPlanStore({ ttlSeconds: options.planTtlSeconds, now: clock.now }),
    permission,
    clock,
  }
  return { deps, permission, databricks, ledger, clock, auth, call: (id = "call_1") => call(id) }
}

/** The `statement` texts the fake was asked to submit, in order. */
export function statementsSent(databricks: ReturnType<typeof fakeDatabricks>): string[] {
  return databricks.calls.filter((entry) => entry.method === "submit").map((entry) => (entry.args[0] as { statement: string }).statement)
}

/** The full `StatementRequest`s the fake was asked to submit, in order. */
export function requestsSent(databricks: ReturnType<typeof fakeDatabricks>): Record<string, unknown>[] {
  return databricks.calls.filter((entry) => entry.method === "submit").map((entry) => entry.args[0] as Record<string, unknown>)
}

/** The statements a read sent, excluding the read path's own `current_path()` probe. */
export function readRequests(databricks: ReturnType<typeof fakeDatabricks>): Record<string, unknown>[] {
  return requestsSent(databricks).filter((request) => (request.queryTags as Record<string, string> | undefined)?.oc_tool !== "path-check")
}

/** The permission requests as `action on resource` strings, in order. */
export function asserted(permission: RecordingPermission): string[] {
  return permission.requests.map((request) => `${request.action} on ${request.resource}`)
}
