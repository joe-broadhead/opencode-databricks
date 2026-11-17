/**
 * The ports: every boundary between the plugin's decisions and the outside world (design §16). Each package builds
 * against these, and test/fake/ports.ts has a fake for each, so the packages build in parallel (docs/ownership.md).
 *
 * - `DatabricksPort` (package B builds it over `fetch`): Databricks' REST calls, typed. Every call names its operation
 *   (src/domain/actions.ts), so the scope check (`AUTH_SCOPE_MISSING`) and the operation assert run before it.
 * - `AuthPort` (package A): an access token for an account and the scopes it needs.
 * - `LedgerPort` (Day 0, src/ledger.ts): the spend ledger.
 * - `PlanStorePort` (Day 0, src/domain/plans.ts): single-use plans.
 * - `PermissionPort`: OpenCode's `ctx.permission.assert`, so a tool asserts its dotted action before any call.
 * - `Clock`: time and ids, so tests are deterministic.
 *
 * Every call takes the call's `signal`; a stopped call aborts its request. Databricks' text in an answer is untrusted.
 */
import type { Feature, Operation } from "./domain/actions.js"
import type { ProviderError } from "./domain/errors.js"

export type { PlanStorePort } from "./domain/plans.js"

// ── auth (package A) ─────────────────────────────────────────────────────

export type Mode = "interactive" | "pat" | "m2m" | "cli"

export interface AccountInfo {
  readonly alias: string
  readonly mode: Mode
  /** `https://<workspace host>`, validated (HOST_INVALID). */
  readonly host: string
  readonly cloud: "aws" | "azure" | "gcp" | "custom"
  readonly features: readonly Feature[]
  /** The role bound at sign-in: its group id and the name asked for. */
  readonly role?: { readonly groupId: string; readonly name?: string }
  readonly warehouse?: string
  readonly catalog?: string
  readonly schema?: string
}

export interface Token {
  readonly accessToken: string
  readonly expiresAt: number
  /** The scopes the token carries, as granted. `all-apis` counts as every scope. */
  readonly scopes: readonly string[]
}

export interface AuthPort {
  accounts(): readonly AccountInfo[]
  account(alias?: string): AccountInfo
  /** A current token for `account` that carries every scope in `scopes`, or AUTH_REQUIRED / AUTH_SCOPE_MISSING. */
  token(account: string, scopes: readonly string[], signal: AbortSignal): Promise<Token>
}

// ── Databricks REST (package B) ──────────────────────────────────────────

export type WarehouseState = "STARTING" | "RUNNING" | "STOPPING" | "STOPPED" | "DELETING" | "DELETED"

export interface Warehouse {
  readonly id: string
  readonly name: string
  readonly state: WarehouseState
  /** `warehouse_type`: PRO or CLASSIC; serverless is PRO with `enable_serverless_compute`. */
  readonly warehouseType: "PRO" | "CLASSIC" | "TYPE_UNSPECIFIED"
  readonly serverless: boolean
  readonly clusterSize: string
  readonly autoStopMins: number
  readonly minNumClusters: number
  readonly maxNumClusters: number
  readonly numClusters?: number
  /** Beta: the warehouse's statement timeout, seconds. */
  readonly statementTimeoutSeconds?: number
}

export interface StatementParameter {
  readonly name: string
  readonly value: string | null
  readonly type?: string
}

/** One `POST /api/2.0/sql/statements` (design §5.1 step 6, §8.2). */
export interface StatementRequest {
  readonly account: string
  readonly operation: "sql.statements.query" | "sql.statements.change"
  /** Exactly the text to run: the wrapped read, an EXPLAIN of it, or a committed plan's text. */
  readonly statement: string
  readonly warehouseId: string
  readonly catalog?: string
  readonly schema?: string
  readonly parameters?: readonly StatementParameter[]
  readonly rowLimit?: number
  readonly byteLimit?: number
  readonly disposition: "INLINE" | "EXTERNAL_LINKS"
  readonly format: "JSON_ARRAY" | "ARROW_STREAM"
  /** Seconds, 0 or 5–50. */
  readonly waitTimeout: number
  readonly onWaitTimeout: "CANCEL" | "CONTINUE"
  readonly queryTags: Readonly<Record<string, string>>
}

export type StatementState = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "CLOSED"

export interface ResultColumn {
  readonly name: string
  readonly typeName: string
  readonly typeText: string
  readonly position: number
}

export interface ExternalLink {
  readonly chunkIndex: number
  /** Carries credentials: never returned, logged or stored (design §5.8). */
  readonly url: string
  readonly expiration: string
  readonly rowCount: number
  readonly byteCount: number
  readonly nextChunkIndex?: number
}

export interface StatementAnswer {
  readonly statementId: string
  readonly state: StatementState
  readonly error?: ProviderError
  readonly manifest?: {
    readonly columns: readonly ResultColumn[]
    readonly totalRowCount?: number
    readonly totalChunkCount?: number
    readonly truncated?: boolean
  }
  /** INLINE + JSON_ARRAY: strings or null, in column order. */
  readonly rows?: readonly (readonly (string | null)[])[]
  readonly links?: readonly ExternalLink[]
  readonly nextChunkIndex?: number
  /** The submit may have reached the server but no answer came (design §9): never retried blindly. */
  readonly ambiguous?: boolean
}

