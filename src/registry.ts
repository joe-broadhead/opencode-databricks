/**
 * The registry: one handler per tool (docs/ownership.md). Every handler is built in its own file under `src/tools/`,
 * `src/sources/` or `src/status.ts`, and wired here in one line (`HANDLERS`); the shared step every tool runs first is
 * `assertTool`, which asserts its own dotted action, `databricks.<tool>`, on `<account>:<operation>` before any
 * Databricks call.
 */
import type { Access } from "./constants.js"
import { actionOf, COMMIT_TOOL, type Operation, operationResource, type ToolName, TOOLS } from "./domain/actions.js"
import type { PlanStorePort } from "./domain/plans.js"
import { classifyPlan } from "./domain/statements.js"
import type { Options } from "./options.js"
import type { AuthPort, Clock, DatabricksPort, LedgerPort, PermissionPort, ReadGuardPort } from "./ports.js"
import { statusHandler } from "./status.js"
import { CHANGE_HANDLERS } from "./tools/changes/index.js"
import { READ_HANDLERS } from "./tools/reads/index.js"
import save from "./tools/save/index.js"
import { SOURCE_HANDLERS } from "./sources/index.js"
import type { Call, Handlers } from "./tool-spec.js"

export interface Deps {
  readonly options: Options
  readonly access: Access
  readonly auth: AuthPort
  readonly databricks: DatabricksPort
  /** The shared read path (package C). */
  readonly reads: ReadGuardPort
  readonly ledger: LedgerPort
  readonly plans: PlanStorePort
  readonly permission: PermissionPort
  readonly clock: Clock
  /** Whether this process holds the machine's automation lock; status reports it. */
  readonly automationOwner?: () => boolean
}

/** The operation each tool asserts first (design §10.1). Sources and commits may assert more later. */
export const PRIMARY_OPERATION: Readonly<Record<ToolName, Operation>> = {
  status: "scim.me.get",
  catalog: "unity-catalog.catalogs.list",
  table: "unity-catalog.tables.get",
  warehouses: "sql.warehouses.list",
  explain: "sql.statements.query",
  query: "sql.statements.query",
  statement: "sql.statements.get",
  history: "sql.history.queries.list",
  profile: "sql.statements.query",
  jobs: "jobs.runs.list",
  workspace: "workspace.objects.list",
  plan: "unity-catalog.tables.get",
  events_list: "sql.history.queries.list",
  saved_read: "sql.queries.get",
  save: "sql.statements.query",
  write: "sql.statements.change",
  delete: "sql.statements.change",
  share: "sql.statements.change",
  export: "sql.statements.change",
  run: "sql.statements.change",
  admin: "sql.statements.change",
  cancel: "sql.statements.get",
  stop: "sql.warehouses.stop",
}

/** Step 1 of every tool: its own dotted action, on `<account>:<operation>`. */
export async function assertTool(tool: ToolName, account: string, call: Call, deps: Deps, operation: Operation = PRIMARY_OPERATION[tool]): Promise<void> {
  await deps.permission.assert({ action: actionOf(tool), resource: operationResource(account, operation), sessionID: call.sessionID, messageID: call.messageID, callID: call.id }, call.signal)
}

/**
 * Every tool's handler: the eight reads (`src/tools/reads/`), package D's plan, the six commit tools, `cancel`, `stop`,
 * `jobs` and `workspace` (`src/tools/changes/`), the two sources and `saved_read`, `save`, status and the two
 * permission-only source actions.
 */
export const HANDLERS: Handlers = {
  status: statusHandler,
  catalog: READ_HANDLERS.catalog,
  table: READ_HANDLERS.table,
  warehouses: READ_HANDLERS.warehouses,
  explain: READ_HANDLERS.explain,
  query: READ_HANDLERS.query,
  statement: READ_HANDLERS.statement,
  history: READ_HANDLERS.history,
  profile: READ_HANDLERS.profile,
  jobs: CHANGE_HANDLERS.jobs,
  workspace: CHANGE_HANDLERS.workspace,
  plan: CHANGE_HANDLERS.plan,
  events_list: SOURCE_HANDLERS.events_list,
  saved_read: SOURCE_HANDLERS.saved_read,
  save,
  write: CHANGE_HANDLERS.write,
  delete: CHANGE_HANDLERS.delete,
  share: CHANGE_HANDLERS.share,
  export: CHANGE_HANDLERS.export,
  run: CHANGE_HANDLERS.run,
  admin: CHANGE_HANDLERS.admin,
  cancel: CHANGE_HANDLERS.cancel,
  stop: CHANGE_HANDLERS.stop,
}

/** The registry's tool names, in the table's order. */
export const REGISTERED: readonly ToolName[] = TOOLS.map((tool) => tool.name)
