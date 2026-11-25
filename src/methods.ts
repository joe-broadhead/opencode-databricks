/**
 * The one method table (contract §6): every callable, its class, its operations and the plan/commit pairs. The
 * capabilities manifest in package.json is the source of truth for consumers; this module is the code's view of the
 * same table, and a unit test compares the two so they cannot drift.
 */
import { NAMESPACE } from "./constants.js"

export type MethodClass = "read" | "write" | "send" | "share" | "delete" | "export" | "admin"
export type Category = "write" | "delete" | "share" | "export" | "run" | "admin"
export type Feature = "jobs" | "workspace" | "files"

export interface MethodEntry {
  readonly name: string
  readonly class: MethodClass
  readonly accounts: "optional" | "none"
  readonly operations: readonly string[]
  readonly plans?: true
  readonly commits?: Category
  readonly effect?: "ask" | "deny"
  readonly description: string
}

const READ_PATH = ["unity-catalog.tables.get", "unity-catalog.functions.get", "sql.warehouses.get"] as const
const CHANGE_PATH = [
  "unity-catalog.tables.get",
  "unity-catalog.tables.list",
  "unity-catalog.schemas.list",
  "unity-catalog.functions.list",
  "unity-catalog.functions.get",
  "unity-catalog.volumes.list",
  "unity-catalog.registered-models.list",
  "sql.warehouses.get",
  "sql.history.queries.list",
] as const

const unique = (values: readonly string[]): string[] => [...new Set(values)]

/** Every read a plan may make; a plan's class is its own, so one list covers the six plan methods. */
const PLAN_OPERATIONS = unique([
  "unity-catalog.tables.get",
  "unity-catalog.schemas.list",
  "unity-catalog.tables.list",
  "unity-catalog.functions.list",
  "unity-catalog.volumes.list",
  "unity-catalog.registered-models.list",
  "sql.warehouses.get",
  "jobs.jobs.get",
  "workspace.objects.list",
])

