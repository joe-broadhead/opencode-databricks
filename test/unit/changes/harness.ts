/**
 * A harness for package D's tools: the documented API (`fixtures/api.ts`, which refuses anything the reference would
 * not accept), its port adapter (`fixtures/port.ts`), and Day 0's port fake for everything the documented fixtures do
 * not cover (the warehouse object, `tables.get`, `me`). Every value is invented; nothing reaches the network.
 */
import { DatabricksError } from "../../../src/domain/errors.js"
import { createPlanStore } from "../../../src/domain/plans.js"
import type { Feature } from "../../../src/domain/actions.js"
import { loadOptions } from "../../../src/options.js"
import type { Deps } from "../../../src/registry.js"
import type { DatabricksPort, RunInfo, TableInfo, Warehouse } from "../../../src/ports.js"
import { FakeAuth, FakeReads, MemoryLedger, RecordingPermission, call, fakeClock, fakeDatabricks } from "../../fake/ports.js"
import { DocumentedApi, type ApiState, historyRecord } from "./fixtures/api.js"
import { documentedMethods } from "./fixtures/port.js"
import { STATEMENT_SUCCEEDED_NO_RESULT } from "./fixtures/workspace.js"

/** A running Small serverless warehouse, as the warehouse policy needs. */
export const RUNNING_WAREHOUSE: Warehouse = { id: "wh-small", name: "bi-small", state: "RUNNING", warehouseType: "PRO", serverless: true, clusterSize: "Small", autoStopMins: 10, minNumClusters: 1, maxNumClusters: 1, numClusters: 1 }

/** The notebook the harness knows, and the source `workspace/export` answers with. */
export const NOTEBOOK_PATH = "/Shared/Nightly"
export const NOTEBOOK_SOURCE = "# Databricks notebook source\nprint('hello')\n"

export interface ChangeHarnessInput {
  readonly options?: Record<string, unknown>
  readonly features?: readonly Feature[]
  readonly permission?: RecordingPermission
  /** The warehouse the fake answers with; `setWarehouse` moves it, and `startWarehouse` sets it RUNNING, as Databricks does. */
  readonly warehouse?: Warehouse
  /** Tables `tables.get` answers with; every other name is NOT_FOUND. */
  readonly tables?: Readonly<Record<string, Partial<TableInfo>>>
  readonly history?: readonly Record<string, unknown>[]
  readonly jobs?: Readonly<Record<number, string>>
  /** Tables per `<catalog>.<schema>`, for `tables.list` (a CASCADE's contents). */
  readonly schemas?: Readonly<Record<string, readonly string[]>>
  readonly runs?: readonly RunInfo[]
  /** The statement answer for every submit, in the documented shape. */
  readonly statement?: (statement: string) => Record<string, unknown>
}

export interface ChangeHarness {
  readonly deps: Deps
  readonly api: DocumentedApi
  readonly permission: RecordingPermission
  readonly ledger: MemoryLedger
  readonly reads: FakeReads
  readonly clock: ReturnType<typeof fakeClock>
  readonly auth: FakeAuth
  /** `tables.list`'s answer per `<catalog>.<schema>`: change it to move a CASCADE's contents between plan and commit. */
  readonly schemas: Map<string, string[]>
  /** Moves the warehouse under a plan or a commit, for the policy's TOCTOU and PLAN_CHANGED cases. */
  setWarehouse(warehouse: Warehouse): void
  /** The Day 0 port fake's calls, for the methods the documented API does not cover. */
  readonly calls: { method: string; args: unknown[] }[]
  /** What the documented API received, by `METHOD path`. */
  paths(): string[]
  /** The `POST /api/2.0/sql/statements` bodies, in order: the commits' exact text and fields. */
  statements(): Record<string, unknown>[]
  /** Fails when the fake refused a request the reference would accept, or accepted one it would not. */
  settle(): void
  call(id?: string): ReturnType<typeof call>
}

