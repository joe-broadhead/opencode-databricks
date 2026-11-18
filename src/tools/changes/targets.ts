/**
 * The targets a change names, how each is resolved, and what the person's rules are asked about.
 *
 * **Where a target comes from.** A DDL statement's object is an `identifierReference`, not the `tableName` node the read
 * path walks (`DROP TABLE identifierReference`, `DELETE FROM identifierReference`, `MERGE INTO target=identifierReference
 * USING source=identifierReference`, `CREATE TABLE … identifierReference`, `ALTER TABLE identifierReference`,
 * `DROP FUNCTION identifierReference`, `DROP SCHEMA identifierReference`). `walk(tree).tables` is exactly right for a
 * read and does not see these, so this module collects them itself, with the statement's own context deciding the kind:
 * a table, a function, or a schema (`namespace` in the grammar is `NAMESPACE | DATABASE | SCHEMA`; `CATALOG` is not in
 * the pinned grammar, so `DROP CATALOG …` is unparseable and plans as `run`, the strictest).
 *
 * **How a target is resolved.** Databricks resolves a name against the statement's current catalog and schema: "If the
 * name is unqualified and does not reference a known table alias, Databricks first attempts to resolve the table in the
 * current schema. If the name is qualified with a schema, Databricks attempts to resolve the table in the current
 * catalog" (https://docs.databricks.com/aws/en/sql/language-manual/sql-ref-names, "Table and view resolution"). The
 * plugin sets those defaults itself: the Statement Execution API's `catalog` and `schema` fields set the statement's
 * default catalog and schema ("similar to USE CATALOG … USE SCHEMA",
 * https://docs.databricks.com/statement-execution/v1/execute-statement). So a one-part name is
 * `<catalog>.<schema>.<name>` — never the other way round — and a two-part name is `<catalog>.<name>.<object>`.
 *
 * A plan passes `catalog` and `schema` (its own, or the account's defaults) and stores them in its payload, so the
 * statement the commit sends runs against exactly the defaults the preview resolved. A target this cannot fully qualify
 * is `INPUT_INVALID`: an unqualified name resolves on the server against a default the plugin cannot see, and the
 * person's rule would miss it (the HIGH finding of the review of #7).
 *
 * **What the person is asked.** Every target is asserted as `<account>:<kind>:<qualified name>` under the commit tool's
 * own dotted action, before the statement:
 *
 * - a table as `<account>:table:<c>.<s>.<t>`, the design's §10.1 resource;
 * - a function as `<account>:function:<c>.<s>.<f>`: a function is not a table, and `tables.get` cannot resolve it;
 * - a schema as `<account>:table:<c>.<s>.*`, which a pattern such as `*.hr.*` or `main.hr.*` matches (OpenCode's
 *   wildcards are `*` over any run of characters). `DROP SCHEMA … CASCADE` drops every object in the schema, so its
 *   contents are listed (free, `tables.list`) and refused when they cannot be listed: the schema-level rule is the one
 *   the person approved, and the plugin will not drop objects it could not count.
 *
 * `tables.get` is free and needs only `USE` and `SELECT` [27], so a plan stays a set of free control-plane reads.
 */
import { type ParserRuleContext, TerminalNode } from "antlr4ng"
import type { Category } from "../../domain/actions.js"
import { DatabricksError } from "../../domain/errors.js"
import type { PlanClassification } from "../../domain/statements.js"
import { quoted } from "../../guards/pattern.js"
import type { DatabricksPort } from "../../ports.js"
import { SqlBaseLexer } from "../../sql/generated/SqlBaseLexer.js"
import { type Parsed, contextName, parseStatement } from "../../sql/parse.js"

/** What a target is: a table or view, a Unity Catalog function, or a schema. */
export type TargetKind = "table" | "function" | "schema"

/** A target as the text names it, before resolution. */
export interface ChangeTarget {
  /** The parts as written, unquoted and lower-cased. */
  readonly parts: readonly string[]
  readonly kind: TargetKind
  /** `DROP SCHEMA … CASCADE`: every object in the schema goes, not only the schema's own definition. */
  readonly cascade: boolean
  /** `<format>.\`<path>\``: a path read, which no Unity Catalog name can check. */
  readonly pathRead: boolean
}