export interface HistoryQuery {
  readonly queryId: string
  readonly status: "QUEUED" | "RUNNING" | "FINISHED" | "FAILED" | "CANCELED"
  readonly statementType?: string
  readonly warehouseId?: string
  readonly userId?: number
  readonly executedAsUserId?: number
  readonly queryStartTimeMs: number
  readonly queryEndTimeMs?: number
  readonly durationMs?: number
  readonly rowsProduced?: number
  readonly readBytes?: number
  readonly queryTags?: Readonly<Record<string, string>>
  /** Untrusted; cut to 200 characters for listings. */
  readonly queryText?: string
  readonly isFinal?: boolean
  readonly resultFromCache?: boolean
}

export interface TableInfo {
  readonly fullName: string
  readonly tableType: string
  readonly dataSourceFormat?: string
  readonly comment?: string
  readonly owner?: string
  readonly columns: readonly { readonly name: string; readonly typeText: string; readonly nullable?: boolean; readonly comment?: string; readonly mask?: { readonly functionName: string } }[]
  readonly rowFilter?: { readonly functionName: string }
  readonly viewDefinition?: string
  /** Absent when Unity Catalog does not provide it ("the dependency is not provided"). */
  readonly viewDependencies?: readonly Dependency[]
  readonly updatedAt?: number
}

export type Dependency =
  | { readonly kind: "table"; readonly name: string }
  | { readonly kind: "function"; readonly name: string }
  | { readonly kind: "connection"; readonly name: string }
  | { readonly kind: "credential"; readonly name: string }

export interface FunctionInfo {
  readonly fullName: string
  /** `SQL` or `EXTERNAL` (Python, Scala). */
  readonly routineBody: "SQL" | "EXTERNAL"
  readonly externalLanguage?: string
  readonly routineDefinition?: string
  readonly routineDependencies?: readonly Dependency[]
  /** A table function (UDTF): `data_type` TABLE_TYPE. */
  readonly isTableFunction: boolean
}

export interface Page<T> {
  readonly items: readonly T[]
  readonly nextPageToken?: string
}

export interface RunInfo {
  readonly runId: number
  readonly jobId?: number
  readonly runName?: string
  readonly state: { readonly lifeCycleState: string; readonly resultState?: string }
  readonly startTime: number
  readonly endTime?: number
  readonly creatorUserName?: string
  readonly triggerType?: string
  readonly runType?: string
}

export interface Identity {
  readonly id: string
  readonly userName: string
  readonly displayName?: string
}

