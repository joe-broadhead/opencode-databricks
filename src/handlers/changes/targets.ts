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
import type { Category } from "../../methods.js"
import { DatabricksError } from "../../domain/errors.js"
import type { PlanClassification } from "../../provider/classify.js"
import { quoted } from "../../provider/guards/pattern.js"
import type { DatabricksPort } from "../../ports.js"
import { SqlBaseLexer } from "../../provider/sql/generated/SqlBaseLexer.js"
import { type Parsed, contextName, lex, parseStatement } from "../../provider/sql/parse.js"

/** What a target is: a table or view, a Unity Catalog function, volume or registered model, a schema, or a catalog. */
export type TargetKind = "table" | "function" | "volume" | "model" | "schema" | "catalog"

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
  /**
   * What a CASCADE drops beyond the target itself, sorted: a schema's objects, or a catalog's schemas and their objects.
   * Each is asserted by its own resource, so a rule that names one of them reaches it (review of #7, rounds 2 and 3).
   */
  readonly children?: readonly CascadeChild[]
}

/** One object a CASCADE drops: a schema, a table or view, a function, a volume or a registered model. */
export interface CascadeChild {
  readonly name: string
  readonly kind: "schema" | "table" | "function" | "volume" | "model"
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
  if (!parsed) return catalogDropTarget(sql)
  const kindName = contextName(parsed.top)
  if (kindName === "StatementDefaultContext") return []
  const targetKind = FUNCTION_KINDS.has(kindName) ? "function" : NAMESPACE_KINDS.has(kindName) ? "schema" : "table"
  const cascade = targetKind === "schema" && hasToken(parsed.top, SqlBaseLexer.CASCADE)
  const found: ChangeTarget[] = []
  const seen = new Set<string>()
  const add = (parts: readonly string[], kind: TargetKind) => {
    if (parts.length === 0 || parts.some((part) => part.length === 0)) return
    const key = `${kind}:${parts.join(".")}`
    if (seen.has(key)) return
    seen.add(key)
    found.push({ parts, kind, cascade, pathRead: parts.some((part) => /[/:\\]/u.test(part)) })
  }
  for (const node of descendants(parsed.top, (child) => contextName(child) === "IdentifierReferenceContext")) {
    const multipart = (node as unknown as { multipartIdentifier(): ParserRuleContext | null }).multipartIdentifier()
    if (!multipart) continue // IDENTIFIER(…): a name chosen at run time, which no assert can see.
    add(namePartsOf(multipart), targetKind)
  }
  // A rename names its new object with a plain `multipartIdentifier` — `ALTER (TABLE | VIEW) from=identifierReference
  // RENAME TO to=multipartIdentifier` — not an identifierReference, so the loop above cannot see it. The destination is
  // a target too: moving a table into another schema must be checked against that schema's rules (review round 2,
  // R2-M1). A function rename is not in the pinned grammar and plans as `run` (the strictest) instead.
  if (kindName === "RenameTableContext") {
    const to = (parsed.top as unknown as { _to?: ParserRuleContext })._to
    if (to) add(namePartsOf(to), "table")
  }
  return found
}

/**
 * `DROP CATALOG <name>` (with `IF EXISTS`, and `CASCADE` or not) is not in the pinned grammar — `namespace` is
 * NAMESPACE, DATABASE or SCHEMA — so it plans as `run`, the strictest. Its object is still knowable from the leading
 * tokens, so it is a target: the person's rule is asked about `<account>:table:<name>.*.*` before anything is sent
 * (review round 2, LOW 3). No other unparsed text claims a target.
 */
function catalogDropTarget(sql: string): readonly ChangeTarget[] {
  const visible = lex(sql).tokens.filter((token) => token.channel === 0)
  const isWord = (token: { type: number } | undefined, word: number) => token?.type === word
  if (!isWord(visible[0], SqlBaseLexer.DROP) || !isWord(visible[1], SqlBaseLexer.CATALOG)) return []
  let index = 2
  if (isWord(visible[index], SqlBaseLexer.IF) && isWord(visible[index + 1], SqlBaseLexer.EXISTS)) index += 2
  const name = visible[index]
  if (!name?.text) return []
  const parts = [name.text.replaceAll("`", "").toLowerCase()]
  return parts[0] ? [{ parts, kind: "catalog", cascade: hasWord(visible, SqlBaseLexer.CASCADE), pathRead: false }] : []
}