/** A target after resolution: its fully qualified name, and what Unity Catalog says about it. */
export interface ResolvedTarget {
  /** `catalog.schema.object`, or `catalog.schema` for a schema. */
  readonly name: string
  readonly kind: TargetKind
  readonly cascade: boolean
  readonly type?: string
  readonly owner?: string
  readonly exists?: boolean
  /** A CASCADE schema's objects, sorted: what the statement will drop beyond the schema itself. */
  readonly children?: readonly string[]
}

export interface CheckedTargets {
  readonly targets: readonly ResolvedTarget[]
  /** The names the fingerprint compares, sorted. */
  readonly names: readonly string[]
  readonly notes: readonly string[]
  /** The statement's first target exists and the statement creates it: the plan is a replace. */
  readonly replaces: boolean
}

/** The statement forms whose category `write` becomes `delete` when their first target already exists (§5.5). */
const CREATE_KINDS: ReadonlySet<string> = new Set(["CreateTableContext", "CreateTableLikeContext", "CreateViewContext", "CreateMetricViewContext", "CreatePipelineDatasetContext", "CreateFunctionContext", "CreateUserDefinedFunctionContext"])

/** The statement forms whose object is a Unity Catalog function. */
const FUNCTION_KINDS: ReadonlySet<string> = new Set(["CreateFunctionContext", "CreateUserDefinedFunctionContext", "DropFunctionContext"])

/** The statement forms whose object is a namespace (schema, database or namespace). */
const NAMESPACE_KINDS: ReadonlySet<string> = new Set([
  "CreateNamespaceContext",
  "SetNamespacePropertiesContext",
  "UnsetNamespacePropertiesContext",
  "SetNamespaceCollationContext",
  "SetNamespaceLocationContext",
  "DropNamespaceContext",
  "CommentNamespaceContext",
])

/** The most objects one `DROP SCHEMA … CASCADE` may list: beyond it the plan is refused rather than guessed at. */
export const MAX_CASCADE_OBJECTS = 1000
const LIST_PAGE = 100

/** The default catalog and schema a statement runs with, when the plan knows them. */
export interface NameDefaults {
  readonly catalog?: string
  readonly schema?: string
}

/** Whether a parse tree holds a token of this type (`CASCADE`, `CATALOG`, …), anywhere below it. */
function hasToken(node: ParserRuleContext, type: number): boolean {
  for (const child of node.children) {
    if (child instanceof TerminalNode) {
      if (child.symbol.type === type) return true
    } else if (hasToken(child as ParserRuleContext, type)) return true
  }
  return false
}

function descendants(ctx: ParserRuleContext, predicate: (node: ParserRuleContext) => boolean): ParserRuleContext[] {
  const found: ParserRuleContext[] = []
  const visit = (node: ParserRuleContext) => {
    if (predicate(node)) found.push(node)
    for (const child of node.children) {
      if (child instanceof TerminalNode) continue
      visit(child as ParserRuleContext)
    }
  }
  visit(ctx)
  return found
}

/** The statement's top alternative, or undefined for text this version cannot parse. */
function topOf(sql: string): { parsed: Parsed; top: ParserRuleContext } | undefined {
  const statement = sql.replace(/;\s*$/u, "")
  if (statement.includes(";")) return undefined
  const parsed = parseStatement(statement)
  if (!parsed.ok || !parsed.tree) return undefined
  return { parsed, top: parsed.tree.getChild(0) as ParserRuleContext }
}

/**
 * Every target a change names, in the order the text names them: the statement-level `identifierReference` nodes.
 *
 * A `MERGE … USING source` names two: the target and its source table. A query has none (its tables are the read path's).
 * Text this version cannot parse has none either: the classifier calls it `run`, "its statements are not known until it
 * runs", and the preview says so.
 */
export function changeTargets(sql: string): readonly ChangeTarget[] {
  const parsed = topOf(sql)
  if (!parsed) return []
  const kindName = contextName(parsed.top)
  if (kindName === "StatementDefaultContext") return []
  const targetKind = FUNCTION_KINDS.has(kindName) ? "function" : NAMESPACE_KINDS.has(kindName) ? "schema" : "table"
  const cascade = targetKind === "schema" && hasToken(parsed.top, SqlBaseLexer.CASCADE)
  const found: ChangeTarget[] = []
  const seen = new Set<string>()
  for (const node of descendants(parsed.top, (child) => contextName(child) === "IdentifierReferenceContext")) {
    const multipart = (node as unknown as { multipartIdentifier(): ParserRuleContext | null }).multipartIdentifier()
    if (!multipart) continue // IDENTIFIER(…): a name chosen at run time, which no assert can see.
    const parts = namePartsOf(multipart)
    if (parts.length === 0 || parts.some((part) => part.length === 0)) continue
    const key = `${targetKind}:${parts.join(".")}`
    if (seen.has(key)) continue
    seen.add(key)
    found.push({ parts, kind: targetKind, cascade, pathRead: parts.some((part) => /[/:\\]/u.test(part)) })
  }
  return found
}

