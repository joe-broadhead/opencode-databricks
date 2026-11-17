/**
 * The 23 tools and the actions they assert (design §4, §10.1). This table is the one list: the registry, the default
 * rules, the jelly declaration, the tools RPC and the docs all derive from it, and tests check each against it.
 *
 * - The engine name is `databricks_<tool>`; the permission action each tool asserts is `databricks.<tool>` (dotted, the
 *   name Jelly declares and rules). Asserted equals declared: a test runs every tool against the fakes and records what
 *   it asserts.
 * - `databricks.start` and `databricks.probe` are permission-only: actions the plugin asserts that are not tools. They
 *   are declared in `jelly.tools` so Jelly's rules give them their intended effects (design §10.2).
 * - Data tools also assert each resolved table as `<account>:table:<catalog>.<schema>.<table>` under their own action.
 */
import { NAMESPACE } from "../constants.js"

export type ToolClass = "read" | "export" | "write" | "destructive"

/** A plan's category, and the commit tool that runs it (design §5.5). */
export type Category = "write" | "delete" | "share" | "export" | "run" | "admin"

export type Feature = "jobs" | "workspace" | "files"

export interface ToolEntry {
  readonly name: string
  readonly class: ToolClass
  readonly readOnly: boolean
  /** The plan category this commit tool runs; commit tools only. */
  readonly commits?: Category
  /** An opt-in API family the tool needs (design §3.3). */
  readonly feature?: readonly Feature[]
  /** Whether scripts and sources may call it through the tools RPC (reads only; design §4). */
  readonly rpc: boolean
  readonly description: string
  /** Shown on Jelly's card; at most 200 characters. */
  readonly note?: string
}

const DISCLOSURE = "At Allowed, the agent can change or delete anything your Databricks identity can, after a plan it makes itself. For a hard limit, sign in with a read-only role."

export const TOOLS = [
  { name: "status", class: "read", readOnly: true, rpc: true, description: "Accounts, identity, enforcement, the default warehouse and its cost, what this plugin has running, spend estimates and automation state." },
  { name: "catalog", class: "read", readOnly: true, rpc: true, description: "Browse Unity Catalog: catalogs, schemas, then tables, functions and volumes. Free; no warehouse." },
  { name: "table", class: "read", readOnly: true, rpc: true, description: "One table or view: columns, masks, row filter, view definition and dependencies; optionally a small sample or lineage." },
  { name: "warehouses", class: "read", readOnly: true, rpc: true, description: "SQL warehouses you can see, with state, size, auto-stop, an estimated cost per hour, and whether this plugin may start each." },
  { name: "explain", class: "read", readOnly: true, rpc: true, description: "Validate a read without running it: EXPLAIN of the wrapped query, cancelled by Databricks at 50 seconds." },
  { name: "query", class: "read", readOnly: true, rpc: true, description: "Run one read-only query through the read path, with a row and byte cap, on a running warehouse unless start is true." },
  { name: "statement", class: "read", readOnly: true, rpc: true, description: "One statement this account started: its state, error and next result chunk." },
  { name: "history", class: "read", readOnly: true, rpc: true, description: "Your own recent statements from Query History: status, type, duration and the start of the SQL." },
  { name: "profile", class: "read", readOnly: true, rpc: true, description: "One aggregate query that summarises chosen columns of a table or a query, instead of rows." },
  { name: "jobs", class: "read", readOnly: true, feature: ["jobs"], rpc: true, description: "Jobs, their runs, and one run's tasks and output. Needs the jobs feature." },
  { name: "workspace", class: "read", readOnly: true, feature: ["workspace", "files"], rpc: true, description: "List workspace folders and notebooks, export a notebook's source, and list volume paths. Never writes." },
  { name: "plan", class: "read", readOnly: true, rpc: true, description: "Plan a change (SQL, a job run, a notebook run or a warehouse edit) and get a single-use planId with its preview. Sends no statement." },
  { name: "events_list", class: "read", readOnly: true, rpc: true, description: "The databricks.queries and databricks.runs event sources." },
  { name: "saved_read", class: "read", readOnly: true, rpc: true, description: "The databricks.saved snapshot: one saved SQL query, read only on a warehouse that is already running." },
  { name: "save", class: "export", readOnly: false, rpc: false, description: "Run a read through the read path and stream the full result to a file (csv, jsonl, parquet or arrow).", note: "Writes query results to a file on this machine" },
  { name: "write", class: "write", readOnly: false, commits: "write", rpc: false, description: "Commit a write plan: { planId } only.", note: DISCLOSURE },
  { name: "delete", class: "destructive", readOnly: false, commits: "delete", rpc: false, description: "Commit a delete plan: { planId } only.", note: "Deletes, drops, overwrites and vacuums. Runs without asking at Allowed; asks every time at Ask before changes" },
  { name: "share", class: "write", readOnly: false, commits: "share", rpc: false, description: "Commit a share plan (grants, owners, masks, filters, tags): { planId } only." },
  { name: "export", class: "export", readOnly: false, commits: "export", rpc: false, description: "Commit an export plan, where data leaves the governed boundary: { planId } only." },
  { name: "run", class: "destructive", readOnly: false, commits: "run", rpc: false, description: "Commit a run plan: a SQL script, EXECUTE IMMEDIATE or CALL, a job run, or a one-time notebook run: { planId } only.", note: "Runs jobs, notebooks and SQL scripts. Runs without asking at Allowed; asks every time at Ask before changes" },
  { name: "admin", class: "write", readOnly: false, commits: "admin", rpc: false, description: "Commit an admin plan (connections, credentials, locations, warehouse edits): { planId } only." },
  { name: "cancel", class: "write", readOnly: false, rpc: false, description: "Cancel a statement or job run that this account started." },
  { name: "stop", class: "write", readOnly: false, rpc: false, description: "Stop a SQL warehouse; refused while another user's statement runs on it.", note: "Stops a SQL warehouse the agent finds idle; never ends other people's queries" },
] as const satisfies readonly ToolEntry[]