export interface DatabricksPort {
  me(account: string, signal: AbortSignal): Promise<Identity>
  // Warehouses (free).
  listWarehouses(account: string, signal: AbortSignal): Promise<readonly Warehouse[]>
  getWarehouse(account: string, id: string, signal: AbortSignal): Promise<Warehouse>
  startWarehouse(account: string, id: string, signal: AbortSignal): Promise<void>
  stopWarehouse(account: string, id: string, signal: AbortSignal): Promise<void>
  // Statements (warehouse). `submit` is never retried after it may have reached the server (design §9).
  submit(request: StatementRequest, signal: AbortSignal): Promise<StatementAnswer>
  getStatement(account: string, statementId: string, signal: AbortSignal): Promise<StatementAnswer>
  getChunk(account: string, statementId: string, chunkIndex: number, signal: AbortSignal): Promise<StatementAnswer>
  cancelStatement(account: string, statementId: string, signal: AbortSignal): Promise<void>
  // Query History (free).
  history(account: string, filter: { readonly userIds?: readonly number[]; readonly warehouseIds?: readonly string[]; readonly startMs?: number; readonly endMs?: number; readonly pageToken?: string; readonly maxResults?: number }, signal: AbortSignal): Promise<Page<HistoryQuery>>
  // Unity Catalog (free).
  listCatalogs(account: string, page: { readonly pageToken?: string; readonly maxResults?: number }, signal: AbortSignal): Promise<Page<{ readonly name: string; readonly comment?: string; readonly owner?: string }>>
  listSchemas(account: string, catalog: string, page: { readonly pageToken?: string; readonly maxResults?: number }, signal: AbortSignal): Promise<Page<{ readonly name: string; readonly comment?: string; readonly owner?: string }>>
  listTables(account: string, catalog: string, schema: string, page: { readonly pageToken?: string; readonly maxResults?: number }, signal: AbortSignal): Promise<Page<{ readonly name: string; readonly tableType: string; readonly comment?: string; readonly owner?: string; readonly updatedAt?: number }>>
  getTable(account: string, fullName: string, signal: AbortSignal): Promise<TableInfo>
  listFunctions(account: string, catalog: string, schema: string, page: { readonly pageToken?: string }, signal: AbortSignal): Promise<Page<{ readonly name: string; readonly routineBody: string }>>
  getFunction(account: string, fullName: string, signal: AbortSignal): Promise<FunctionInfo>
  listVolumes(account: string, catalog: string, schema: string, page: { readonly pageToken?: string }, signal: AbortSignal): Promise<Page<{ readonly name: string; readonly volumeType: string }>>
  effectivePermissions(account: string, securable: { readonly type: string; readonly fullName: string }, signal: AbortSignal): Promise<readonly { readonly principal: string; readonly privileges: readonly string[] }[]>
  // Saved queries (free; serialised: "10 or more" concurrent calls may be throttled).
  listQueries(account: string, page: { readonly pageToken?: string }, signal: AbortSignal): Promise<Page<{ readonly id: string; readonly name: string; readonly owner?: string; readonly warehouseId?: string; readonly queryText: string }>>
  getQuery(account: string, id: string, signal: AbortSignal): Promise<{ readonly id: string; readonly name: string; readonly warehouseId?: string; readonly queryText: string }>
  // Jobs (free reads; runs bill separately). Runs always carry `idempotency_token` (design §9).
  listJobs(account: string, page: { readonly pageToken?: string; readonly limit?: number }, signal: AbortSignal): Promise<Page<{ readonly jobId: number; readonly name: string; readonly creatorUserName?: string }>>
  listRuns(account: string, filter: { readonly jobId?: number; readonly completedOnly?: boolean; readonly startTimeFrom?: number; readonly startTimeTo?: number; readonly pageToken?: string; readonly limit?: number }, signal: AbortSignal): Promise<Page<RunInfo>>
  getRun(account: string, runId: number, signal: AbortSignal): Promise<RunInfo & { readonly tasks: readonly { readonly taskKey: string; readonly state: string; readonly durationMs?: number; readonly error?: string }[] }>
  getRunOutput(account: string, runId: number, signal: AbortSignal): Promise<{ readonly output?: string; readonly truncated?: boolean }>
  runNow(account: string, input: { readonly jobId: number; readonly params?: Readonly<Record<string, string>>; readonly idempotencyToken: string }, signal: AbortSignal): Promise<{ readonly runId: number }>
  submitRun(account: string, input: { readonly notebookPath: string; readonly params?: Readonly<Record<string, string>>; readonly idempotencyToken: string; readonly timeoutSeconds: number }, signal: AbortSignal): Promise<{ readonly runId: number }>
  cancelRun(account: string, runId: number, signal: AbortSignal): Promise<void>
  // Workspace and files (free).
  listWorkspace(account: string, path: string, signal: AbortSignal): Promise<readonly { readonly path: string; readonly objectType: string; readonly size?: number; readonly modifiedAt?: number }[]>
  exportNotebook(account: string, path: string, signal: AbortSignal): Promise<{ readonly source: string }>
  listDirectory(account: string, path: string, signal: AbortSignal): Promise<readonly { readonly path: string; readonly isDirectory: boolean; readonly size?: number; readonly modifiedAt?: number }[]>
  /** An external link's bytes, fetched without an Authorization header, from an allowed storage host only. */
  fetchLink(link: ExternalLink, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>
}

// ── the spend ledger (Day 0) ─────────────────────────────────────────────

export interface Budget {
  readonly daily?: { readonly starts?: number; readonly dbuHours?: number }
  readonly session?: { readonly starts?: number; readonly dbuHours?: number }
  readonly action: "warn" | "refuse"
}

export interface Charge {
  readonly at: string
  readonly account: string
  readonly sessionId?: string
  readonly warehouseId: string
  readonly kind: "start" | "statement" | "saved-read"
  readonly dbuHours: number
  readonly statementId?: string
}

export interface SpendTotals {
  readonly startsToday: number
  readonly dbuHoursToday: number
  readonly startsSession: number
  readonly dbuHoursSession: number
  readonly estimate: true
}

export interface LedgerPort {
  totals(account: string, sessionId?: string): Promise<SpendTotals>
  /** Records a charge unless a `refuse` budget would be exceeded; `exceeded` names the limit (BUDGET_REACHED). */
  charge(charge: Omit<Charge, "at">, budget?: Budget): Promise<{ readonly recorded: boolean; readonly exceeded?: string; readonly totals: SpendTotals }>
}

// ── permissions and time ─────────────────────────────────────────────────

export interface PermissionRequest {
  /** The dotted action: `databricks.<tool>`, `databricks.start` or `databricks.probe`. */
  readonly action: string
  /** `<account>:<operation>`, `<account>:table:<c>.<s>.<t>` or `<account>:warehouse:<id>`. */
  readonly resource: string
  readonly sessionID: string
  readonly messageID?: string
  readonly callID?: string
}

export interface PermissionPort {
  /** Resolves when allowed (asking the person if the rules say ask); rejects when denied. */
  assert(request: PermissionRequest, signal: AbortSignal): Promise<void>
}

export interface Clock {
  now(): number
  uuid(): string
}
