/**
 * The read path's local decisions (design §5.1 steps 1 and 2) over the plugin's own parse (src/sql/parse.ts), and the
 * walk the plan path shares. Pure: no network, no clock. Package C calls `analyzeRead` first, then resolves the
 * user functions and tables it reports (§5.4), then applies the fence and inline rules (§5.6, §5.7).
 *
 * What it guarantees about the text it returns in `sent` (the only text a read ever sends):
 * - it is exactly `SELECT * FROM (\n<sql>\n) AS oc_q`, where <sql> is the caller's text with one trailing `;` removed
 *   and every allowlisted built-in call qualified as `system.builtin.<name>` (LOW 3);
 * - it has no `;`, no nested comment opener, no line-continued `--` comment, no U+2028 or U+2029, no `IDENTIFIER(`, no
 *   positional `?`, no script transform;
 * - it parses with the pinned grammar as one query, and its invocations are the caller's, now qualified.
 * These checks are best-effort (design §5.3): the server-side guarantee is the identity's privileges.
 */
import type { ParserRuleContext, ParseTree, Token } from "antlr4ng"
import { TerminalNode } from "antlr4ng"
import type { Category } from "../domain/actions.js"
import type { Code } from "../domain/errors.js"
import { decideFunction, type FunctionDecision, KEYWORD_FORMS, NILADIC_FIXED, PATH_RULE } from "../domain/functions.js"
import { SqlBaseLexer } from "./generated/SqlBaseLexer.js"
import {
  type FunctionNameContext,
  type QualifiedNameContext,
  SqlBaseParser,
} from "./generated/SqlBaseParser.js"
import { contextName, isKeyword, lex, parseStatement, type Parsed } from "./parse.js"

/** The most bytes a read's text may have (the server allows 16 MiB). */
export const MAX_SQL_BYTES = 1024 * 1024

export const WRAP_PREFIX = "SELECT * FROM (\n"
export const WRAP_SUFFIX = "\n) AS oc_q"
export const wrap = (sql: string) => `${WRAP_PREFIX}${sql}${WRAP_SUFFIX}`

export interface Refusal {
  readonly code: Code
  /** The plugin's own words; never the caller's text beyond validated names. */
  readonly detail: string
  /** For NEEDS_PLAN: the category the plan would take. */
  readonly category?: Category
  /** A next step more exact than the code's own, in the plugin's words. */
  readonly next?: string
}

export type InvocationNode = "functionCall" | "tableFunctionCall" | "lateralView"

export interface Invocation {
  readonly node: InvocationNode
  readonly parts: readonly string[]
  readonly position: "scalar" | "table"
  readonly decision: FunctionDecision
  /** Character range of the name in the caller's text, inclusive. */
  readonly start: number
  readonly stop: number
  /** `count(*)`: kept unqualified, because Spark's AstBuilder rewrites COUNT(*) by its bare name. */
  readonly countStar: boolean
}

export interface TableReference {
  readonly parts: readonly string[]
  readonly node: "tableName" | "changelogTableName" | "streamTableName" | "tableArgument"
  /** `delta.\`/path\``-style reads: a part that looks like a path. The fence cannot check these (§5.4). */
  readonly pathRead: boolean
  /** A one-part name that equals a CTE's name somewhere in the text. Package C resolves it anyway. */
  readonly maybeCte: boolean
}

/**
 * Something the SQL path decides by name: a keyword form that becomes a named call, or a `LATERAL VIEW` generator
 * (sent unqualified, because Spark's AstBuilder takes at most two parts there; reported as a keyword form), `count(*)`,
 * or an unqualified table.
 */
export interface PathSensitive {
  readonly kind: "keyword-form" | "count-star" | "table"
  readonly name: string
}

