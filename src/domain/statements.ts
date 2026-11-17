/**
 * The statement table (design §5.5): every statement form the pinned grammar parses, mapped to a plan category or a
 * refusal, and the token rules that can only raise a category. One table, so `databricks_plan` (package D) and the
 * read path (package C) never disagree. Pure: no network.
 *
 * - The parser's category is final; the token rules (`EXECUTE IMMEDIATE`, `CALL`, `IDENTIFIER` anywhere) only raise it.
 * - Text the pinned grammar cannot parse is `run`, the strictest, with "not parsed" in the preview. That includes
 *   Delta's and Databricks' own statements (VACUUM, OPTIMIZE, RESTORE, COPY INTO, CREATE STREAMING TABLE, REORG, FSCK,
 *   GRANT … ON, DENY, ALTER … OWNER TO, SET ROW FILTER, SET MASK, SET TAGS): stricter than their row in §5.5's table
 *   until Delta's grammar is pinned (a v0.2.0 item).
 * - A query is a read: CATEGORY_MISMATCH, unless it calls a function that needs a plan (§5.2's side-effecting reads).
 */
import { type ParserRuleContext, TerminalNode } from "antlr4ng"
import { analyzeRead, SESSION_STATEMENTS, statementKind, textRules, walk } from "../sql/analyze.js"
import { SqlBaseLexer } from "../sql/generated/SqlBaseLexer.js"
import { contextName, lex, parseStatement } from "../sql/parse.js"
import type { Category } from "./actions.js"
import type { Code } from "./errors.js"

/** Strictness order: a rule may move a plan only rightwards. `run` is the strictest (its effects are unknown). */
export const CATEGORY_RANK: Readonly<Record<Category, number>> = { write: 1, share: 2, export: 3, delete: 4, admin: 5, run: 6 }

export const raise = (current: Category, to: Category): Category => (CATEGORY_RANK[to] > CATEGORY_RANK[current] ? to : current)

type Rule = Category | { readonly refuse: Code; readonly why: string } | ((ctx: ParserRuleContext) => Category | { readonly refuse: Code; readonly why: string })

const READ: Rule = { refuse: "CATEGORY_MISMATCH", why: "This is a read: use databricks_catalog or databricks_table for metadata, and databricks_query for queries." }
const SESSION: Rule = { refuse: "SESSION_STATEMENT_REFUSED", why: "Session state has no effect through the stateless API; pass catalog, schema and params instead." }

const tokens = (ctx: ParserRuleContext): number[] => {
  const types: number[] = []
  const visit = (node: ParserRuleContext | TerminalNode) => {
    if (node instanceof TerminalNode) types.push(node.symbol.type)
    else for (const child of node.children) visit(child as ParserRuleContext | TerminalNode)
  }
  visit(ctx)
  return types
}
const has = (ctx: ParserRuleContext, ...types: number[]) => {
  const seen = tokens(ctx)
  return types.every((type) => seen.includes(type))
}
const text = (ctx: ParserRuleContext) => ctx.getText().toLowerCase()
const orReplace = (ctx: ParserRuleContext): Category => (has(ctx, SqlBaseLexer.OR, SqlBaseLexer.REPLACE) ? "delete" : "write")
const temporary = (ctx: ParserRuleContext) => has(ctx, SqlBaseLexer.TEMPORARY)
const RETENTION = ["delta.logretentionduration", "delta.deletedfileretentionduration"]