const hasWord = (tokens: readonly { readonly type: number }[], type: number): boolean => tokens.some((token) => token.type === type)

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
  if (target.kind === "catalog") {
    // A catalog name is one part: `DROP CATALOG main`.
    if (parts.length === 1) return parts[0]!
    throw unqualified(parts, target.kind, defaults)
  }
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
  readonly databricks: Pick<DatabricksPort, "getTable" | "listTables" | "listSchemas" | "listFunctions" | "listVolumes" | "listModels">
}

export interface ResolveInput {
  readonly account: string
  readonly targets: readonly ChangeTarget[]
  readonly defaults: NameDefaults
  readonly signal: AbortSignal
}

/**
 * Every page of one Unity Catalog list, sorted, bounded: a list the plugin cannot read, or one past the bound, refuses
 * the change rather than leaving objects unasserted. `tables.list`, `functions.list` and `volumes.list` are free
 * (design §5.5's control-plane reads).
 */
async function listAll(fetch: (page: { readonly pageToken?: string; readonly maxResults: number }) => Promise<{ readonly items: readonly { readonly name: string }[]; readonly nextPageToken?: string }>, what: string, signal: AbortSignal): Promise<readonly string[]> {
  const names: string[] = []
  let pageToken: string | undefined
  for (let page = 0; page < MAX_CASCADE_OBJECTS / LIST_PAGE; page++) {
    if (signal.aborted) throw new DatabricksError("CANCELLED")
    const answer = await fetch({ maxResults: LIST_PAGE, ...(pageToken ? { pageToken } : {}) })
    for (const item of answer.items) names.push(item.name)
    if (names.length > MAX_CASCADE_OBJECTS) break
    if (!answer.nextPageToken) return names.sort()
    pageToken = answer.nextPageToken
  }
  throw new DatabricksError("FENCED", `${what} has more than ${MAX_CASCADE_OBJECTS} objects, more than this version will drop in one change.`, "Drop them in smaller batches, or drop it in the Databricks SQL editor.")
}

/**
 * What a schema CASCADE drops beyond the schema itself: its tables and views (`tables.list`), its functions
 * (`functions.list`), its volumes (`volumes.list`) and its registered models (`listModels`, which reads every page).
 * Each is a child with its own resource, so a rule naming one reaches it (review of #7, round 4's LOW 3 and round 5).
 */
async function schemaChildren(deps: TargetDeps, account: string, name: string, signal: AbortSignal): Promise<readonly CascadeChild[]> {
  const [catalog, schema] = name.split(".")
  if (!catalog || !schema) throw unqualified([name], "schema", {})
  const tables = await listAll((page) => deps.databricks.listTables(account, catalog, schema, page, signal), quoted(name), signal)
  const functions = await listAll((page) => deps.databricks.listFunctions(account, catalog, schema, page, signal), quoted(name), signal)
  const volumes = await listAll((page) => deps.databricks.listVolumes(account, catalog, schema, page, signal), quoted(name), signal)
  // `listModels` follows `next_page_token` itself, and answers a name per registered model.
  const models = await deps.databricks.listModels(account, catalog, schema, signal)
  return [
    ...tables.map((table) => ({ name: `${catalog}.${schema}.${table}`, kind: "table" as const })),
    ...functions.map((fn) => ({ name: `${catalog}.${schema}.${fn}`, kind: "function" as const })),
    ...volumes.map((volume) => ({ name: `${catalog}.${schema}.${volume}`, kind: "volume" as const })),
    ...models.map((model) => ({ name: `${catalog}.${schema}.${model.name}`, kind: "model" as const })),
  ]
}

/**
 * Lists a catalog's schemas for a CASCADE, bounded; a list the plugin cannot read, or one past the bound, refuses the
 * change with a next step. `schemas.list` is free (design §5.5's control-plane reads).
 */
async function catalogSchemas(deps: TargetDeps, account: string, catalog: string, signal: AbortSignal): Promise<readonly string[]> {
  const names: string[] = []
  let pageToken: string | undefined
  for (let page = 0; page < MAX_CASCADE_OBJECTS / LIST_PAGE; page++) {
    const answer = await deps.databricks.listSchemas(account, catalog, { maxResults: LIST_PAGE, ...(pageToken ? { pageToken } : {}) }, signal)
    for (const schema of answer.items) names.push(schema.name)
    if (names.length > MAX_CASCADE_OBJECTS) break
    if (!answer.nextPageToken) return names.sort()
    pageToken = answer.nextPageToken
  }
  throw new DatabricksError("FENCED", `${quoted(catalog)} has more than ${MAX_CASCADE_OBJECTS} schemas, more than this version will drop in one change.`, "Drop the catalog in the Databricks SQL editor, or empty it first.")
}