export type ToolName = (typeof TOOLS)[number]["name"]

export const TOOL_NAMES: readonly ToolName[] = TOOLS.map((tool) => tool.name)

/** The engine's tool name. */
export const engineName = (tool: string) => `${NAMESPACE}_${tool}`
/** The permission action a tool asserts. */
export const actionOf = (tool: string) => `${NAMESPACE}.${tool}`

/** Actions the plugin asserts that are not tools (design §10.2). */
export const PERMISSION_ONLY = [
  { action: "databricks.start", effect: "ask", readOnly: true, note: "Starts a stopped SQL warehouse, which bills until it auto-stops" },
  { action: "databricks.probe", effect: "allow", readOnly: true },
] as const

export const START_ACTION = "databricks.start"
export const PROBE_ACTION = "databricks.probe"

/** Every action the plugin declares: the 23 tools and the two permission-only entries. */
export const DECLARED_ACTIONS: readonly string[] = [...TOOLS.map((tool) => actionOf(tool.name)), ...PERMISSION_ONLY.map((entry) => entry.action)]

/** The tools RPC's methods: every read, plus `probe` and `saved_list` (the snapshot's scope.suggest). Never a change. */
export const RPC_METHODS: readonly string[] = [...TOOLS.filter((tool) => tool.rpc).map((tool) => tool.name), "probe", "saved_list"]

/** The commit tool for each plan category. */
export const COMMIT_TOOL: Readonly<Record<Category, ToolName>> = { write: "write", delete: "delete", share: "share", export: "export", run: "run", admin: "admin" }

/** Commit tools that never offer "Always" at ask-changes (gws parity, design §5.5). */
export const NO_ALWAYS: readonly ToolName[] = ["delete", "run"]

/** The resource a table assert names. */
export const tableResource = (account: string, catalog: string, schema: string, table: string) => `${account}:table:${catalog}.${schema}.${table}`
/** The resource a warehouse start or stop names. */
export const warehouseResource = (account: string, id: string) => `${account}:warehouse:${id}`
/** The resource an operation names: `<account>:<operation>` (design §10.1). */
export const operationResource = (account: string, operation: string) => `${account}:${operation}`

/** The operation ids (design §10.1). Each read ends in a read verb, so the source contract's verb rule holds. */
export const OPERATIONS = [
  "sql.statements.query",
  "sql.statements.get",
  "sql.statements.change",
  "sql.warehouses.list",
  "sql.warehouses.get",
  "sql.warehouses.start",
  "sql.warehouses.stop",
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
  "unity-catalog.effective-permissions.get",
  "unity-catalog.connections.list",
  "unity-catalog.current-metastore-assignment.get",
  "unity-catalog.tag-assignments.list",
  "jobs.jobs.list",
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

/** The API scope each operation needs (design §3.3), or `any`. Checked before any call (`AUTH_SCOPE_MISSING`). */
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
                : // SCIM Me is reachable with any scoped token [30].
                  "any",
  ]),
) as Record<Operation, string>