export const METHODS = [
  {
    name: "status",
    class: "read",
    accounts: "none",
    operations: ["scim.me.get", "sql.warehouses.list", "sql.warehouses.get", "sql.history.queries.list"],
    description: "The plugin's state, host range, account aliases and their sign-in state.",
  },
  {
    name: "catalog",
    class: "read",
    accounts: "optional",
    operations: ["unity-catalog.catalogs.list", "unity-catalog.schemas.list", "unity-catalog.tables.list", "unity-catalog.functions.list", "unity-catalog.volumes.list"],
    description: "Browse Unity Catalog: catalogs, schemas, then tables, functions and volumes. Free; no warehouse.",
  },
  {
    name: "table",
    class: "read",
    accounts: "optional",
    operations: unique([...READ_PATH, "sql.statements.query"]),
    description: "One table or view: columns, masks, row filter, view definition and dependencies; optionally a small sample or lineage.",
  },
  {
    name: "warehouses",
    class: "read",
    accounts: "optional",
    operations: ["sql.warehouses.list"],
    description: "SQL warehouses you can see, with state, size, auto-stop and an estimated cost per hour.",
  },
  {
    name: "explain",
    class: "read",
    accounts: "optional",
    operations: unique([...READ_PATH, "sql.statements.query"]),
    description: "Validate a read without running it: EXPLAIN of the wrapped query, cancelled by Databricks at 50 seconds.",
  },
  {
    name: "query",
    class: "read",
    accounts: "optional",
    operations: unique([...READ_PATH, "sql.statements.query"]),
    description: "Run one read-only query through the read path, with a row and byte cap, on a warehouse that is already running.",
  },
  {
    name: "statement",
    class: "read",
    accounts: "optional",
    operations: ["sql.statements.get", "sql.statements.cancel"],
    description: "One statement this account started: its state, error and next result chunk.",
  },
  {
    name: "history",
    class: "read",
    accounts: "optional",
    operations: ["scim.me.get", "sql.history.queries.list"],
    description: "Your own recent statements from Query History: status, type, duration and the start of the SQL.",
  },
  {
    name: "profile",
    class: "read",
    accounts: "optional",
    operations: unique([...READ_PATH, "sql.statements.query"]),
    description: "One aggregate query that summarises chosen columns of a table or a query, instead of rows.",
  },
  {
    name: "jobs",
    class: "read",
    accounts: "optional",
    operations: ["jobs.jobs.list", "jobs.runs.list", "jobs.runs.get", "jobs.runs.output.get"],
    description: "Jobs, their runs, and one run's tasks and output.",
  },
  {
    name: "workspace",
    class: "read",
    accounts: "optional",
    operations: ["workspace.objects.list", "workspace.objects.get", "files.directories.list"],
    description: "List workspace folders and notebooks, export a notebook's source, and list volume paths. Never writes.",
  },
  {
    name: "plan_write",
    class: "read",
    accounts: "optional",
    plans: true,
    operations: PLAN_OPERATIONS,
    description: "Plan a write change: dry-run it, check its targets and answer the preview. Sends no statement.",
  },
  {
    name: "plan_delete",
    class: "read",
    accounts: "optional",
    plans: true,
    operations: PLAN_OPERATIONS,
    description: "Plan a delete change: dry-run it, check its targets and answer the preview. Sends no statement.",
  },
  {
    name: "plan_share",
    class: "read",
    accounts: "optional",
    plans: true,
    operations: PLAN_OPERATIONS,
    description: "Plan a share change: dry-run it, check its targets and answer the preview. Sends no statement.",
  },
  {
    name: "plan_export",
    class: "read",
    accounts: "optional",
    plans: true,
    operations: PLAN_OPERATIONS,
    description: "Plan a export change: dry-run it, check its targets and answer the preview. Sends no statement.",
  },
  {
    name: "plan_run",
    class: "read",
    accounts: "optional",
    plans: true,
    operations: PLAN_OPERATIONS,
    description: "Plan a run change: dry-run it, check its targets and answer the preview. Sends no statement.",
  },
  {
    name: "plan_admin",
    class: "read",
    accounts: "optional",
    plans: true,
    operations: PLAN_OPERATIONS,
    description: "Plan a admin change: dry-run it, check its targets and answer the preview. Sends no statement.",
  },
  {
    name: "events_list",
    class: "read",
    accounts: "optional",
    operations: ["sql.history.queries.list", "scim.me.get", "jobs.runs.list", "jobs.runs.get"],
    description: "The databricks.queries and databricks.runs event sources.",
  },
  {
    name: "saved_read",
    class: "read",
    accounts: "optional",
    operations: ["sql.queries.get", "sql.warehouses.get", "sql.statements.query", "sql.statements.get", "scim.me.get"],
    description: "The databricks.saved snapshot: one saved SQL query, read only on a warehouse that is already running.",
  },
  {
    name: "save",
    class: "export",
    accounts: "optional",
    operations: unique([...READ_PATH, "sql.statements.query", "sql.statements.get"]),
    description: "Run a read through the read path and stream the full result to a file under the results directory.",
  },
  {
    name: "write",
    class: "write",
    accounts: "optional",
    commits: "write",
    operations: unique([...CHANGE_PATH, "sql.statements.change"]),
    description: "Commit a write plan: { planId } only.",
  },
  {
    name: "delete",
    class: "delete",
    accounts: "optional",
    commits: "delete",
    operations: unique([...CHANGE_PATH, "sql.statements.change"]),
    description: "Commit a delete plan: { planId } only.",
  },
  {
    name: "share",
    class: "share",
    accounts: "optional",
    commits: "share",
    operations: unique([...CHANGE_PATH, "sql.statements.change"]),
    description: "Commit a share plan (grants, owners, masks, filters, tags): { planId } only.",
  },
  {
    name: "export",
    class: "export",
    accounts: "optional",
    commits: "export",
    operations: unique([...CHANGE_PATH, "sql.statements.change"]),
    description: "Commit an export plan, where data leaves the governed boundary: { planId } only.",
  },
  {
    name: "run",
    class: "delete",
    accounts: "optional",
    commits: "run",
    operations: unique([...CHANGE_PATH, "sql.statements.change", "jobs.jobs.get", "jobs.jobs.runNow", "jobs.runs.submit"]),
    description: "Commit a run plan: a SQL script, EXECUTE IMMEDIATE or CALL, a job run, or a one-time notebook run: { planId } only.",
  },
  {
    name: "admin",
    class: "admin",
    accounts: "optional",
    commits: "admin",
    operations: unique([...CHANGE_PATH, "sql.statements.change", "sql.warehouses.edit"]),
    description: "Commit an admin plan (connections, credentials, locations, warehouse edits): { planId } only.",
  },
  {
    name: "cancel",
    class: "write",
    accounts: "optional",
    operations: ["sql.statements.get", "sql.statements.cancel", "jobs.runs.cancel", "scim.me.get", "sql.history.queries.list", "jobs.runs.get"],
    description: "Cancel a statement or job run that this account started.",
  },
  {
    name: "stop",
    class: "write",
    accounts: "optional",
    operations: ["sql.warehouses.get", "scim.me.get", "sql.history.queries.list", "sql.warehouses.stop"],
    description: "Stop a SQL warehouse; refused while another user's statement runs on it.",
  },
  {
    name: "start",
    class: "write",
    accounts: "optional",
    operations: ["sql.warehouses.get", "sql.warehouses.start"],
    description: "Start a stopped SQL warehouse. It bills until it auto-stops.",
  },
  {
    name: "probe",
    class: "read",
    accounts: "optional",
    operations: ["scim.me.get"],
    description: "Who the account is, for a source's consent: reads no content.",
  },
  {
    name: "saved_list",
    class: "read",
    accounts: "optional",
    operations: ["sql.queries.list"],
    description: "Your saved SQL queries as id#sha256 options, for binding the databricks.saved source.",
  },
] as const satisfies readonly MethodEntry[]