/** The dot-separated parts of a multipartIdentifier, unquoted and lower-cased. */
function namePartsOf(ctx: ParserRuleContext): string[] {
  const unquote = (text: string) => (text.startsWith("`") && text.endsWith("`") && text.length >= 2 ? text.slice(1, -1).replaceAll("``", "`") : text)
  const parts: string[] = []
  let current = ""
  for (const child of ctx.children) {
    if (child instanceof TerminalNode && child.symbol.type === SqlBaseLexer.DOT) {
      parts.push(current)
      current = ""
    } else current += unquote(child.getText())
  }
  parts.push(current)
  return parts.map((part) => part.toLowerCase())
}

/** The refusal for a name the plan cannot resolve: an unqualified name resolves on the server, out of the rule's reach. */
const unqualified = (parts: readonly string[], kind: TargetKind, defaults: NameDefaults): DatabricksError =>
  new DatabricksError(
    "INPUT_INVALID",
    `The ${kind} ${quoted(parts.join("."))} is not fully qualified, so the plugin cannot tell which object it names${Object.keys(defaults).length === 0 ? "" : ` (it has ${defaults.catalog ? `catalog ${quoted(defaults.catalog)}` : "no catalog"}${defaults.schema ? ` and schema ${quoted(defaults.schema)}` : " and no schema"})`}.`,
    "Write it as catalog.schema.name, or pass catalog and schema on the plan.",
  )

/**
 * A target's fully qualified name, resolved the way Databricks resolves it in a statement that carries these defaults:
 * a one-part name takes the catalog and then the schema, a two-part name takes the catalog. A name that still cannot be
 * completed is refused.
 */
export function qualifyName(target: ChangeTarget, defaults: NameDefaults): string {
  const parts = target.parts
  if (target.kind === "schema") {
    if (parts.length === 2) return parts.join(".")
    if (parts.length === 1 && defaults.catalog) return `${defaults.catalog}.${parts[0]}`
    throw unqualified(parts, target.kind, defaults)
  }
  if (parts.length === 3) return parts.join(".")
  if (parts.length === 2 && defaults.catalog) return `${defaults.catalog}.${parts[0]}.${parts[1]}`
  if (parts.length === 1 && defaults.catalog && defaults.schema) return `${defaults.catalog}.${defaults.schema}.${parts[0]}`
  throw unqualified(parts, target.kind, defaults)
}

export interface TargetDeps {
  readonly databricks: Pick<DatabricksPort, "getTable" | "listTables">
}

export interface ResolveInput {
  readonly account: string
  readonly targets: readonly ChangeTarget[]
  readonly defaults: NameDefaults
  readonly signal: AbortSignal
}

/** Lists a schema's objects for a CASCADE, bounded; a list the plugin cannot read refuses the change. */
async function schemaObjects(deps: TargetDeps, account: string, name: string, signal: AbortSignal): Promise<readonly string[]> {
  const [catalog, schema] = name.split(".")
  if (!catalog || !schema) throw unqualified([name], "schema", {})
  const names: string[] = []
  let pageToken: string | undefined
  for (let page = 0; page < MAX_CASCADE_OBJECTS / LIST_PAGE; page++) {
    const answer = await deps.databricks.listTables(account, catalog, schema, { maxResults: LIST_PAGE, ...(pageToken ? { pageToken } : {}) }, signal)
    for (const table of answer.items) names.push(`${catalog}.${schema}.${table.name}`)
    if (names.length > MAX_CASCADE_OBJECTS) break
    if (!answer.nextPageToken) return names.sort()
    pageToken = answer.nextPageToken
  }
  throw new DatabricksError("FENCED", `${quoted(name)} has more than ${MAX_CASCADE_OBJECTS} objects, more than this version will drop in one change.`, "Drop them in smaller batches, or drop the schema in the Databricks SQL editor.")
}

/**
 * Resolves every target: a table with `tables.get` (free), a function without a call (a function is not a table), and a
 * schema with `tables.list` when the statement would drop its contents. A name that is not fully qualified, and a
 * CASCADE whose contents cannot be listed, are refused — nothing the preview shows may be beyond the person's rules.
 */
