/**
 * The registry: one handler per tool, and who builds it (docs/ownership.md). Day 0 ships every handler as a stub that
 * does what every tool must do first, and nothing more:
 * 1. assert its own dotted action, `databricks.<tool>`, on `<account>:<operation>`, before any Databricks call;
 * 2. answer NOT_IMPLEMENTED.
 * `databricks_plan` for SQL and the commit tools' routing are real on Day 0: a plan is classified by the statement
 * table and stored, and a commit takes it once with the right tool (CATEGORY_MISMATCH otherwise). Running the commit
 * is package D's.
 *
 * A package replaces its stubs in its own file under src/tools/ and wires it here in one line (`HANDLERS`); it never
 * edits another package's file.
 */
import type { Access } from "./constants.js"
import { actionOf, COMMIT_TOOL, type Operation, operationResource, type ToolName, TOOLS } from "./domain/actions.js"
import { DatabricksError } from "./domain/errors.js"
import type { PlanStorePort } from "./domain/plans.js"
import { classifyPlan } from "./domain/statements.js"
import type { Options } from "./options.js"
import type { AuthPort, Clock, DatabricksPort, LedgerPort, PermissionPort, ReadGuardPort } from "./ports.js"
import { READ_HANDLERS } from "./tools/reads/index.js"
import type { Call, Handler, Handlers } from "./tool-spec.js"

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

/** Who builds each handler (design §16). */
export const OWNER: Readonly<Record<ToolName, "C" | "D" | "E" | "F">> = {
  status: "F",
  catalog: "C",
  table: "C",
  warehouses: "C",
  explain: "C",
  query: "C",
  statement: "C",
  history: "C",
  profile: "C",
  jobs: "D",
  workspace: "D",
  plan: "D",
  events_list: "E",
  saved_read: "E",
  save: "E",
  write: "D",
  delete: "D",
  share: "D",
  export: "D",
  run: "D",
  admin: "D",
  cancel: "D",
  stop: "D",
}

const accountOf = (input: unknown, deps: Deps): string => {
  const alias = (input as { account?: string }).account
  if (alias) return alias
  const accounts = Object.keys(deps.options.accounts ?? {})
  return accounts[0] ?? "default"
}

/** Step 1 of every tool: its own dotted action, on `<account>:<operation>`. */
export async function assertTool(tool: ToolName, account: string, call: Call, deps: Deps, operation: Operation = PRIMARY_OPERATION[tool]): Promise<void> {
  await deps.permission.assert({ action: actionOf(tool), resource: operationResource(account, operation), sessionID: call.sessionID, messageID: call.messageID, callID: call.id }, call.signal)
}

const stub = <T extends ToolName>(tool: T): Handler<T> =>
  (async (input, call, deps) => {
    await assertTool(tool, accountOf(input, deps), call, deps)
    throw new DatabricksError("NOT_IMPLEMENTED", `databricks_${tool} is declared but not built yet (package ${OWNER[tool]}).`)
  }) as Handler<T>

/** `databricks_plan` for SQL (Day 0): classify, store, preview. Target checks, jobs, notebooks and warehouses are D's. */
const plan: Handler<"plan"> = async (input, call, deps) => {
  const account = accountOf(input, deps)
  await assertTool("plan", account, call, deps)
  if (!input.sql) throw new DatabricksError("NOT_IMPLEMENTED", "Plans of jobs, notebooks and warehouse edits are not built yet (package D).")
  const classified = classifyPlan(input.sql)
  if (!classified.ok) throw new DatabricksError(classified.code, classified.detail)
  if (classified.category === "admin" && deps.options.admin.requireReason && !input.reason) throw new DatabricksError("ADMIN_REASON_REQUIRED")
  const warehouse = typeof input.warehouse === "string" ? input.warehouse : (deps.options.accounts?.[account]?.warehouse ?? "")
  if (!warehouse) throw new DatabricksError("WAREHOUSE_REQUIRED")
  const commitWith = `databricks_${COMMIT_TOOL[classified.category]}`
  const preview = {
    kind: classified.kind,
    parsed: classified.parsed,
    targets: [],
    tables: classified.tables.map((parts) => parts.join(".")),
    functions: [...classified.functions],
    notes: [...classified.notes, ...(classified.raisedBy.length ? [`Raised to run by ${classified.raisedBy.join(", ")}.`] : [])],
    ...(input.reason ? { reason: input.reason } : {}),
  }
  const stored = deps.plans.create({
    category: classified.category,
    kind: classified.kind,
    account,
    sessionId: call.sessionID,
    agentId: call.agent,
    payload: { kind: "sql", sql: input.sql, warehouse, ...(input.params ? { params: input.params } : {}), ...(input.catalog ? { catalog: input.catalog } : {}), ...(input.schema ? { schema: input.schema } : {}) },
    preview,
    fingerprint: { targets: preview.tables, warehouse },
    ...(input.reason ? { reason: input.reason } : {}),
  })
  return { state: "planned", planId: stored.id, expiresAt: new Date(stored.expiresAt).toISOString(), category: classified.category, commitWith, preview, next: `Show the preview, then ${commitWith}({ planId: "${stored.id}" }).` }
}

/** A commit tool on Day 0: assert, take the plan once with the right tool (routing), then NOT_IMPLEMENTED. */
const commit = <T extends "write" | "delete" | "share" | "export" | "run" | "admin">(tool: T): Handler<T> =>
  (async (input, call, deps) => {
    const peeked = deps.plans.peek(input.planId)
    const account = peeked?.plan.account ?? accountOf({}, deps)
    await assertTool(tool, account, call, deps)
    deps.plans.take(input.planId, tool, { sessionId: call.sessionID, agentId: call.agent, account })
    throw new DatabricksError("NOT_IMPLEMENTED", `Committing a ${tool} plan is not built yet (package D).`)
  }) as Handler<T>

/**
 * Every tool's handler. A package swaps its own entries here when it lands: `catalog`, `table`, `warehouses`, `explain`,
 * `query`, `statement`, `history` and `profile` are package C's (`src/tools/reads/`), and the rest are still Day 0 stubs.
 */
export const HANDLERS: Handlers = {
  status: stub("status"),
  catalog: READ_HANDLERS.catalog,
  table: READ_HANDLERS.table,
  warehouses: READ_HANDLERS.warehouses,
  explain: READ_HANDLERS.explain,
  query: READ_HANDLERS.query,
  statement: READ_HANDLERS.statement,
  history: READ_HANDLERS.history,
  profile: READ_HANDLERS.profile,
  jobs: stub("jobs"),
  workspace: stub("workspace"),
  plan,
  events_list: stub("events_list"),
  saved_read: stub("saved_read"),
  save: stub("save"),
  write: commit("write"),
  delete: commit("delete"),
  share: commit("share"),
  export: commit("export"),
  run: commit("run"),
  admin: commit("admin"),
  cancel: stub("cancel"),
  stop: stub("stop"),
}

/** The registry's tool names, in the table's order. */
export const REGISTERED: readonly ToolName[] = TOOLS.map((tool) => tool.name)