export type MethodName = (typeof METHODS)[number]["name"]

export const METHOD_NAMES: readonly MethodName[] = METHODS.map((method) => method.name)

export const methodOf = (name: MethodName): MethodEntry => METHODS.find((method) => method.name === name)! as unknown as MethodEntry
export const actionOf = (method: string): string => `${NAMESPACE}.${method}`

/** The commit method for each plan category. */
export const COMMIT_TOOL: Readonly<Record<Category, MethodName>> = {
  write: "write",
  delete: "delete",
  share: "share",
  export: "export",
  run: "run",
  admin: "admin",
}
export const categoryOf = (method: MethodName): Category | undefined => methodOf(method).commits

/** The resource a table assert names. */
export const tableResource = (account: string, catalog: string, schema: string, table: string) => `${account}:table:${catalog}.${schema}.${table}`
/** The resource a warehouse names. */
export const warehouseResource = (account: string, id: string) => `${account}:warehouse:${id}`
/** The resource an operation names: `<account>:<operation>` (contract §6). */
export const operationResource = (account: string, operation: string) => `${account}:${operation}`

/** The operations the provider client may name, for the scope table and the tests. */
export const OPERATIONS = [
  "sql.statements.query",
  "sql.statements.get",
  "sql.statements.change",
  "sql.statements.cancel",
  "sql.warehouses.list",
  "sql.warehouses.get",
  "sql.warehouses.start",
  "sql.warehouses.stop",
  "sql.warehouses.edit",
  "sql.history.queries.list",
  "sql.queries.list",
  "sql.queries.get",
  "unity-catalog.catalogs.list",
  "unity-catalog.schemas.list",
  "unity-catalog.tables.list",
  "unity-catalog.tables.get",
  "unity-catalog.table-summaries.list",
  "unity-catalog.functions.list",
  "unity-catalog.functions.get",
  "unity-catalog.volumes.list",
  "unity-catalog.registered-models.list",
  "unity-catalog.effective-permissions.get",
  "unity-catalog.connections.list",
  "unity-catalog.current-metastore-assignment.get",
  "unity-catalog.tag-assignments.list",
  "jobs.jobs.list",
  "jobs.jobs.get",
  "jobs.runs.list",
  "jobs.runs.get",
  "jobs.runs.output.get",
  "jobs.jobs.runNow",
  "jobs.runs.submit",
  "jobs.runs.cancel",
  "workspace.objects.list",
  "workspace.objects.get",
  "files.directories.list",
  "scim.me.get",
] as const

export type Operation = (typeof OPERATIONS)[number]

/** The API scope each operation needs, or `any`. Checked before any call. */
export const SCOPE_OF: Readonly<Record<Operation, string>> = Object.fromEntries(
  OPERATIONS.map((operation) => [
    operation,
    operation.startsWith("sql.history.")
      ? "query-history"
      : operation.startsWith("sql.")
        ? "sql"
        : operation.startsWith("unity-catalog.")
          ? "unity-catalog"
          : operation.startsWith("jobs.")
            ? "jobs"
            : operation.startsWith("workspace.")
              ? "workspace"
              : operation.startsWith("files.")
                ? "files"
                : "any",
  ]),
) as Record<Operation, string>
