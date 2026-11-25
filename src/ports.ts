/**
 * The ports: every boundary between the plugin's decisions and the outside world.
 *
 * - `DatabricksPort` builds over `fetch`: Databricks' REST calls, typed. Every call names its operation
 *   (`src/methods.ts`), so the scope check (`AUTH_SCOPE_MISSING`) and the operation assert run before it.
 * - `AuthPort`: an access token for an account and the scopes it needs.
 * - `ReadGuardPort` (`src/provider/guards/read.ts`): the shared read path.
 * - `LedgerPort` (`src/provider/ledger.ts`): the spend ledger.
 * - `Clock`: time and ids, so tests are deterministic.
 *
 * Every call takes the call's `signal`; a stopped call aborts its request. Databricks' text in an answer is untrusted.
 */
import type { Feature, Operation } from "./methods.js"
import type { EnforcementKind } from "./handlers/schemas.js"
import type { ProviderError } from "./domain/errors.js"


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
  /**
   * Which guarantee holds (`enforcementOf(account)`, package A). Raised to `"role"` only by a doctor report from this
   * process, bound to the credential's (host, role group, granted scopes), in memory only, cleared when they change.
   * Status and `PreparedRead.enforcement` read this field. See `Enforcement` in src/domain/contract.ts.
   */
  readonly enforcement: EnforcementKind
}