export async function resolveTargets(deps: TargetDeps, input: ResolveInput): Promise<CheckedTargets> {
  const targets: ResolvedTarget[] = []
  const notes: string[] = []
  let replaces = false
  for (const [index, target] of input.targets.entries()) {
    if (target.pathRead) {
      notes.push(`The path read ${quoted(target.parts.join("."))} is not a Unity Catalog object, so no rule can check it.`)
      continue
    }
    const name = qualifyName(target, input.defaults)
    if (target.kind === "function") {
      targets.push({ name, kind: "function", cascade: false, type: "FUNCTION" })
      continue
    }
    if (target.kind === "schema") {
      if (!target.cascade) {
        targets.push({ name, kind: "schema", cascade: false, type: "SCHEMA" })
        continue
      }
      let children: readonly string[]
      try {
        children = await schemaObjects(deps, input.account, name, input.signal)
      } catch (error) {
        if (error instanceof DatabricksError && error.code === "FENCED") throw error
        throw new DatabricksError("FENCED", `The plugin cannot list the objects in ${quoted(name)}, so it cannot tell what DROP SCHEMA … CASCADE would drop.`, "Drop the schema in the Databricks SQL editor, or empty it first and drop it without CASCADE.")
      }
      targets.push({ name, kind: "schema", cascade: true, type: "SCHEMA", children })
      notes.push(`${quoted(name)} is dropped with CASCADE: its ${children.length} object${children.length === 1 ? "" : "s"} go with it, and the person's rule for the schema covers all of them.`)
      continue
    }
    try {
      const table = await deps.databricks.getTable(input.account, name, input.signal)
      targets.push({ name, kind: "table", cascade: false, type: table.tableType, ...(table.owner ? { owner: table.owner } : {}), exists: true })
      if (index === 0) replaces = true
    } catch (error) {
      if (error instanceof DatabricksError && error.code === "NOT_FOUND") {
        targets.push({ name, kind: "table", cascade: false, exists: false })
        continue
      }
      if (error instanceof DatabricksError && error.code === "PERMISSION_DENIED") {
        targets.push({ name, kind: "table", cascade: false })
        notes.push(`Unity Catalog did not show ${quoted(name)} to this identity, so whether it exists is unknown.`)
        continue
      }
      throw error
    }
  }
  const unique = [...new Map(targets.map((target) => [`${target.kind}:${target.name}`, target])).values()]
  return { targets: unique, names: unique.map((target) => target.name).sort(), notes, replaces }
}

/**
 * The category a classification takes once its targets are known: a `CREATE` over an existing table, view or function is
 * a replace, and so `delete`. Nothing else lowers or raises a category here.
 */
export function categoryFor(classified: PlanClassification, checked: CheckedTargets): Category {
  if (classified.category === "write" && checked.replaces && CREATE_KINDS.has(classified.kind)) return "delete"
  return classified.category
}

/** The resource a target is asserted as (design §10.1's table resource, and this plugin's for the other two kinds). */
export function targetResource(account: string, target: { readonly name: string; readonly kind: TargetKind }): string {
  const prefix = target.kind === "function" ? "function" : "table"
  return `${account}:${prefix}:${target.name}${target.kind === "schema" ? ".*" : ""}`
}

/** What an assert needs: the permission port, the account and the commit's own dotted action. */
export interface AssertDeps {
  readonly permission: { assert(request: { action: string; resource: string; sessionID: string; messageID?: string; callID?: string }, signal: AbortSignal): Promise<void> }
}

export interface AssertInput {
  readonly account: string
  readonly action: string
  readonly targets: readonly ResolvedTarget[]
  readonly sessionID: string
  readonly messageID?: string
  readonly callID?: string
  readonly signal: AbortSignal
}

/**
 * Asks the person's rules about every target, before the statement. A schema is one assert — `<c>.<s>.*`, the broadest
 * rule it can offer — and a CASCADE adds nothing per object: the rule that covers the schema covers what it drops.
 */
export async function assertTargets(deps: AssertDeps, input: AssertInput): Promise<void> {
  for (const target of input.targets) {
    await deps.permission.assert(
      {
        action: input.action,
        resource: targetResource(input.account, target),
        sessionID: input.sessionID,
        ...(input.messageID && input.callID ? { messageID: input.messageID, callID: input.callID } : {}),
      },
      input.signal,
    )
  }
}