export interface ReadAnalysis {
  readonly ok: true
  /** The caller's text, one trailing `;` removed. */
  readonly sql: string
  /** The caller's text with allowlisted built-in calls qualified. */
  readonly rewritten: string
  /** The exact statement text to send: `wrap(rewritten)`. */
  readonly sent: string
  readonly invocations: readonly Invocation[]
  /**
   * Scalar calls the allowlist does not hold, each written with its full three-part name (review #1, M2: a one- or
   * two-part name is refused, because Databricks resolves it along PATH, not where package C would check it). Never in
   * the `system` catalog (a `system.*` name that is not an allowlisted built-in is NEEDS_PLAN here), and always in
   * ASCII (a non-ASCII function name is refused). Sent as written; package C checks each under §5.4, and a
   * function Unity Catalog does not return (not found, not visible) is NEEDS_PLAN.
   */
  readonly userFunctions: readonly Invocation[]
  readonly tables: readonly TableReference[]
  /** The keyword forms used, by context name (KEYWORD_FORMS). */
  readonly keywordForms: readonly string[]
  /** What resolves along PATH; when non-empty, package C needs `pathIsSafe(current_path())` first (PATH_NOT_DEFAULT). */
  readonly pathSensitive: readonly PathSensitive[]
}

export type ReadResult = ReadAnalysis | { readonly ok: false; readonly refusal: Refusal }

const refuse = (code: Code, detail: string, category?: Category): { ok: false; refusal: Refusal } => ({ ok: false, refusal: { code, detail, ...(category ? { category } : {}) } })

// ── step 1: text and token rules ─────────────────────────────────────────

/**
 * One trailing `;` (after trailing whitespace) is removed, when it is a statement terminator: not the end of a comment
 * or a string, which the lexer decides. Any other `;`, anywhere, is refused by `textRules`.
 */
export function stripTrailingSemicolon(sql: string): string {
  const trimmed = sql.replace(/\s+$/u, "")
  if (!trimmed.endsWith(";")) return sql
  const last = lex(trimmed).tokens.filter((token) => token.type !== -1).at(-1)
  return last?.type === SqlBaseLexer.SEMICOLON && last.channel === 0 ? trimmed.slice(0, -1) : sql
}

/**
 * The constructs where Spark, Databricks and a JavaScript runtime could disagree about where a token ends (design
 * §5.1): U+2028 and U+2029, a nested block-comment opener, and a `--` comment continued by a backslash before its line
 * break (Spark's SIMPLE_COMMENT continues across `\` + LF). `allowSemicolons` and `allowIdentifier` relax the two rules
 * the plan path relaxes (design §5.5 step 1).
 */
export function textRules(sql: string, options: { allowSemicolons?: boolean; allowIdentifier?: boolean } = {}): Refusal | undefined {
  if (Buffer.byteLength(sql, "utf8") > MAX_SQL_BYTES) return { code: "INPUT_INVALID", detail: "The SQL text is longer than 1 MiB." }
  if (/[\u2028\u2029]/u.test(sql)) return { code: "STATEMENT_NOT_READ", detail: "The text has a U+2028 or U+2029 line separator, which parsers can read differently." }
  if (!options.allowSemicolons && sql.includes(";")) return { code: "STATEMENT_NOT_READ", detail: "The text has a semicolon other than one at the end; a literal semicolon is written chr(59)." }
  const lexed = lex(sql)
  if (lexed.unclosedComment) return { code: "SQL_INVALID", detail: "A /* comment is not closed." }
  const visible = lexed.tokens.filter((token) => token.channel === 0 && token.type !== -1)
  for (const token of lexed.tokens) {
    const text = token.text ?? ""
    if (token.type === SqlBaseLexer.BRACKETED_COMMENT && text.slice(2).includes("/*")) {
      return { code: "STATEMENT_NOT_READ", detail: "A /* comment holds another /*; nested comments are refused." }
    }
    // A backslash before a line break inside the comment (Spark already continued it), before the comment's own line
    // break, or at the very end of the text (the wrapper's line break would continue it).
    // U+0085, U+000B and U+000C end a line for some readers; Spark keeps them in the comment (review #1, LOW 3).
    if (token.type === SqlBaseLexer.SIMPLE_COMMENT && /[\u0085\u000b\u000c]/u.test(text)) {
      return { code: "STATEMENT_NOT_READ", detail: "A -- comment holds U+0085, a vertical tab or a form feed, which some readers treat as a line break." }
    }
    if (token.type === SqlBaseLexer.SIMPLE_COMMENT && /\\(?:\r|\n|$)/u.test(text)) {
      return { code: "STATEMENT_NOT_READ", detail: "A -- comment has a backslash before a line break, which continues it onto the next line in Spark." }
    }
  }
  for (let index = 0; index < visible.length; index++) {
    const token = visible[index]!
    if (!options.allowIdentifier && token.type === SqlBaseLexer.IDENTIFIER_KW && visible[index + 1]?.type === SqlBaseLexer.LEFT_PAREN) {
      return { code: "IDENTIFIER_REFUSED", detail: "IDENTIFIER(…) chooses a table or function name at run time." }
    }
    if (token.type === SqlBaseLexer.QUESTION) return { code: "SQL_INVALID", detail: "Positional ? markers are not supported; use :name markers with params." }
  }
  return undefined
}