/**
 * Resolves every target: a table with `tables.get` (free), a function without a call (a function is not a table), a
 * schema with `tables.list` when the statement would drop its contents, and a catalog with `schemas.list` and then each
 * schema's `tables.list` when it would — never with the catalog's wildcard alone. A name that is not fully qualified, and a
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
    if (target.kind === "catalog") {
      if (!target.cascade) {
        // Without CASCADE Databricks' RESTRICT default refuses a non-empty catalog, so only the catalog itself is
        // asserted: nothing else can be dropped.
        targets.push({ name, kind: "catalog", cascade: false, type: "CATALOG" })
        continue
      }
      // CASCADE drops every schema and every object in them. Each is listed (free reads) and asserted by its own
      // resource, so a rule that names `*.hr.*` or one table reaches it; the catalog's wildcard is asserted too. A list
      // that cannot be read, or is past the bound, refuses the change rather than falling back to the wildcard alone.
      let schemas: readonly string[]
      try {
        schemas = await catalogSchemas(deps, input.account, name, input.signal)
      } catch (error) {
        if (error instanceof DatabricksError && error.code === "FENCED") throw error
        throw new DatabricksError("FENCED", `The plugin cannot list the schemas in ${quoted(name)}, so it cannot tell what DROP CATALOG … CASCADE would drop.`, "Drop it in the Databricks SQL editor, or empty it first and drop it without CASCADE.")
      }
      const children: CascadeChild[] = []
      for (const schema of schemas) {
        children.push({ name: `${name}.${schema}`, kind: "schema" })
        let objects: readonly CascadeChild[]
        try {
          objects = await schemaChildren(deps, input.account, `${name}.${schema}`, input.signal)
        } catch (error) {
          if (error instanceof DatabricksError && error.code === "FENCED" && /more than/u.test(error.detail)) throw error
          throw new DatabricksError("FENCED", `The plugin cannot list the objects in ${quoted(`${name}.${schema}`)}, so it cannot tell what DROP CATALOG … CASCADE would drop.`, "Drop it in the Databricks SQL editor, or empty it first and drop it without CASCADE.")
        }
        children.push(...objects)
        if (children.length > MAX_CASCADE_OBJECTS) {
          throw new DatabricksError("FENCED", `${quoted(name)} has more than ${MAX_CASCADE_OBJECTS} objects, more than this version will drop in one change.`, "Drop it in the Databricks SQL editor, or empty it first.")
        }
      }
      targets.push({ name, kind: "catalog", cascade: true, type: "CATALOG", children })
      notes.push(`${quoted(name)} is dropped with CASCADE: ${schemas.length} schema${schemas.length === 1 ? "" : "s"} and ${children.length - schemas.length} object${children.length - schemas.length === 1 ? "" : "s"} will be checked against your rules.`)
      continue
    }
    if (target.kind === "schema") {
      if (!target.cascade) {
        targets.push({ name, kind: "schema", cascade: false, type: "SCHEMA" })
        continue
      }
      let children: readonly CascadeChild[]
      try {
        children = await schemaChildren(deps, input.account, name, input.signal)
      } catch (error) {
        if (error instanceof DatabricksError && error.code === "FENCED") throw error
        throw new DatabricksError("FENCED", `The plugin cannot list the objects in ${quoted(name)}, so it cannot tell what DROP SCHEMA … CASCADE would drop.`, "Drop the schema in the Databricks SQL editor, or empty it first and drop it without CASCADE.")
      }
      targets.push({ name, kind: "schema", cascade: true, type: "SCHEMA", children })
      notes.push(`${quoted(name)} is dropped with CASCADE: ${children.length} object${children.length === 1 ? "" : "s"} will be checked against your rules.`)
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
  const prefix = target.kind === "function" ? "function" : target.kind === "volume" ? "volume" : target.kind === "model" ? "model" : "table"
  const suffix = target.kind === "schema" ? ".*" : target.kind === "catalog" ? ".*.*" : ""
  return `${account}:${prefix}:${target.name}${suffix}`
}