/** Each statement alternative of the pinned grammar (context class name) and its rule. A test checks the list is complete. */
export const STATEMENT_RULES: Readonly<Record<string, Rule>> = {
  StatementDefaultContext: READ,
  VisitExecuteImmediateContext: "run",
  CallContext: "run",
  DmlStatementContext: (ctx) => dmlCategory(ctx),
  UseContext: SESSION,
  UseNamespaceContext: SESSION,
  SetCatalogContext: SESSION,
  CreateNamespaceContext: "write",
  SetNamespacePropertiesContext: "write",
  UnsetNamespacePropertiesContext: "write",
  SetNamespaceCollationContext: "write",
  SetNamespaceLocationContext: "admin",
  DropNamespaceContext: "delete",
  ShowNamespacesContext: READ,
  CreateTableContext: (ctx) => (temporary(ctx) ? SESSION_RULE : has(ctx, SqlBaseLexer.LOCATION) && has(ctx, SqlBaseLexer.AS) ? "export" : "write"),
  CreateTableLikeContext: "write",
  ReplaceTableContext: "delete",
  AnalyzeContext: "write",
  AnalyzeTablesContext: "write",
  AddTableColumnsContext: "write",
  RenameTableColumnContext: "write",
  DropTableColumnsContext: "delete",
  RenameTableContext: "write",
  SetTablePropertiesContext: (ctx) => (RETENTION.some((key) => text(ctx).includes(key)) ? "delete" : "write"),
  UnsetTablePropertiesContext: (ctx) => (RETENTION.some((key) => text(ctx).includes(key)) ? "delete" : "write"),
  AlterTableAlterColumnContext: (ctx) => (has(ctx, SqlBaseLexer.DROP) ? "delete" : "write"),
  HiveChangeColumnContext: "write",
  HiveReplaceColumnsContext: "delete",
  SetTableSerDeContext: "write",
  AddTablePartitionContext: "write",
  RenameTablePartitionContext: "write",
  DropTablePartitionsContext: "delete",
  SetTableLocationContext: "admin",
  RecoverPartitionsContext: "write",
  AlterClusterByContext: "write",
  AlterTableCollationContext: "write",
  AddTableConstraintContext: "write",
  DropTableConstraintContext: "delete",
  DropTableContext: "delete",
  DropViewContext: "delete",
  CreateViewContext: (ctx) => (temporary(ctx) ? SESSION_RULE : orReplace(ctx)),
  CreateMetricViewContext: (ctx) => orReplace(ctx),
  CreateTempViewUsingContext: SESSION,
  AlterViewQueryContext: "delete",
  AlterViewSchemaBindingContext: "write",
  CreateFunctionContext: (ctx) => (temporary(ctx) ? SESSION_RULE : orReplace(ctx)),
  CreateUserDefinedFunctionContext: (ctx) => (temporary(ctx) ? SESSION_RULE : orReplace(ctx)),
  DropFunctionContext: (ctx) => (temporary(ctx) ? SESSION_RULE : "delete"),
  CreateVariableContext: SESSION,
  DropVariableContext: SESSION,
  DeclareCursorStatementContext: SESSION,
  OpenCursorStatementContext: SESSION,
  FetchCursorStatementContext: SESSION,
  CloseCursorStatementContext: SESSION,
  ExplainContext: { refuse: "CATEGORY_MISMATCH", why: "EXPLAIN of a read is databricks_explain's; EXPLAIN of a change is never sent." },
  ShowTablesContext: READ,
  ShowTableExtendedContext: READ,
  ShowTblPropertiesContext: READ,
  ShowColumnsContext: READ,
  ShowViewsContext: READ,
  ShowPartitionsContext: READ,
  ShowFunctionsContext: READ,
  ShowProceduresContext: READ,
  ShowCreateTableContext: READ,
  ShowCurrentNamespaceContext: READ,
  ShowCatalogsContext: READ,
  ShowCollationsContext: READ,
  DescribeFunctionContext: READ,
  DescribeProcedureContext: READ,
  DescribeNamespaceContext: READ,
  DescribeRelationContext: READ,
  DescribeQueryContext: READ,
  CommentNamespaceContext: "write",
  CommentTableContext: "write",
  CommentColumnContext: "write",
  RefreshTableContext: "write",
  RefreshFunctionContext: "write",
  RefreshResourceContext: "write",
  CacheTableContext: SESSION,
  UncacheTableContext: SESSION,
  ClearCacheContext: SESSION,
  LoadDataContext: (ctx) => (has(ctx, SqlBaseLexer.OVERWRITE) ? "delete" : "write"),
  TruncateTableContext: "delete",
  RepairTableContext: (ctx) => (has(ctx, SqlBaseLexer.DROP) || has(ctx, SqlBaseLexer.SYNC) ? "delete" : "write"),
  ManageResourceContext: SESSION,
  CreateIndexContext: "write",
  DropIndexContext: "delete",
  FailNativeCommandContext: (ctx) => nativeCommand(ctx),
  CreatePipelineDatasetContext: (ctx) => orReplace(ctx),
  CreatePipelineInsertIntoFlowContext: "write",
  CreateFlowAutoCdcContext: "write",
  // setResetStatement: all session state.
  SetPathContext: SESSION,
  SetConfigurationContext: SESSION,
  SetQuotedConfigurationContext: SESSION,
  ResetConfigurationContext: SESSION,
  ResetQuotedConfigurationContext: SESSION,
  SetTimeZoneContext: SESSION,
  SetVariableContext: SESSION,
  FailSetRoleContext: SESSION,
}