// ── step 2: the walk ─────────────────────────────────────────────────────

const unquote = (text: string) => (text.startsWith("`") && text.endsWith("`") && text.length >= 2 ? text.slice(1, -1).replaceAll("``", "`") : text)

/** The dot-separated parts of a multipartIdentifier, qualifiedName or identifierReference, unquoted and lower-cased. */
export function nameParts(ctx: ParserRuleContext): string[] {
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

const isTerminal = (node: ParseTree): node is TerminalNode => node instanceof TerminalNode

function descendants(ctx: ParserRuleContext, predicate: (node: ParserRuleContext) => boolean): ParserRuleContext[] {
  const found: ParserRuleContext[] = []
  const visit = (node: ParseTree) => {
    if (isTerminal(node)) return
    const rule = node as ParserRuleContext
    if (predicate(rule)) found.push(rule)
    for (const child of rule.children) visit(child)
  }
  visit(ctx)
  return found
}

const ruleName = (ctx: ParserRuleContext) => SqlBaseParser.ruleNames[ctx.ruleIndex] ?? ""

/** The parts of a functionName, or undefined for `IDENTIFIER(…)`, which the token rule already refused. */
function functionNameParts(ctx: FunctionNameContext): string[] | undefined {
  const first = ctx.getChild(0)
  if (first && isTerminal(first)) {
    if (first.symbol.type === SqlBaseLexer.IDENTIFIER_KW) return undefined
    return [first.getText().toLowerCase()]
  }
  const qualified = ctx.qualifiedName()
  return qualified ? nameParts(qualified) : undefined
}

/** `<format>.\`<path>\`` reads files directly (review #1, LOW 4): the formats Spark and Databricks read by path. */
export const PATH_FORMATS: ReadonlySet<string> = new Set(["delta", "parquet", "json", "csv", "text", "orc", "avro", "binaryfile", "xml"])

/** Any character outside ASCII. */
const NON_ASCII = /[^\u0000-\u007f]/u

/**
 * A function name with a non-ASCII character is refused on the read path (review of #2, R2-M1). Spark compares the
 * system qualifiers with Java's `equalsIgnoreCase` (`ſystem` is `system`) but looks names up with
 * `toLowerCase(Locale.ROOT)` (`poſexplode` is not `posexplode`), and Databricks' matching is undocumented, so no single
 * reading of such a name is safe: the plugin decides only names written in ASCII, exactly as they are sent.
 */
const NON_ASCII_NAME: Refusal = { code: "SQL_INVALID", detail: "A function name is written with a non-ASCII character, which Spark and Databricks may read as another name.", next: "Write the function's name in ASCII." }

/** Tokens whose text is the user's own: names, strings, comments and white space. Every other token is a keyword or symbol. */
const FREE_TEXT: ReadonlySet<number> = new Set([
  SqlBaseLexer.IDENTIFIER,
  SqlBaseLexer.BACKQUOTED_IDENTIFIER,
  SqlBaseLexer.STRING_LITERAL,
  SqlBaseLexer.DOUBLEQUOTED_STRING,
  SqlBaseLexer.BEGIN_DOLLAR_QUOTED_STRING,
  SqlBaseLexer.DOLLAR_QUOTED_STRING_BODY,
  SqlBaseLexer.END_DOLLAR_QUOTED_STRING,
  SqlBaseLexer.SIMPLE_COMMENT,
  SqlBaseLexer.BRACKETED_COMMENT,
  SqlBaseLexer.WS,
])

/**
 * A keyword spelt with a non-ASCII letter: the lexer reads upper case, so `ſubstring` is the keyword SUBSTRING (ſ upper-
 * cases to S). That covers the keyword forms' names (`EXTRACT`, `TRIM`, `current_date`, …) and FILTER, LEFT and RIGHT
 * as function names; refused like a non-ASCII function name.
 */
export function nonAsciiKeyword(tokens: readonly Token[]): boolean {
  return tokens.some((token) => token.channel === 0 && token.type !== -1 && !FREE_TEXT.has(token.type) && NON_ASCII.test(token.text ?? ""))
}

/** What a change target is, from the statement form that names it (review of #7, contract request 5). */
export type TargetKind = "table" | "schema" | "catalog" | "function" | "other"

/**
 * A statement-level name: the object a statement creates, changes or drops (DROP, DELETE, MERGE's target, INSERT's
 * table, CREATE … AS, ALTER, DROP SCHEMA, DROP FUNCTION, RENAME's both names), never a table a query inside it reads
 * (those are `tables`). `kind` comes from the statement form: `…Namespace…` is a schema, `…Func…` a function, a
 * procedure, variable or flow is `other`, and every other form names a table or view. `catalog` is reserved for
 * Databricks' own catalog statements, which the pinned grammar does not parse (they plan as `run`).
 */
export interface ChangeTarget {
  /** Unquoted, lower-cased parts as written; **empty** when the name is chosen through `IDENTIFIER(…)`. */
  readonly parts: readonly string[]
  readonly kind: TargetKind
}

export interface Walk {
  readonly invocations: Invocation[]
  readonly tables: TableReference[]
  /** The statement's own targets, in text order (contract request 5 of #7). `tables` is unchanged by them. */
  readonly targets: ChangeTarget[]
  readonly keywordForms: string[]
  readonly refusals: Refusal[]
  readonly statement: string
}

/** Walks every node of a parse tree once. Shared by the read path and the plan path. */
export function walk(tree: ParserRuleContext): Walk {
  const result: Walk = { invocations: [], tables: [], targets: statementTargets(tree), keywordForms: [], refusals: [], statement: "" }
  const ctes = new Set(descendants(tree, (node) => ruleName(node) === "namedQuery").map((node) => unquote(node.getChild(0)!.getText()).toLowerCase()))
  const visit = (node: ParseTree) => {
    if (isTerminal(node)) return
    const ctx = node as ParserRuleContext
    const name = contextName(ctx)
    const rule = ruleName(ctx)
    if (Object.hasOwn(KEYWORD_FORMS, name)) {
      const form = KEYWORD_FORMS[name as keyof typeof KEYWORD_FORMS]
      if (form.kind === "refused") {
        const onFunction = ctx.children.some((child) => isTerminal(child) && child.symbol.type === SqlBaseLexer.ON)
        if (name !== "SampleByBucketContext" || onFunction) result.refusals.push({ code: form.code, detail: `${form.example.split(" ")[0]}… is refused: ${form.builds}.` })
      } else result.keywordForms.push(name)
    }
    if (rule === "predicate" && (ctx as unknown as { _kind?: Token })._kind?.type === SqlBaseLexer.BETWEEN) result.keywordForms.push("Between")
    if (name === "ErrorIdentContext") result.refusals.push({ code: "SQL_INVALID", detail: "An unquoted name has a dash; quote it with backquotes." })
    if (name === "IdentifierLiteralContext") result.refusals.push({ code: "IDENTIFIER_REFUSED", detail: "IDENTIFIER('…') names an object through a string." })
    if (name === "FunctionCallContext" || rule === "tableFunctionCall") {
      const fn = (ctx as unknown as { functionName(): FunctionNameContext }).functionName()
      const parts = functionNameParts(fn)
      if (NON_ASCII.test(fn.getText())) result.refusals.push(NON_ASCII_NAME)
      if (!parts) result.refusals.push({ code: "IDENTIFIER_REFUSED", detail: "IDENTIFIER(…) as a function name chooses it at run time." })
      else {
        const position = rule === "tableFunctionCall" ? "table" : "scalar"
        const countStar = position === "scalar" && parts.length === 1 && parts[0] === "count" && /^count\(\*\)/iu.test(ctx.getText().replace(/\s+/gu, ""))
        result.invocations.push({ node: position === "table" ? "tableFunctionCall" : "functionCall", parts, position, decision: decideFunction(parts, position), start: fn.start!.start, stop: fn.stop!.stop, countStar })
      }
    }
    if (rule === "lateralView") {
      const qualified = descendants(ctx, (child) => ruleName(child) === "qualifiedName")[0] as QualifiedNameContext | undefined
      if (qualified) {
        const parts = nameParts(qualified)
        if (NON_ASCII.test(qualified.getText())) result.refusals.push(NON_ASCII_NAME)
        result.invocations.push({ node: "lateralView", parts, position: "table", decision: decideFunction(parts, "table"), start: qualified.start!.start, stop: qualified.stop!.stop, countStar: false })
      }
    }
    const tableNode = name === "TableNameContext" ? "tableName" : name === "ChangelogTableNameContext" ? "changelogTableName" : name === "StreamTableNameContext" ? "streamTableName" : rule === "functionTableSubqueryArgument" ? "tableArgument" : undefined
    if (tableNode) {
      const ref = descendants(ctx, (child) => ruleName(child) === "multipartIdentifier")[0]
      if (ref) {
        const parts = nameParts(ref)
        const pathRead = (parts.length === 2 && PATH_FORMATS.has(parts[0]!)) || parts.some((part) => /[/:\\]/u.test(part))
        result.tables.push({ parts, node: tableNode, pathRead, maybeCte: parts.length === 1 && ctes.has(parts[0]!) })
      }
    }
    for (const child of ctx.children) visit(child)
  }
  visit(tree)
  return result
}

/** Rules a statement's own targets are never inside: a query (CREATE … AS, INSERT … SELECT, a subquery) or a FROM relation. */
const QUERY_RULES: ReadonlySet<string> = new Set(["query", "relation"])

/** The kind of object an `identifierReference` names, from the statement form it sits in (its parent context). */
export function targetKind(statementForm: string): TargetKind {
  if (/Namespace|^(?:Use|ShowTables|ShowViews|ShowFunctions|ShowTableExtended|ShowProcedures)Context$/u.test(statementForm)) return "schema"
  if (/Func/u.test(statementForm)) return "function"
  if (/Procedure|^CallContext$|Variable|Cursor|PipelineFlow/u.test(statementForm)) return "other"
  return "table"
}

/**
 * Collects the statement-level `identifierReference` nodes (and a rename's new name), outside any query or FROM
 * relation. A labelled `source` (MERGE … USING t, CREATE TABLE … LIKE t) is read, not changed, so it is not a target.
 */
function statementTargets(tree: ParserRuleContext): ChangeTarget[] {
  const found: ChangeTarget[] = []
  const visit = (node: ParseTree) => {
    if (isTerminal(node)) return
    const ctx = node as ParserRuleContext
    const rule = ruleName(ctx)
    if (QUERY_RULES.has(rule)) return
    if (rule === "identifierReference") {
      const parent = ctx.parent as (ParserRuleContext & { _source?: unknown }) | null
      if (parent && parent._source === ctx) return
      const named = ctx.children.length === 1 && !isTerminal(ctx.getChild(0)!) ? nameParts(ctx.getChild(0) as ParserRuleContext) : []
      found.push({ parts: named, kind: targetKind(parent ? contextName(parent) : "") })
      return
    }
    if (contextName(ctx) === "RenameTableContext") {
      const to = (ctx as ParserRuleContext & { _to?: ParserRuleContext })._to
      for (const child of ctx.children) visit(child)
      if (to) found.push({ parts: nameParts(to), kind: "table" })
      return
    }
    for (const child of ctx.children) visit(child)
  }
  visit(tree)
  return found
}

/** The statement alternative under `singleStatement`: a context name such as `StatementDefaultContext`. */
export function statementKind(parsed: Parsed): string {
  const top = parsed.tree?.getChild(0)
  return top && !isTerminal(top) ? contextName(top as ParserRuleContext) : "none"
}

/** Statements that only change session state; refused in reads and in plans. */
export const SESSION_STATEMENTS: ReadonlySet<string> = new Set([
  "SetPathContext",
  "SetConfigurationContext",
  "SetQuotedConfigurationContext",
  "ResetConfigurationContext",
  "ResetQuotedConfigurationContext",
  "SetTimeZoneContext",
  "SetVariableContext",
  "FailSetRoleContext",
  "UseContext",
  "UseNamespaceContext",
  "SetCatalogContext",
  "CreateVariableContext",
  "DropVariableContext",
  "DeclareCursorStatementContext",
  "OpenCursorStatementContext",
  "FetchCursorStatementContext",
  "CloseCursorStatementContext",
  "CreateTempViewUsingContext",
  "CacheTableContext",
  "UncacheTableContext",
  "ClearCacheContext",
  "ManageResourceContext",
])

const SEVERITY: Readonly<Record<string, number>> = { SECRET_FUNCTION_REFUSED: 0, FUNCTION_REFUSED: 1, IDENTIFIER_REFUSED: 2, SQL_INVALID: 3, NEEDS_PLAN: 4, SQL_UNSUPPORTED: 5, FUNCTION_NAME_PARTIAL: 6 }

/** The first refusal by severity: a secret before a refused function before anything that only needs a plan. */
function worst(refusals: readonly Refusal[]): Refusal | undefined {
  return [...refusals].sort((a, b) => (SEVERITY[a.code] ?? 9) - (SEVERITY[b.code] ?? 9))[0]
}

/**
 * Every allowlisted, unqualified, explicit built-in call, qualified as `system.builtin.<name>` (LOW 3). Not a
 * `LATERAL VIEW` generator: Spark v4.3.0's AstBuilder (`withGenerate` → `visitFunctionName`) takes only one or two
 * parts there, so it stays as written and is path-sensitive instead (review #1, M1). Not `count(*)`, which AstBuilder
 * rewrites by its bare name.
 */
export function qualifyBuiltins(sql: string, invocations: readonly Invocation[]): string {
  const edits = invocations
    .filter((call) => call.decision.kind === "builtin" && call.parts.length === 1 && !call.countStar && call.node !== "lateralView")
    .map((call) => {
      const name = call.decision.name
      return { start: call.start, stop: call.stop, text: `${PATH_RULE.qualifier}.${isKeyword(name) ? `\`${name}\`` : name}` }
    })
    .sort((a, b) => b.start - a.start)
  // Spark's character indexes count code points; JavaScript strings index UTF-16 units.
  const points = Array.from(sql)
  for (const edit of edits) points.splice(edit.start, edit.stop - edit.start + 1, ...Array.from(edit.text))
  return points.join("")
}

/** Design §5.1 steps 1 and 2 over one read's text. */
export function analyzeRead(input: string): ReadResult {
  const textRefusal = textRules(stripTrailingSemicolon(input))
  if (textRefusal) return { ok: false, refusal: textRefusal }
  const sql = stripTrailingSemicolon(input)
  const parsed = parseStatement(sql)
  if (!parsed.ok || !parsed.tree) {
    if (/\bfrom\s+table\s*\(/iu.test(sql)) return { ok: false, refusal: { code: "SQL_UNSUPPORTED", detail: "TABLE(f(…)) in FROM is not in the pinned Spark grammar.", next: "Write FROM f(…) instead." } }
    return refuse("SQL_UNSUPPORTED", "The pinned Spark grammar cannot parse this text.")
  }
  const kind = statementKind(parsed)
  if (SESSION_STATEMENTS.has(kind)) return refuse("SESSION_STATEMENT_REFUSED", "Session statements such as SET, SET PATH and USE are refused.")
  if (kind !== "StatementDefaultContext") return refuse("STATEMENT_NOT_READ", "The text is a statement, not a query.")
  if (nonAsciiKeyword(parsed.tokens)) return { ok: false, refusal: { code: "SQL_INVALID", detail: "A keyword is written with a non-ASCII letter, which the lexer reads as its ASCII form.", next: "Write keywords and function names in ASCII." } }
  const found = walk(parsed.tree)
  const refusals = [...found.refusals]
  for (const call of found.invocations) {
    const decision = call.decision
    if (decision.kind === "refused") refusals.push({ code: decision.code, detail: `${decision.name} is not allowed in a read: ${decision.why}`, ...(decision.category ? { category: decision.category } : {}) })
    else if (decision.kind === "unknown" && call.position === "table") refusals.push({ code: "NEEDS_PLAN", detail: `${decision.name} in a table position is a user-defined table function or not on the allowlist.`, category: "run" })
    else if (decision.kind === "unknown" && call.parts.length < 3) {
      refusals.push({ code: "FUNCTION_NAME_PARTIAL", detail: `${decision.name} is not an allowlisted built-in, and a one- or two-part name resolves along the SQL path, not where the plugin checks it.`, next: "Write the function's full name, catalog.schema.function." })
    }
    if (call.node === "lateralView" && call.parts.length > 2) refusals.push({ code: "SQL_UNSUPPORTED", detail: "A LATERAL VIEW generator takes a one- or two-part name in Spark.", next: "Write the generator unqualified, such as LATERAL VIEW explode(arr)." })
  }
  const first = worst(refusals)
  if (first) return { ok: false, refusal: first }
  const rewritten = qualifyBuiltins(sql, found.invocations)
  const sent = wrap(rewritten)
  // The rewritten, wrapped text must parse as one query with the same calls, now qualified.
  const check = parseStatement(sent)
  if (!check.ok || !check.tree || statementKind(check) !== "StatementDefaultContext") return refuse("SQL_UNSUPPORTED", "The qualified form of the query does not parse; write the built-in calls qualified as system.builtin.<name>.")
  const after = walk(check.tree).invocations.map((call) => call.decision.kind === "builtin" ? `builtin:${call.decision.name}` : `${call.decision.kind}:${call.parts.join(".")}`).sort()
  const before = found.invocations.map((call) => call.decision.kind === "builtin" ? `builtin:${call.decision.name}` : `${call.decision.kind}:${call.parts.join(".")}`).sort()
  if (JSON.stringify(after) !== JSON.stringify(before)) return refuse("SQL_UNSUPPORTED", "Qualifying the built-in calls changed what the query calls.")
  const pathSensitive: PathSensitive[] = []
  for (const form of found.keywordForms) {
    const entry = KEYWORD_FORMS[form as keyof typeof KEYWORD_FORMS]
    if (entry.kind !== "named") continue
    if (form === "CurrentLikeContext") continue // decided per name below
    pathSensitive.push({ kind: "keyword-form", name: entry.names[0]! })
  }
  for (const node of descendants(parsed.tree, (ctx) => contextName(ctx) === "CurrentLikeContext")) {
    const name = node.getText().toLowerCase()
    if (!NILADIC_FIXED.has(name)) pathSensitive.push({ kind: "keyword-form", name })
  }
  for (const call of found.invocations) if (call.countStar) pathSensitive.push({ kind: "count-star", name: "count" })
  for (const call of found.invocations) if (call.node === "lateralView" && call.decision.kind === "builtin" && call.parts.length === 1) pathSensitive.push({ kind: "keyword-form", name: call.decision.name })
  for (const table of found.tables) if (table.parts.length < 3 && !table.maybeCte && !table.pathRead) pathSensitive.push({ kind: "table", name: table.parts.join(".") })
  return {
    ok: true,
    sql,
    rewritten,
    sent,
    invocations: found.invocations,
    userFunctions: found.invocations.filter((call) => call.decision.kind === "unknown"),
    tables: found.tables,
    keywordForms: [...new Set(found.keywordForms)],
    pathSensitive,
  }
}
