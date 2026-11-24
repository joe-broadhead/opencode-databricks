/**
 * The domain contract: every tool's input and output schema (design §4), and the shapes they share. Day 0 fixes these;
 * the packages implement the handlers against them and may not change a schema without a review of this file
 * (docs/ownership.md). Every result has `state`, and on failure `error` (a code from src/domain/errors.ts), `message`
 * and `next` built only from the plugin's own words and validated identifiers; Databricks' text is only in
 * `providerError`. Every result that carries Databricks data has `trust: "untrusted"`.
 */
import * as z from "zod"
import { ACCESS_VALUES } from "../constants.js"
import { CODES, WARNINGS } from "./errors.js"
import type { ToolName } from "./actions.js"

// ── shared ───────────────────────────────────────────────────────────────

export const AccountInput = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, "an account alias: lower-case letters, digits and dashes").optional()

/** A warehouse id: hex, as Databricks issues them. */
export const WarehouseId = z.string().min(1).max(64).regex(/^[A-Za-z0-9-]+$/, "a warehouse id")

/** `catalog.schema.table`, each part a Unity Catalog name. */
export const FullName = z.string().min(5).max(767)

export const ResultState = z.enum(["ok", "running", "planned", "refused", "failed", "cancelled"])

export const ProviderErrorSchema = z.object({
  errorCode: z.string().optional(),
  sqlState: z.string().optional(),
  message: z.string().optional(),
  trust: z.literal("untrusted"),
})

const codes = CODES as [string, ...string[]]
const warningCodes = Object.keys(WARNINGS) as [string, ...string[]]

export const Warning = z.object({ code: z.enum(warningCodes), message: z.string() })

/** What every result carries. */
export const Base = {
  state: ResultState,
  error: z.enum(codes).optional(),
  message: z.string().optional(),
  next: z.string().optional(),
  warnings: z.array(Warning).optional(),
  providerError: ProviderErrorSchema.optional(),
  /** RATE_LIMITED: the seconds to wait before the same call. */
  retryAfterSec: z.number().min(0).optional(),
}

/** On every result that carries Databricks data; an error result carries none, so it may leave it out. */
export const Untrusted = { trust: z.literal("untrusted").optional() }

/** How a call is billed (design §4): control-plane REST, a running warehouse, or outside the warehouse. */
export const Billing = z.enum(["free", "warehouse", "separate"])

/**
 * Which guarantee holds for reads (design §3.4, §5.6). `"role"` is earned only by a doctor report from this process,
 * bound to the credential's host, role group and granted scopes, held in memory only, and cleared by any sign-in or
 * refresh that changes them; after a restart status says `"role-requested"` until `/databricks-doctor` runs again.
 *
 * Under **fine** scopes, `"role"` is earned over the Unity Catalog checks, and its wording names the exclusions: "SQL
 * writes refused on what doctor checked; secret scopes and serving endpoints not checked; job runs use each job's Run
 * as identity". Under `all-apis`, secret scopes and serving endpoints stay NOT_CHECKED and block `"role"`. (Decision
 * (a) on the review of package A, #5, ruling 1.)
 */
export const Enforcement = z.enum(["role", "role-requested", "identity", "service-principal"])
export type EnforcementKind = z.output<typeof Enforcement>

/** The wording of `"role"` under fine scopes (decision (a) on the review of #5). */
export const ROLE_ENFORCEMENT_TEXT = "SQL writes refused on what doctor checked; secret scopes and serving endpoints not checked; job runs use each job's Run as identity"

export const WarehouseState = z.enum(["STARTING", "RUNNING", "STOPPING", "STOPPED", "DELETING", "DELETED"])
export const WarehouseType = z.enum(["serverless", "pro", "classic"])
export const WarehouseSize = z.enum(["2X-Small", "X-Small", "Small", "Medium", "Large", "X-Large", "2X-Large", "3X-Large", "4X-Large"])

/** A named, typed statement parameter (`:name`); positional markers are refused (design §5.1). */
export const Param = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
  /** `null` is SQL NULL: sent without `value`, which the Statement Execution API reads as NULL. */
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  type: z.string().max(64).optional(),
})