const SESSION_RULE = SESSION as { readonly refuse: Code; readonly why: string }

function dmlCategory(ctx: ParserRuleContext): Category {
  const kinds = new Set<string>()
  const visit = (node: ParserRuleContext) => {
    kinds.add(contextName(node))
    for (const child of node.children) if (!(child instanceof TerminalNode)) visit(child as ParserRuleContext)
  }
  visit(ctx)
  if (kinds.has("InsertOverwriteHiveDirContext") || kinds.has("InsertOverwriteDirContext")) return "export"
  if (kinds.has("DeleteFromTableContext") || kinds.has("InsertOverwriteTableContext") || kinds.has("InsertIntoReplaceBooleanCondContext") || kinds.has("InsertIntoReplaceUsingContext")) return "delete"
  if (kinds.has("MergeIntoTableContext")) {
    const deletes = [...collect(ctx, (node) => contextName(node) === "MatchedActionContext" || contextName(node) === "NotMatchedBySourceActionContext")].some((node) => node.getChild(0) instanceof TerminalNode && (node.getChild(0) as TerminalNode).symbol.type === SqlBaseLexer.DELETE)
    return deletes ? "delete" : "write"
  }
  return "write"
}

function* collect(ctx: ParserRuleContext, predicate: (node: ParserRuleContext) => boolean): Generator<ParserRuleContext> {
  if (predicate(ctx)) yield ctx
  for (const child of ctx.children) if (!(child instanceof TerminalNode)) yield* collect(child as ParserRuleContext, predicate)
}

function nativeCommand(ctx: ParserRuleContext): Category | { readonly refuse: Code; readonly why: string } {
  const first = tokens(ctx)[0]
  if (first === SqlBaseLexer.GRANT || first === SqlBaseLexer.REVOKE) return "share"
  if (first === SqlBaseLexer.SHOW) return READ as { refuse: Code; why: string }
  return { refuse: "STATEMENT_UNKNOWN", why: "A Hive command this version does not classify." }
}

export interface PlanClassification {
  readonly ok: true
  readonly category: Category
  /** The statement form, such as `DropTableContext`, `script`, or `unparsed`. */
  readonly kind: string
  readonly parsed: boolean
  /** Tables the statement names (targets and sources), as parts. Unresolved names in `IDENTIFIER` are not here. */
  readonly tables: readonly (readonly string[])[]
  /** Functions called, by name. */
  readonly functions: readonly string[]
  /** Why a token rule raised the category, if one did. */
  readonly raisedBy: readonly string[]
  readonly notes: readonly string[]
}

export type PlanResult = PlanClassification | { readonly ok: false; readonly code: Code; readonly detail: string }

/**
 * The token rules of design §5.5 step 2, over every token of the text, comments excluded: `EXECUTE IMMEDIATE`, `CALL`
 * or `IDENTIFIER` anywhere raises a plan to `run`.
 */