export interface Token {
  readonly accessToken: string
  readonly expiresAt: number
  /** The scopes the token carries, as granted. `all-apis` counts as every scope. */
  readonly scopes: readonly string[]
  /** `https://<workspace host>` the token was minted for. Package B sends to `token.host`, never to `account().host`. */
  readonly host: string
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
  /** `null` is SQL NULL: the client sends the parameter without `value`, which the Statement Execution API reads as NULL. */
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

/**
 * One chunk of a statement's result: `GET /api/2.0/sql/statements/{id}/result/chunks/{n}`. Databricks documents its
 * body as "identical to the nested `result` element" of getStatement, with `chunk_index`, `row_count`,
 * `next_chunk_index`, `data_array` and `external_links` **at the top level**, and no `statement_id` or `status`
 * (review of #3, H1). So a chunk has no state of its own: a chunk with no rows and no links, while the manifest says
 * more chunks exist, is UNAVAILABLE, never PENDING.
 */
export interface ChunkAnswer {
  readonly chunkIndex: number
  readonly rowCount?: number
  /** INLINE + JSON_ARRAY: strings or null, in column order. */
  readonly rows?: readonly (readonly (string | null)[])[]
  readonly links?: readonly ExternalLink[]
  readonly nextChunkIndex?: number
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
  /** From `metrics`, which Query History returns only when the request sets `include_metrics`. */
  readonly resultFromCache?: boolean
  /** `cache_query_id`: the query whose cached result was returned (outside `metrics`). */
  readonly cacheQueryId?: string
  /** `user_name`: who submitted it (review of #8, request 4). Untrusted text. */
  readonly userName?: string
  /** `executed_as_user_name`: whose identity it ran as. Untrusted text. */
  readonly executedAsUserName?: string
  /** `client_application`: the client that submitted it, such as a BI tool. Untrusted text; cut to 64 characters when shown. */
  readonly clientApplication?: string
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
  /** The partition columns, in order: package B derives them from the columns' `partition_index` (UC `ColumnInfo`). */
  readonly partitionColumns?: readonly string[]
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
  /**
   * UC `sql_path`, the PATH captured at CREATE FUNCTION, along which the body's unqualified names resolve. Absent when
   * Unity Catalog does not return it. Package C requires `pathIsSafe(sqlPath)` for a body with anything path-sensitive.
   */
  readonly sqlPath?: string
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

/** Where one task of a job runs (review of #7, request 1). `existing` is an all-purpose cluster. */
export type JobCompute =
  | { readonly kind: "serverless" }
  /**
   * A job cluster: `new_cluster` inline, or `job_cluster_key` resolved from the job's `settings.job_clusters` (then the
   * key is kept, so the preview can say it is shared).
   */
  | { readonly kind: "job-cluster"; readonly jobClusterKey?: string; readonly nodeTypeId?: string; readonly numWorkers?: number; readonly autoscale?: { readonly min: number; readonly max: number } }
  | { readonly kind: "existing"; readonly clusterId: string }
  /** A SQL warehouse task (`sql_task.warehouse_id`, `dbt_task.warehouse_id`, a notebook's `warehouse_id`). */
  | { readonly kind: "warehouse"; readonly warehouseId: string }
  /** A task that needs no compute (`condition_task`). */
  | { readonly kind: "none"; readonly what: string }
  /** A `run_job_task`: its compute is the other job's. */
  | { readonly kind: "job"; readonly jobId: number }
  /** A `pipeline_task`: its compute belongs to the pipeline. */
  | { readonly kind: "pipeline"; readonly pipelineId?: string }
  /** A `for_each_task`: every iteration runs the inner task, so its compute is the inner task's. */
  | { readonly kind: "for-each"; readonly compute: JobCompute }
  /** The task's compute cannot be determined from its settings; the preview says so rather than guessing. */
  | { readonly kind: "unknown"; readonly reason: string }

/** One job's settings, from `GET /api/2.2/jobs/get` (`jobs.jobs.get`). `timeoutSeconds` 0 means no timeout. */
export interface JobInfo {
  readonly jobId: number
  readonly name: string
  readonly creatorUserName?: string
  readonly runAsUserName?: string
  readonly timeoutSeconds?: number
  readonly tasks: readonly { readonly taskKey: string; readonly compute: JobCompute; readonly timeoutSeconds?: number }[]
}

/** The fields a warehouse-edit plan may change (`sql.warehouses.edit`). Not `statement_timeout`: it is not in this body. */
export interface WarehouseEdit {
  readonly clusterSize?: string
  readonly autoStopMins?: number
  readonly minNumClusters?: number
  readonly maxNumClusters?: number
}

export interface Identity {
  readonly id: string
  readonly userName: string
  readonly displayName?: string
  /** SCIM `Me`'s groups (no further scope needed). The doctor resolves the role's name for `principal` from them. */
  readonly groups?: readonly { readonly id: string; readonly displayName?: string }[]
}

export interface DatabricksPort {
  me(account: string, signal: AbortSignal): Promise<Identity>
  // Warehouses (free).
  listWarehouses(account: string, signal: AbortSignal): Promise<readonly Warehouse[]>
  getWarehouse(account: string, id: string, signal: AbortSignal): Promise<Warehouse>
  startWarehouse(account: string, id: string, signal: AbortSignal): Promise<void>
  stopWarehouse(account: string, id: string, signal: AbortSignal): Promise<void>
  /**
   * Edits a warehouse (`POST /api/2.0/sql/warehouses/{id}/edit`, `sql.warehouses.edit`). Package B cites the edit page;
   * if it documents the body as a full replacement, B sends the read-back warehouse with only these fields changed.
   */
  editWarehouse(account: string, id: string, edit: WarehouseEdit, signal: AbortSignal): Promise<void>
  // Statements (warehouse). `submit` is never retried after it may have reached the server (design §9).
  submit(request: StatementRequest, signal: AbortSignal): Promise<StatementAnswer>
  getStatement(account: string, statementId: string, signal: AbortSignal): Promise<StatementAnswer>
  /** One result chunk, read in the top-level shape the API returns (`ChunkAnswer`). */
  getChunk(account: string, statementId: string, chunkIndex: number, signal: AbortSignal): Promise<ChunkAnswer>
  /** Polls a statement at most once a second until it is terminal or `untilMs` (epoch ms, from the Clock port) passes; returns the last answer. A stopped call cancels the statement, then throws CANCELLED. */
  waitForStatement(account: string, statementId: string, options: { readonly untilMs: number }, signal: AbortSignal): Promise<StatementAnswer>
  cancelStatement(account: string, statementId: string, signal: AbortSignal): Promise<void>
  // Query History (free).
  /**
   * Query History. `statementIds` sends `filter_by.statement_ids`; `includeMetrics` sends `include_metrics=true`,
   * without which `metrics` (`resultFromCache`, `readBytes`) is absent. A read that wants "served from the cache"
   * looks its own statement up here.
   */
  history(account: string, filter: { readonly userIds?: readonly number[]; readonly warehouseIds?: readonly string[]; readonly statementIds?: readonly string[]; readonly startMs?: number; readonly endMs?: number; readonly pageToken?: string; readonly maxResults?: number; readonly includeMetrics?: boolean }, signal: AbortSignal): Promise<Page<HistoryQuery>>
  // Unity Catalog (free).
  listCatalogs(account: string, page: { readonly pageToken?: string; readonly maxResults?: number }, signal: AbortSignal): Promise<Page<{ readonly name: string; readonly comment?: string; readonly owner?: string }>>
  listSchemas(account: string, catalog: string, page: { readonly pageToken?: string; readonly maxResults?: number }, signal: AbortSignal): Promise<Page<{ readonly name: string; readonly comment?: string; readonly owner?: string }>>
  listTables(account: string, catalog: string, schema: string, page: { readonly pageToken?: string; readonly maxResults?: number }, signal: AbortSignal): Promise<Page<{ readonly name: string; readonly tableType: string; readonly comment?: string; readonly owner?: string; readonly updatedAt?: number }>>
  getTable(account: string, fullName: string, signal: AbortSignal): Promise<TableInfo>
  listFunctions(account: string, catalog: string, schema: string, page: { readonly pageToken?: string }, signal: AbortSignal): Promise<Page<{ readonly name: string; readonly routineBody: string }>>
  getFunction(account: string, fullName: string, signal: AbortSignal): Promise<FunctionInfo>
  listVolumes(account: string, catalog: string, schema: string, page: { readonly pageToken?: string }, signal: AbortSignal): Promise<Page<{ readonly name: string; readonly volumeType: string }>>
  /**
   * Every registered model in a schema (`GET /api/2.1/unity-catalog/models?catalog_name=&schema_name=`, operation
   * `unity-catalog.registered-models.list`, free). Package B follows `next_page_token` to its end — a page may hold zero
   * models and still carry a token (https://docs.databricks.com/api/uc-registered-models/v1/list-registered-models.md).
   */
  listModels(account: string, catalog: string, schema: string, signal: AbortSignal): Promise<readonly { readonly name: string; readonly fullName?: string }[]>
  /** UC effective permissions on a securable, for one `principal` when given; package B pages to the end. `USE_CONNECTION` is read with `{ type: "connection" }`. */
  effectivePermissions(account: string, securable: { readonly type: string; readonly fullName: string }, signal: AbortSignal, principal?: string): Promise<readonly { readonly principal: string; readonly privileges: readonly string[] }[]>
  /** UC connections (`unity-catalog.connections.list`). */
  listConnections(account: string, page: { readonly pageToken?: string }, signal: AbortSignal): Promise<Page<{ readonly name: string; readonly connectionType?: string }>>
  /** The workspace's current metastore assignment (`unity-catalog.current-metastore-assignment.get`): its default catalog. */
  currentMetastoreAssignment(account: string, signal: AbortSignal): Promise<{ readonly defaultCatalogName?: string }>
  /**
   * Unity Catalog tag assignments of a table, or of a table's columns (`unity-catalog.tag-assignments.list`). Package C
   * matches `inline.piiTags` against them; until package B implements this, C keeps refusing with DEPENDENCIES_UNKNOWN.
   */
  listTagAssignments(account: string, entity: { readonly type: "tables" | "columns"; readonly fullName: string }, signal: AbortSignal): Promise<readonly { readonly key: string; readonly value?: string; readonly column?: string }[]>
  // Saved queries (free; serialised: "10 or more" concurrent calls may be throttled).
  listQueries(account: string, page: { readonly pageToken?: string }, signal: AbortSignal): Promise<Page<{ readonly id: string; readonly name: string; readonly owner?: string; readonly warehouseId?: string; readonly queryText: string }>>
  getQuery(account: string, id: string, signal: AbortSignal): Promise<{ readonly id: string; readonly name: string; readonly warehouseId?: string; readonly queryText: string }>
  // Jobs (free reads; runs bill separately). Runs always carry `idempotency_token` (design §9).
  listJobs(account: string, page: { readonly pageToken?: string; readonly limit?: number }, signal: AbortSignal): Promise<Page<{ readonly jobId: number; readonly name: string; readonly creatorUserName?: string }>>
  /** One job's settings and each task's compute (`GET /api/2.2/jobs/get`, `jobs.jobs.get`). */
  getJob(account: string, jobId: number, signal: AbortSignal): Promise<JobInfo>
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
  /** The link's storage host is checked against the account's cloud (`AccountInfo.cloud`); `custom` allows every cloud's. */
  fetchLink(account: string, link: ExternalLink, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>
}

// ── the read path, shared (package C) ────────────────────────────────────

export interface ReadRequest {
  readonly account: string
  readonly sql: string
  readonly params?: readonly StatementParameter[]
  readonly warehouse?: string
  readonly catalog?: string
  readonly schema?: string
  /** The saved source: refuse unless the warehouse is already RUNNING (design §11.3). */
  readonly runningOnly?: boolean
  /** The call's own `wait`, in seconds: how long to wait for a STARTING warehouse. Defaults to the `wait` option. */
  readonly wait?: number
  /** The calling tool, for its table asserts (`databricks.<tool>` on `<account>:table:…`). */
  readonly tool: string
  readonly sessionID: string
  readonly messageID?: string
  readonly callID?: string
}

/** A read that passed §5.1 steps 1–5: the exact text to send and where. Step 6 (the submit) is the caller's. */
export interface PreparedRead {
  /** `analyzeRead(sql).sent`, unchanged. */
  readonly sent: string
  readonly warehouseId: string
  /** The warehouse as the guard last read it (RUNNING): its size, type and clusters, for cost text and the ledger. */
  readonly warehouse: Warehouse
  /** This call started the warehouse (STARTED_WAREHOUSE). */
  readonly started: boolean
  /** Resolved tables, `catalog.schema.table`. */
  readonly tables: readonly string[]
  /** `AccountInfo.enforcement`, read when the read was prepared. */
  readonly enforcement: EnforcementKind
  readonly warnings: readonly { readonly code: string; readonly message: string }[]
}

export interface ReadGuardPort {
  /** Refuses with the read path's codes (NEEDS_PLAN, PATH_NOT_DEFAULT, FENCED, INLINE_WITHHELD, WAREHOUSE_STOPPED, RUN_SIZE_REFUSED, …), or prepares. */
  prepare(request: ReadRequest, signal: AbortSignal): Promise<PreparedRead>
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
  /**
   * The warehouse starts this plugin charged for the account at or after `sinceMs`, oldest first: the ledger's own
   * `start` lines, read back (review of #10, request 4). Package F scopes its cleanup suggestions to them. `sessionId`
   * is empty for a start charged outside a session.
   */
  starts(account: string, sinceMs: number): Promise<readonly { readonly warehouseId: string; readonly atMs: number; readonly sessionId: string }[]>
}

export interface Clock {
  now(): number
  uuid(): string
}