export function changeHarness(input: ChangeHarnessInput = {}): ChangeHarness {
  const options = loadOptions({ accounts: { work: { warehouse: "wh-small", features: [...(input.features ?? ["jobs", "workspace", "files"])] } }, ...input.options })
  let warehouse = input.warehouse ?? RUNNING_WAREHOUSE
  const api = new DocumentedApi({
    jobs: new Map(Object.entries(input.jobs ?? { 100: "nightly" }).map(([id, name]) => [Number(id), { name }])),
    runs: new Map(
      (input.runs ?? []).map((run) => [
        run.runId,
        {
          run_id: run.runId,
          ...(run.jobId === undefined ? {} : { job_id: run.jobId }),
          ...(run.creatorUserName === undefined ? {} : { creator_user_name: run.creatorUserName }),
          state: { life_cycle_state: run.state.lifeCycleState, ...(run.state.resultState === undefined ? {} : { result_state: run.state.resultState }) },
          start_time: run.startTime,
          ...(run.endTime === undefined ? {} : { end_time: run.endTime }),
          tasks: [],
        },
      ]),
    ),
    workspace: new Map([["/Shared", [{ path: NOTEBOOK_PATH, object_type: "NOTEBOOK", object_id: 1 }]], ["/", []]]),
    notebooks: new Map([[NOTEBOOK_PATH, NOTEBOOK_SOURCE]]),
    directories: new Map([["/Volumes/main/s/v", [{ path: "/Volumes/main/s/v/a.parquet", is_directory: false, file_size: 12, last_modified: 1_700_000_000_000 }]]]),
    statements: new Map([["*", input.statement ?? (() => STATEMENT_SUCCEEDED_NO_RESULT)]]),
    history: input.history ?? [],
  } as ApiState)

  const documented = documentedMethods(api)
  const tables = input.tables ?? {}
  const schemas = new Map(Object.entries(input.schemas ?? { "main.hr": ["salaries", "people"] }).map(([name, names]) => [name, [...names]]))
  const base = fakeDatabricks({
    getWarehouse: () => Promise.resolve(warehouse),
    startWarehouse: () => {
      warehouse = { ...warehouse, state: "RUNNING" }
      return Promise.resolve(undefined)
    },
    stopWarehouse: () => Promise.resolve(undefined),
    me: () => ({ id: "42", userName: "user@example.com", displayName: "User" }),
    listTables: (_account, catalog, schema, page) => {
      const paging = page as { readonly pageToken?: string; readonly maxResults?: number } | undefined
      const names = schemas.get(`${String(catalog)}.${String(schema)}`) ?? []
      const start = paging?.pageToken ? Number(paging.pageToken) : 0
      const size = paging?.maxResults ?? 100
      const items = names.slice(start, start + size).map((name) => ({ name, tableType: "MANAGED" }))
      return Promise.resolve({ items, ...(start + size < names.length ? { nextPageToken: String(start + size) } : {}) })
    },
    getTable: (account, fullName) => {
      const found = tables[String(fullName)]
      if (!found) return Promise.reject(new DatabricksError("NOT_FOUND"))
      return Promise.resolve({ fullName: String(fullName), tableType: "MANAGED", columns: [{ name: "id", typeText: "BIGINT" }], ...found } as TableInfo)
    },
  })
  const port = new Proxy(base.port, {
    get(target, name, receiver) {
      const documentedMethod = (documented as Record<string | symbol, unknown>)[name]
      return documentedMethod ?? Reflect.get(target, name, receiver)
    },
  }) as DatabricksPort
  const permission = input.permission ?? new RecordingPermission()
  const auth = new FakeAuth([{ alias: "work", mode: "interactive", host: "https://fake-workspace.cloud.databricks.com", cloud: "aws", features: [...(input.features ?? ["jobs", "workspace", "files"])], warehouse: "wh-small", enforcement: "identity" }])
  const ledger = new MemoryLedger()
  const clock = fakeClock()
  const reads = new FakeReads()
  const deps: Deps = { options, access: options.access, auth, databricks: port, reads, ledger, plans: createPlanStore({ ttlSeconds: options.planTtlSeconds, now: clock.now }), permission, clock }
  return {
    deps,
    api,
    permission,
    ledger,
    reads,
    clock,
    auth,
    schemas,
    setWarehouse: (next) => {
      warehouse = next
    },
    calls: base.calls,
    paths: () => api.paths(),
    statements: () => api.requests.filter((request) => request.path === "/api/2.0/sql/statements").map((request) => request.body as Record<string, unknown>),
    settle: () => api.mustNotReject(),
    call: (id = "call_1") => call(id),
  }
}

/** A documented history record for a statement one of D's tools ran. */
export const recorded = historyRecord