export const Column = z.object({ name: z.string(), type: z.string(), nullable: z.boolean().optional(), comment: z.string().optional(), mask: z.string().optional() })

/** What a statement used of the warehouse. */
export const WarehouseUse = z.object({ id: WarehouseId, name: z.string().optional(), started: z.boolean(), usdPerHour: z.number().optional() })

export const Truncation = z.object({ rows: z.boolean().optional(), cells: z.boolean().optional(), bytes: z.boolean().optional() })

const SqlText = z.string().min(1).max(1024 * 1024)
const Wait = z.number().int().min(0).max(600)

// ── inputs ───────────────────────────────────────────────────────────────

export const Inputs = {
  status: z.strictObject({ account: AccountInput, include: z.array(z.enum(["spend"])).optional() }),
  catalog: z.strictObject({
    account: AccountInput,
    catalog: z.string().max(255).optional(),
    schema: z.string().max(255).optional(),
    filter: z.string().max(255).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    pageToken: z.string().max(4096).optional(),
  }),
  table: z.strictObject({
    account: AccountInput,
    name: FullName,
    sample: z.number().int().min(1).max(20).optional(),
    lineage: z.boolean().optional(),
    warehouse: WarehouseId.optional(),
    start: z.boolean().optional(),
  }),
  warehouses: z.strictObject({ account: AccountInput }),
  explain: z.strictObject({ account: AccountInput, sql: SqlText, params: z.array(Param).optional(), extended: z.boolean().optional(), warehouse: WarehouseId.optional(), catalog: z.string().optional(), schema: z.string().optional(), start: z.boolean().optional() }),
  query: z.strictObject({
    account: AccountInput,
    sql: SqlText,
    params: z.array(Param).optional(),
    warehouse: WarehouseId.optional(),
    catalog: z.string().max(255).optional(),
    schema: z.string().max(255).optional(),
    maxRows: z.number().int().min(1).max(500).optional(),
    wait: Wait.optional(),
    start: z.boolean().optional(),
  }),
  statement: z.strictObject({ account: AccountInput, statementId: z.string().min(1).max(128), chunk: z.number().int().min(0).optional(), wait: Wait.optional() }),
  history: z.strictObject({ account: AccountInput, since: z.string().max(40).optional(), status: z.enum(["QUEUED", "RUNNING", "FINISHED", "FAILED", "CANCELED"]).optional(), limit: z.number().int().min(1).max(100).optional() }),
  profile: z.strictObject({
    account: AccountInput,
    table: FullName.optional(),
    sql: SqlText.optional(),
    columns: z.array(z.string().max(255)).min(1).max(50),
    samplePercent: z.number().min(0.01).max(100).optional(),
    warehouse: WarehouseId.optional(),
    start: z.boolean().optional(),
  }),
  jobs: z.strictObject({ account: AccountInput, jobId: z.number().int().optional(), runId: z.number().int().optional(), output: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional(), pageToken: z.string().max(4096).optional() }),
  workspace: z.strictObject({ account: AccountInput, path: z.string().min(1).max(4096), export: z.boolean().optional() }),
  plan: z.strictObject({
    account: AccountInput,
    sql: SqlText.optional(),
    job: z.strictObject({ jobId: z.number().int(), params: z.record(z.string(), z.string()).optional() }).optional(),
    notebook: z.strictObject({ path: z.string().min(1).max(4096), params: z.record(z.string(), z.string()).optional() }).optional(),
    warehouse: z.union([WarehouseId, z.strictObject({ id: WarehouseId, edit: z.strictObject({ size: WarehouseSize.optional(), autoStopMinutes: z.number().int().min(0).max(10080).optional(), minClusters: z.number().int().min(1).optional(), maxClusters: z.number().int().min(1).optional(), statementTimeoutSeconds: z.number().int().min(0).optional() }) })]).optional(),
    params: z.array(Param).optional(),
    catalog: z.string().max(255).optional(),
    schema: z.string().max(255).optional(),
    reason: z.string().max(2000).optional(),
  }),
  events_list: z.strictObject({
    account: AccountInput,
    source: z.enum(["queries", "runs"]),
    cursor: z.string().max(65536).optional(),
    /** The contract input's `since` (review of #8, request 5): where a first read starts, with an offset. */
    since: z.string().datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    scope: z.record(z.string(), z.array(z.string())).optional(),
  }),
  saved_read: z.strictObject({ account: AccountInput, query: z.string().min(1).max(128), sha: z.string().regex(/^[0-9a-f]{64}$/) }),
  save: z.strictObject({
    account: AccountInput,
    sql: SqlText,
    params: z.array(Param).optional(),
    format: z.enum(["csv", "jsonl", "parquet", "arrow"]).optional(),
    path: z.string().max(4096).optional(),
    overwrite: z.boolean().optional(),
    warehouse: WarehouseId.optional(),
    catalog: z.string().max(255).optional(),
    schema: z.string().max(255).optional(),
    start: z.boolean().optional(),
  }),
  write: z.strictObject({ planId: z.string().min(1).max(128) }),
  delete: z.strictObject({ planId: z.string().min(1).max(128) }),
  share: z.strictObject({ planId: z.string().min(1).max(128) }),
  export: z.strictObject({ planId: z.string().min(1).max(128) }),
  run: z.strictObject({ planId: z.string().min(1).max(128) }),
  admin: z.strictObject({ planId: z.string().min(1).max(128) }),
  cancel: z.strictObject({ account: AccountInput, statementId: z.string().max(128).optional(), runId: z.number().int().optional() }),
  stop: z.strictObject({ account: AccountInput, warehouse: WarehouseId }),
} as const satisfies Record<ToolName, z.ZodType>

