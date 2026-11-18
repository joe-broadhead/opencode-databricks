/**
 * The targets a change names, and the category that follows from them (design §5.5 step 4): "Targets are checked with
 * `tables.get` or `exists`. A `CREATE` whose target exists is a replace, and so `delete`." Shared by the plan, which
 * previews the answer, and by the commit, which resolves them again and compares (`PLAN_CHANGED`): one function, so the
 * two cannot disagree about what a statement targets.
 *
 * `tables.get` is free and needs only `USE` and `SELECT` [27], so a plan stays a set of free control-plane reads. A name
 * Unity Catalog does not return is `exists: false` — that is what makes a `CREATE` over it a creation. A name the plugin
 * cannot fully qualify (one part with no schema configured) is shown as written and not checked, and a target the
 * identity cannot see is shown without `exists` rather than guessed at.
 */
import { type ParserRuleContext, TerminalNode } from "antlr4ng"
import type { Category } from "../../domain/actions.js"
import { DatabricksError } from "../../domain/errors.js"
import type { PlanClassification } from "../../domain/statements.js"
import { quoted } from "../../guards/pattern.js"
import type { DatabricksPort } from "../../ports.js"
import { nameParts, walk } from "../../sql/analyze.js"
import { contextName, parseStatement } from "../../sql/parse.js"

/** A target, as the preview shows it and as the fingerprint compares it. */
export interface Target {
  readonly name: string
  readonly type?: string
  readonly owner?: string
  readonly exists?: boolean
}

export interface CheckedTargets {
  readonly targets: readonly Target[]
  /** The names the fingerprint compares, sorted. */
  readonly names: readonly string[]
  readonly notes: readonly string[]
  /** The statement's first target exists and the statement creates it: the plan is a replace. */
  readonly replaces: boolean
}

/** The statement forms whose category `write` becomes `delete` when their first target already exists (§5.5). */
const CREATE_KINDS: ReadonlySet<string> = new Set(["CreateTableContext", "CreateTableLikeContext", "CreateViewContext", "CreateMetricViewContext", "CreatePipelineDatasetContext"])

export interface TargetDeps {
  readonly databricks: Pick<DatabricksPort, "getTable">
}

export interface TargetInput {
  readonly account: string
  readonly tables: readonly (readonly string[])[]
  readonly catalog?: string
  readonly schema?: string
  readonly signal: AbortSignal
}

/** Resolves every table a statement names, in the order it names them. */
export async function checkTargets(deps: TargetDeps, input: TargetInput): Promise<CheckedTargets> {
  const targets: Target[] = []
  const notes: string[] = []
  let replaces = false
  for (const [index, parts] of input.tables.entries()) {
    const names = [...parts]
    if (names.length === 1 && input.schema && input.catalog) names.unshift(input.schema, input.catalog)
    else if (names.length === 2 && input.catalog) names.unshift(input.catalog)
    if (names.length !== 3) {
      targets.push({ name: parts.join(".") })
      notes.push(`The name ${quoted(parts.join("."))} is not fully qualified, so it was not checked against Unity Catalog.`)
      continue
    }
    const name = names.join(".")
    try {
      const table = await deps.databricks.getTable(input.account, name, input.signal)
      targets.push({ name, type: table.tableType, ...(table.owner ? { owner: table.owner } : {}), exists: true })
      if (index === 0) replaces = true
    } catch (error) {
      if (error instanceof DatabricksError && error.code === "NOT_FOUND") {
        targets.push({ name, exists: false })
        continue
      }
      if (error instanceof DatabricksError && error.code === "PERMISSION_DENIED") {
        targets.push({ name })
        notes.push(`Unity Catalog did not show ${quoted(name)} to this identity, so whether it exists is unknown.`)
        continue
      }
      throw error
    }
  }
  const unique = [...new Map(targets.map((target) => [target.name, target])).values()]
  return { targets: unique, names: unique.map((target) => target.name).sort(), notes, replaces }
}

/**
 * The category a classification takes once its targets are known: a `CREATE` over an existing table or view is a
 * replace, and so `delete`. Nothing else lowers or raises a category here.
 */
export function categoryFor(classified: PlanClassification, checked: CheckedTargets): Category {
  if (classified.category === "write" && checked.replaces && CREATE_KINDS.has(classified.kind)) return "delete"
  return classified.category
}

/**
 * Every table a change names, target first: the statement-level `identifierReference` nodes (the grammar's target of
 * every DDL and DML form — `DROP TABLE identifierReference`, `DELETE FROM identifierReference`, `MERGE INTO
 * target=identifierReference USING source=identifierReference`, `CREATE TABLE … identifierReference`,
 * `ALTER TABLE identifierReference`, …) and then the relations `walk` found (a query's `tableName` nodes, a view's body).
 *
 * The walk's own `tables` list has only `tableName`, `changelogTableName`, `streamTableName` and `tableArgument` nodes,
 * which is what the read path needs; a change's target is an `identifierReference`, which it does not collect. So the
 * plan resolves the same list the commit will, and a person's `deny databricks.delete on work:table:*.hr.*` reaches a
 * `DELETE FROM work.hr.orders` (design §10.1's table assert).
 *
 * A CTE's name is not a table (`maybeCte`), and text with more than one statement has no single target: both are left to
 * the classifier's category, which is already `run`.
 */
export function statementTables(sql: string): readonly (readonly string[])[] {
  const statement = sql.replace(/;\s*$/u, "")
  if (statement.includes(";")) return []
  const parsed = parseStatement(statement)
  if (!parsed.ok || !parsed.tree) return []
  const top = parsed.tree.getChild(0) as ParserRuleContext
  const ordered: (readonly string[])[] = []
  const seen = new Set<string>()
  const add = (parts: readonly string[]) => {
    if (parts.length === 0 || parts.some((part) => part.length === 0)) return
    const key = parts.join(".")
    if (seen.has(key)) return
    seen.add(key)
    ordered.push(parts)
  }
  // A query has no target; its tables come from the walk below.
  if (contextName(top) !== "StatementDefaultContext") {
    for (const node of descendants(top, (child) => contextName(child) === "IdentifierReferenceContext")) {
      const multipart = (node as unknown as { multipartIdentifier(): ParserRuleContext | null }).multipartIdentifier()
      if (multipart) add(nameParts(multipart))
    }
  }
  for (const table of walk(parsed.tree).tables) if (!table.maybeCte) add(table.parts)
  return ordered
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