export function tokenRaises(sql: string): string[] {
  const visible = lex(sql).tokens.filter((token) => token.channel === 0)
  const found = new Set<string>()
  visible.forEach((token, index) => {
    if (token.type === SqlBaseLexer.EXECUTE && visible[index + 1]?.type === SqlBaseLexer.IMMEDIATE) found.add("EXECUTE IMMEDIATE")
    if (token.type === SqlBaseLexer.CALL) found.add("CALL")
    if (token.type === SqlBaseLexer.IDENTIFIER_KW) found.add("IDENTIFIER")
  })
  return [...found].sort()
}

/** Secret functions named literally anywhere in a plan's text (design §5.2: in plans, on literal names only). */
export function literalSecretCalls(sql: string): string[] {
  const visible = lex(sql).tokens.filter((token) => token.channel === 0)
  const names = new Set(["secret", "try_secret", "list_secrets"])
  const found: string[] = []
  visible.forEach((token, index) => {
    const word = (token.text ?? "").replaceAll("`", "").toLowerCase()
    if (names.has(word) && visible[index + 1]?.type === SqlBaseLexer.LEFT_PAREN) found.push(word)
  })
  return found
}

/** Classifies a plan's SQL (design §5.5 steps 1 and 2). Sends nothing. */
export function classifyPlan(sql: string): PlanResult {
  const local = textRules(sql, { allowSemicolons: true, allowIdentifier: true })
  if (local && local.code !== "SQL_INVALID") return { ok: false, code: local.code, detail: local.detail }
  const secrets = literalSecretCalls(sql)
  if (secrets.length > 0) return { ok: false, code: "SECRET_FUNCTION_REFUSED", detail: `${secrets[0]} is refused in plans too.` }
  const raisedBy = tokenRaises(sql)
  const statement = sql.replace(/;\s*$/u, "")
  const parsed = statement.includes(";") ? undefined : parseStatement(statement)
  if (!parsed?.ok || !parsed.tree) {
    const script = /^\s*begin\b/iu.test(sql)
    return { ok: true, category: "run", kind: script ? "script" : "unparsed", parsed: false, tables: [], functions: [], raisedBy, notes: [script ? "A script: its statements are not known until it runs." : "Not parsed by the plugin; Databricks checks it at commit."] }
  }
  const kind = statementKind(parsed)
  const rule = STATEMENT_RULES[kind]
  if (rule === undefined) return { ok: false, code: "STATEMENT_UNKNOWN", detail: "This statement form is not in the statement table." }
  const top = parsed.tree.getChild(0) as ParserRuleContext
  const decided = typeof rule === "function" ? rule(top) : rule
  const found = walk(parsed.tree)
  const tables = found.tables.map((table) => table.parts)
  const functions = found.invocations.map((call) => call.parts.join("."))
  if (typeof decided === "object") {
    if (kind !== "StatementDefaultContext" || SESSION_STATEMENTS.has(kind)) return { ok: false, code: decided.refuse, detail: decided.why }
    // A query: a read, unless it calls something that needs a plan.
    const read = analyzeRead(statement)
    if (read.ok && read.userFunctions.length === 0) return { ok: false, code: decided.refuse, detail: decided.why }
    // IDENTIFIER is allowed in a plan (it sits in the preview, unresolved) and raises it to run below.
    if (!read.ok && read.refusal.code !== "NEEDS_PLAN" && read.refusal.code !== "IDENTIFIER_REFUSED") return { ok: false, code: read.refusal.code, detail: read.refusal.detail }
    const category = read.ok ? "run" : (read.refusal.category ?? "run")
    return finish({ category, kind, tables, functions, raisedBy, notes: ["A query that calls a function with effects outside the read path."] })
  }
  return finish({ category: decided, kind, tables, functions, raisedBy, notes: [] })
}

function finish(input: { category: Category; kind: string; tables: (readonly string[])[]; functions: string[]; raisedBy: string[]; notes: string[] }): PlanClassification {
  const category = input.raisedBy.length > 0 ? raise(input.category, "run") : input.category
  return { ok: true, category, kind: input.kind, parsed: true, tables: input.tables, functions: input.functions, raisedBy: input.raisedBy, notes: ["Syntax checked by the plugin; Databricks checks it at commit.", ...input.notes] }
}