// ── outputs ──────────────────────────────────────────────────────────────

const AccountStatus = z.object({
  alias: z.string(),
  mode: z.enum(["interactive", "pat", "m2m", "cli"]),
  host: z.string().optional(),
  cloud: z.enum(["aws", "azure", "gcp", "custom"]).optional(),
  identity: z.object({ userName: z.string(), id: z.string(), displayName: z.string().optional() }).optional(),
  role: z.string().optional(),
  enforcement: Enforcement,
  writes: z.enum(["without asking", "ask", "never"]),
  scopes: z.array(z.string()),
  warehouse: z.object({ id: WarehouseId, state: WarehouseState, type: WarehouseType, size: z.string(), autoStopMinutes: z.number(), usdPerHour: z.number() }).optional(),
})

/**
 * `reconciled` (review of #10, request 3): today's billed DBUs for the default warehouse from `system.billing.usage`.
 * `complete` is always false: billing records arrive up to 12 hours late, and `usageDate` is a UTC date.
 */
const Spend = z.object({
  startsToday: z.number(),
  dbuHoursToday: z.number(),
  dbuHoursSession: z.number(),
  estimate: z.literal(true),
  budget: z.object({ state: z.enum(["off", "ok", "warn", "reached"]), limit: z.number().optional() }),
  reconciled: z.object({ warehouse: WarehouseId, usageDate: z.string(), dbu: z.number(), complete: z.literal(false) }).optional(),
})

/** Something this plugin started that is still running. `id` is the bare statement id or run id; `account` is its alias (review of #10, request 3). */
const Running = z.object({ kind: z.enum(["statement", "run"]), account: z.string(), id: z.string(), warehouse: z.string().optional(), startedAt: z.string(), tool: z.string() })

export const Outputs = {
  status: z.object({
    ...Base,
    access: z.enum(ACCESS_VALUES),
    accounts: z.array(AccountStatus),
    running: z.array(Running),
    spend: Spend.optional(),
    automation: z.object({ mode: z.enum(["auto", "on", "off"]), active: z.boolean(), owner: z.boolean() }),
    disclosure: z.string(),
    cleanup: z.array(z.object({ what: z.string(), usdPerHour: z.number().optional(), next: z.string() })).optional(),
  }),
  catalog: z.object({
    ...Base,
    ...Untrusted,
    level: z.enum(["catalogs", "schemas", "objects"]),
    items: z.array(z.object({ name: z.string(), kind: z.string(), comment: z.string().optional(), owner: z.string().optional(), format: z.string().optional(), updatedAt: z.string().optional() })),
    nextPageToken: z.string().optional(),
  }),
  table: z.object({
    ...Base,
    ...Untrusted,
    name: z.string(),
    tableType: z.string().optional(),
    format: z.string().optional(),
    comment: z.string().optional(),
    owner: z.string().optional(),
    columns: z.array(Column),
    partitionColumns: z.array(z.string()).optional(),
    rowFilter: z.string().optional(),
    viewDefinition: z.string().optional(),
    viewDependencies: z.array(z.object({ kind: z.string(), name: z.string() })).optional(),
    updatedAt: z.string().optional(),
    sample: z.object({ columns: z.array(z.string()), rows: z.array(z.array(z.unknown())) }).optional(),
    lineage: z.array(z.object({ source: z.string(), target: z.string(), at: z.string().optional() })).optional(),
    warehouse: WarehouseUse.optional(),
  }),
  warehouses: z.object({
    ...Base,
    items: z.array(z.object({
      id: WarehouseId,
      name: z.string(),
      type: WarehouseType,
      size: z.string(),
      state: WarehouseState,
      autoStopMinutes: z.number(),
      minClusters: z.number(),
      maxClusters: z.number(),
      statementTimeoutSeconds: z.number().optional(),
      dbuPerHour: z.number(),
      usdPerHour: z.number(),
      mayStart: z.boolean(),
      whyNot: z.string().optional(),
    })),
  }),
  explain: z.object({ ...Base, ...Untrusted, sent: z.string().optional(), operators: z.array(z.string()).optional(), tables: z.array(z.string()).optional(), warehouse: WarehouseUse.optional() }),
  query: z.object({
    ...Base,
    ...Untrusted,
    enforcement: Enforcement.optional(),
    columns: z.array(z.object({ name: z.string(), type: z.string() })).optional(),
    rows: z.array(z.array(z.unknown())).optional(),
    returned: z.number().optional(),
    totalRows: z.number().optional(),
    truncated: Truncation.optional(),
    statementId: z.string().optional(),
    warehouse: WarehouseUse.optional(),
    durationMs: z.number().optional(),
  }),
  statement: z.object({ ...Base, ...Untrusted, statementId: z.string(), status: z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED", "CLOSED"]).optional(), columns: z.array(z.object({ name: z.string(), type: z.string() })).optional(), rows: z.array(z.array(z.unknown())).optional(), chunk: z.number().optional(), nextChunk: z.number().optional() }),
  history: z.object({ ...Base, ...Untrusted, items: z.array(z.object({ id: z.string(), status: z.string(), statementType: z.string().optional(), warehouse: z.string().optional(), durationMs: z.number().optional(), rows: z.number().optional(), readBytes: z.number().optional(), tags: z.record(z.string(), z.string()).optional(), sql: z.string().optional() })) }),
  profile: z.object({ ...Base, ...Untrusted, rows: z.number().optional(), columns: z.array(z.object({ name: z.string(), nulls: z.number().optional(), distinct: z.number().optional(), min: z.unknown().optional(), max: z.unknown().optional(), percentiles: z.array(z.unknown()).optional(), top: z.array(z.object({ value: z.unknown(), count: z.number() })).optional() })).optional(), statementId: z.string().optional(), warehouse: WarehouseUse.optional() }),
  jobs: z.object({ ...Base, ...Untrusted, jobs: z.array(z.object({ id: z.number(), name: z.string(), creator: z.string().optional(), schedule: z.string().optional(), lastRunState: z.string().optional() })).optional(), runs: z.array(z.object({ id: z.number(), state: z.string(), startedAt: z.string().optional(), durationMs: z.number().optional() })).optional(), run: z.object({ id: z.number(), tasks: z.array(z.object({ key: z.string(), state: z.string(), durationMs: z.number().optional(), error: z.string().optional() })), output: z.string().optional() }).optional(), nextPageToken: z.string().optional() }),
  workspace: z.object({ ...Base, ...Untrusted, items: z.array(z.object({ path: z.string(), kind: z.string(), size: z.number().optional(), modifiedAt: z.string().optional() })).optional(), source: z.string().optional(), cut: z.boolean().optional() }),
  plan: z.object({
    ...Base,
    planId: z.string().optional(),
    expiresAt: z.string().optional(),
    category: z.enum(["write", "delete", "share", "export", "run", "admin"]).optional(),
    commitWith: z.string().optional(),
    preview: z.object({
      kind: z.string(),
      parsed: z.boolean(),
      targets: z.array(z.object({ name: z.string(), type: z.string().optional(), owner: z.string().optional(), exists: z.boolean().optional() })),
      tables: z.array(z.string()),
      functions: z.array(z.string()),
      warehouse: WarehouseUse.optional(),
      notes: z.array(z.string()),
      reason: z.string().optional(),
    }).optional(),
  }),
  /** The source contract's events page, as the RPC method answers it (review of #8: the widened output). */
  events_list: z.object({
    ...Base,
    ...Untrusted,
    source: z.enum(["queries", "runs"]).optional(),
    account: z.string().optional(),
    owner: z.object({ id: z.string(), label: z.string() }).optional(),
    events: z.array(z.unknown()),
    cursor: z.string().optional(),
    more: z.boolean().optional(),
    scope: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
    gap: z.object({ reason: z.enum(["window-truncated", "expired"]), since: z.string() }).optional(),
    failed: z.array(z.unknown()).optional(),
    refused: z.array(z.unknown()).optional(),
    plugin: z.string().optional(),
  }),
  saved_read: z.object({ ...Base, ...Untrusted, table: z.object({ columns: z.array(z.string()).max(8), rows: z.array(z.array(z.unknown())).max(100) }).optional(), cost: z.object({ class: z.literal("billed"), warehouse: z.object({ id: z.string(), name: z.string(), usdPerHour: z.number() }) }).optional() }),
  save: z.object({ ...Base, path: z.string().optional(), format: z.enum(["csv", "jsonl", "parquet", "arrow"]).optional(), rows: z.number().optional(), bytes: z.number().optional(), sha256: z.string().optional(), statementId: z.string().optional(), warehouse: WarehouseUse.optional(), charts: z.object({ path: z.string(), format: z.string(), rows: z.number(), fitsCharts: z.boolean() }).optional() }),
  write: z.object({ ...Base, statementId: z.string().optional(), rowsAffected: z.number().optional(), durationMs: z.number().optional(), warehouse: WarehouseUse.optional() }),
  delete: z.object({ ...Base, statementId: z.string().optional(), rowsAffected: z.number().optional(), durationMs: z.number().optional(), warehouse: WarehouseUse.optional() }),
  share: z.object({ ...Base, statementId: z.string().optional(), durationMs: z.number().optional(), warehouse: WarehouseUse.optional() }),
  export: z.object({ ...Base, statementId: z.string().optional(), rowsAffected: z.number().optional(), durationMs: z.number().optional(), warehouse: WarehouseUse.optional() }),
  run: z.object({ ...Base, statementId: z.string().optional(), runId: z.number().optional(), durationMs: z.number().optional(), warehouse: WarehouseUse.optional() }),
  admin: z.object({ ...Base, statementId: z.string().optional(), durationMs: z.number().optional(), warehouse: WarehouseUse.optional() }),
  cancel: z.object({ ...Base, cancelled: z.string().optional() }),
  stop: z.object({ ...Base, warehouse: WarehouseId.optional(), stopped: z.boolean().optional() }),
} as const satisfies Record<ToolName, z.ZodType>

export type Input<T extends ToolName> = z.output<(typeof Inputs)[T]>
export type Output<T extends ToolName> = z.output<(typeof Outputs)[T]>

/** The §5.6 write disclosure and the masks-and-filters disclosure (review round 3, LOW 1), from src/disclosures.ts. */
export { POLICY_DISCLOSURE, WRITE_DISCLOSURE } from "../disclosures.js"
