/**
 * Dependencies: the read path's steps 3 and 4 (design §5.4) over Unity Catalog's own records — every table reference,
 * every view's dependencies and body, and every Unity Catalog function a read calls.
 *
 * **Tables** (`tables.get` [27], free, needs only USE and SELECT):
 * - A name with three parts is exactly the table; a one- or two-part name is completed from the call's `catalog` and
 *   `schema` (or the account's). A name that still cannot be completed is refused (`NOT_FOUND`): the plugin cannot check
 *   the fence on a name it cannot resolve, and the statement would fail server-side anyway.
 * - A table Unity Catalog does not return is refused (`NOT_FOUND`) — except a one-part name that the text also uses as
 *   a CTE, which is not a Unity Catalog object at all.
 * - A view (`VIEW`, `MATERIALIZED_VIEW`, `STREAMING_TABLE`, `METRIC_VIEW`) is read twice: its `view_dependencies` (the
 *   tables, functions, connections and credentials Unity Catalog recorded) and its `view_definition`, parsed with the
 *   same read-path rules. A view that depends on a connection or a credential needs a plan, and a view whose definition
 *   Unity Catalog did not return, or that does not parse, is `NEEDS_PLAN` — the recorded list alone never allows a
 *   read (review `databricks-4.md`, delta check). `strictDependencies` has nothing left to tighten here.
 * - A path read (`delta.\`/path\``) cannot be resolved before the run: refused with `FENCE_UNVERIFIABLE` when a fence is
 *   set (design §5.4), allowed otherwise with the `PATH_READ` warning.
 * - **What a view reads is the union of Unity Catalog's record and its own body**, never one of them alone. A view
 *   captures the session PATH at create time, and a later query "resolve[s] unqualified names against that captured
 *   path, not the invoker's session path" [Databricks: name resolution, "Captured path"], so a name in the body is read
 *   in the view's own context: as the recorded dependency with that last part when exactly one has it (the name the
 *   view meant when it was created), otherwise completed from the view's own catalog and schema. Every element of the
 *   union — the recorded table, the recorded function, the table the body names, the function it calls — passes the same
 *   checks, so a stale or empty `view_dependencies` cannot hide a Python call or a fenced table (review
 *   `databricks-4.md`, delta check). A body Unity Catalog did not return, or one that does not parse, is `NEEDS_PLAN`:
 *   the recorded list alone is never enough.
 *
 * **Functions** (`functions.get` [28], strict by default, design §5.4):
 * - A call the allowlist does not hold must be written `catalog.schema.function` (one- and two-part names are refused
 *   with `FUNCTION_NAME_PARTIAL` before this runs) and is sent exactly as written.
 * - A name Unity Catalog does not return, or does not show to this identity, is `NEEDS_PLAN` (`docs/ownership.md`); a
 *   name in `system` is `NEEDS_PLAN` too, because a `system.*` routine has no Unity Catalog body to check and the
 *   allowlist already decided every `system.builtin` built-in. That is the fail-closed answer to `system.ai.*`,
 *   `system.session.*` and a built-in added after the allowlist's pin (review `databricks-1.md`, LOW 2).
 * - A Python or Scala function (`routine_body: EXTERNAL`) is `NEEDS_PLAN` in v0.1.0 whatever its dependencies (live
 *   check L6), and so is a table function (a UDTF runs its owner's code, and a Python UDTF's `analyze()` runs at
 *   planning time [42]).
 * - A SQL function is allowed only when its body is returned, parses, and passes the same rules; a body that is not
 *   returned, does not parse, or sits deeper than `dependencyDepth` is `NEEDS_PLAN`.
 * - **A SQL function's names resolve along the PATH captured at `CREATE FUNCTION`**, not the caller's [Databricks: name
 *   resolution, "Captured path": "Unqualified names in the body are resolved against the PATH captured at
 *   CREATE FUNCTION, not the invoker's session path"]. What it reaches is again the union of `routine_dependencies` and
 *   its body: an unqualified call in the body is allowed only when exactly one recorded function dependency has that
 *   name, and a body that holds anything the PATH decides on (an unqualified call, a keyword form, `count(*)`, an
 *   unqualified table) additionally needs the captured path to be safe: `sql_path` [Unity Catalog function object]
 *   present and `pathIsSafe`, or `NEEDS_PLAN`. An empty `routine_dependencies` therefore hides nothing (review
 *   `databricks-4.md`, M1 and its delta check).
 *
 * Resolution is cached per account for 5 minutes and only ever feeds the read path's decision (design §5.4).
 */
import { analyzeRead, type Invocation, type PathSensitive, type ReadAnalysis, type TableReference, walk } from "../sql/analyze.js"
import { parseStatement } from "../sql/parse.js"
import { DatabricksError, WARNINGS, type WarningCode } from "../domain/errors.js"
import type { Options } from "../options.js"
import type { DatabricksPort, Dependency, FunctionInfo, TableInfo } from "../ports.js"
import { pathIsSafe } from "../domain/functions.js"
import { RESOLUTION_TTL_MS, ttlCache, type TtlCache } from "./cache.js"
import { fenceApplies } from "./fence.js"
import { quoted, safeText } from "./pattern.js"

/** A warning in the result's shape, restricted to the codes `src/domain/errors.ts` declares. */
export interface Warning {
  readonly code: WarningCode
  readonly message: string
}

export interface ResolvedRead {
  /** Every resolved table, `catalog.schema.table`, the caller's and the ones a view or function reached. */
  readonly tables: readonly string[]
  readonly warnings: readonly Warning[]
  /** Path-sensitive forms a function body added, beyond the caller's own (`PATH_NOT_DEFAULT` when the path is not safe). */
  readonly pathSensitive: readonly PathSensitive[]
}

/** What the resolver may call. A subset of `Deps`, so it can be built from the plugin's deps or a test's fake. */
export interface ResolverPorts {
  readonly options: Options
  readonly databricks: DatabricksPort
  readonly now: () => number
}

const VIEW_TYPES: ReadonlySet<string> = new Set(["VIEW", "MATERIALIZED_VIEW", "STREAMING_TABLE", "METRIC_VIEW"])

/** A table's type, upper-cased, from `table_type` [27]. */
export const isView = (table: TableInfo): boolean => VIEW_TYPES.has(table.tableType.toUpperCase())

const isNotFound = (error: unknown): boolean => error instanceof DatabricksError && error.code === "NOT_FOUND"

/** A full name's parts. A dependency's name comes from Unity Catalog, already complete. */
export const partsOf = (fullName: string): string[] => fullName.split(".")

/** The three-part name a reference means, or undefined when the call does not say enough to complete it. */
export function qualify(parts: readonly string[], catalog?: string, schema?: string): string | undefined {
  if (parts.length === 3) return parts.join(".")
  if (parts.length === 2) return catalog ? `${catalog}.${parts[0]}.${parts[1]}` : undefined
  if (parts.length === 1) return catalog && schema ? `${catalog}.${schema}.${parts[0]}` : undefined
  return undefined
}

/** The catalog and schema of an object named `catalog.schema.object`, for completing its dependencies' names. */
export function contextOf(fullName: string): ReadContext {
  const parts = partsOf(fullName)
  return parts.length === 3 ? { catalog: parts[0], schema: parts[1] } : {}
}

const needsPlan = (detail: string, next = "Plan it with databricks_plan({ sql })."): DatabricksError => new DatabricksError("NEEDS_PLAN", detail, next)

/** What a body says, as the plugin reads it (see `readBody`). */
interface Body {
  readonly invocations: readonly Invocation[]
  readonly tables: readonly TableReference[]
  /** Anything in it the captured PATH resolves: an unqualified call, a keyword form, `count(*)`, an unqualified table. */
  readonly pathDecides: boolean
}

/** Whether anything in an analysed body is a name the captured PATH decides. */
const pathDecides = (body: ReadAnalysis): boolean =>
  body.pathSensitive.length > 0 || body.invocations.some((invocation) => invocation.decision.kind === "builtin" && invocation.parts.length === 1 && !invocation.countStar)

/** The same, over a body read by `walk` when `analyzeRead` refuses a one- or two-part call. */
function pathDecidesOf(walked: ReturnType<typeof walk>): boolean {
  if (walked.keywordForms.length > 0) return true
  if (walked.invocations.some((invocation) => invocation.countStar)) return true
  if (walked.invocations.some((invocation) => invocation.decision.kind === "builtin" && invocation.parts.length === 1)) return true
  return walked.tables.some((table) => table.parts.length < 3 && !table.maybeCte && !table.pathRead)
}

/** Refusal codes a body keeps as they are: they mean the body runs code or reads a secret, not that it is unknown. */
const THROWING: ReadonlySet<string> = new Set(["SECRET_FUNCTION_REFUSED", "FUNCTION_REFUSED", "IDENTIFIER_REFUSED", "NEEDS_PLAN"])

/** Whose catalog and schema complete a one- or two-part name: the caller's, or an object's own. */
export interface ReadContext {
  readonly catalog?: string
  readonly schema?: string
}

interface ResolveInput extends ReadContext {
  readonly ports: ResolverPorts
  readonly account: string
  readonly analysis: ReadAnalysis
  /** `dependencyDepth`: how many view and function hops are followed (design §13, default 4). */
  readonly depth: number
}

/** The caches, one pair per Databricks port: one per plugin setup in production, one per fake in a test. */
interface Caches {
  readonly tables: TtlCache<TableInfo | undefined>
  readonly functions: TtlCache<FunctionInfo | undefined>
}

const caches = new WeakMap<object, Caches>()

function cachesFor(ports: ResolverPorts): Caches {
  let cache = caches.get(ports.databricks)
  if (!cache) {
    cache = { tables: ttlCache<TableInfo | undefined>(RESOLUTION_TTL_MS, ports.now), functions: ttlCache<FunctionInfo | undefined>(RESOLUTION_TTL_MS, ports.now) }
    caches.set(ports.databricks, cache)
  }
  return cache
}

class Resolver {
  private readonly tables = new Set<string>()
  private readonly visiting = new Set<string>()
  private readonly warnings: Warning[] = []
  private readonly pathSensitive: PathSensitive[] = []
  private readonly tableCache: TtlCache<TableInfo | undefined>
  private readonly functionCache: TtlCache<FunctionInfo | undefined>
  private readonly known = new Set<string>()

  constructor(private readonly input: ResolveInput) {
    const shared = cachesFor(input.ports)
    this.tableCache = shared.tables
    this.functionCache = shared.functions
  }

  private get ports(): ResolverPorts {
    return this.input.ports
  }

  private get account(): string {
    return this.input.account
  }

  private fence(): boolean {
    return fenceApplies(this.ports.options, this.account)
  }

  private async lookupTable(full: string, signal: AbortSignal): Promise<TableInfo | undefined> {
    const key = `${this.account}|${full}`
    const cached = this.tableCache.get(key)
    if (cached.hit) return cached.value
    try {
      const table = await this.ports.databricks.getTable(this.account, full, signal)
      this.tableCache.set(key, table)
      return table
    } catch (error) {
      if (isNotFound(error)) {
        this.tableCache.set(key, undefined)
        return undefined
      }
      throw error
    }
  }

  private async lookupFunction(full: string, signal: AbortSignal): Promise<FunctionInfo | undefined> {
    const key = `${this.account}|${full}`
    const cached = this.functionCache.get(key)
    if (cached.hit) return cached.value
    try {
      const routine = await this.ports.databricks.getFunction(this.account, full, signal)
      this.functionCache.set(key, routine)
      return routine
    } catch (error) {
      if (isNotFound(error)) {
        this.functionCache.set(key, undefined)
        return undefined
      }
      throw error
    }
  }

  /**
   * One table reference the read names, at `depth` hops. `context` is whose names these are: the caller's, or the view's
   * or function's own catalog and schema when the reference comes from a recorded dependency.
   */
  async table(parts: readonly string[], reference: { readonly pathRead: boolean; readonly maybeCte: boolean }, depth: number, signal: AbortSignal, context: ReadContext = this.input): Promise<void> {
    if (reference.pathRead) {
      if (this.fence()) throw new DatabricksError("FENCE_UNVERIFIABLE", `The path read ${quoted(parts.join("."))} cannot be checked against the fence before it runs.`, "Read the table by its Unity Catalog name.")
      this.warnings.push({ code: "PATH_READ", message: `The path read ${quoted(parts.join("."))} is not a Unity Catalog table, so it cannot be checked against the fence or its dependencies.` })
      return
    }
    const full = qualify(parts, context.catalog, context.schema)
    if (!full) {
      if (reference.maybeCte && parts.length === 1) return
      throw new DatabricksError(
        "NOT_FOUND",
        `The plugin cannot resolve ${quoted(parts.join("."))} without a catalog and a schema, so it cannot check the fence or the table's dependencies.`,
        "Write the table's full name, catalog.schema.table, or pass catalog and schema on the call.",
      )
    }
    if (this.visiting.has(full)) return
    const table = await this.lookupTable(full, signal)
    if (!table) {
      if (reference.maybeCte && parts.length === 1) return
      throw new DatabricksError("NOT_FOUND", `Unity Catalog does not return the table ${quoted(full)} to this identity.`, "Check the name with databricks_catalog, which lists what you can see.")
    }
    this.visiting.add(full)
    this.tables.add(full)
    if (!isView(table)) {
      this.warningsFor(table, full)
      return
    }
    this.warningsFor(table, full)
    if (depth >= this.input.depth) throw needsPlan(`The view chain from ${quoted(full)} is deeper than dependencyDepth (${this.input.depth}).`)
    const what = quoted(full)
    const own = contextOf(full)
    const recorded = table.viewDependencies ?? []
    const body = table.viewDefinition === undefined ? undefined : this.readBody(table.viewDefinition, `the view ${full}`, false)
    if (!body) {
      throw needsPlan(
        `Unity Catalog did not return the definition of the view ${what} to this identity, or it does not parse as one query, so the plugin cannot tell what it reads.`,
        "Plan it with databricks_plan({ sql }), or ask the view's owner to make its definition visible.",
      )
    }
    // The union: Unity Catalog's record, and everything the body names, read in the view's own context.
    await this.dependencies(what, recorded, depth, signal, own)
    await this.bodyTables(what, body.tables, recorded, depth, signal, own)
    await this.bodyCalls(what, body.invocations, recorded, depth, signal)
  }

  /** One function call from the caller's text, at `depth` hops. */
  async call(invocation: Invocation, depth: number, signal: AbortSignal): Promise<void> {
    if (invocation.parts[0] === "system") {
      throw needsPlan(`${quoted(invocation.parts.join("."))} is in the system catalog and is not one of the built-ins the read path allows.`, "Use an allowlisted built-in, or plan the statement with databricks_plan({ sql }).")
    }
    await this.functionByName(invocation.parts.join("."), depth, signal)
  }

  /**
   * A function by its full name, from a call, a view's or function's `routine_dependencies`, or the caller's text.
   *
   * Its `routine_dependencies` are authoritative for what it reaches — a Python or Scala function, a table function, an
   * unreadable body or an unknown dependency is `NEEDS_PLAN` however it is named — and a body that resolves anything
   * along the PATH needs the path captured at `CREATE FUNCTION` to be safe, because Databricks resolves that body's
   * unqualified names there and not in the caller's session (review `databricks-4.md`, M1).
   */
  async functionByName(full: string, depth: number, signal: AbortSignal): Promise<void> {
    if (full.split(".").length !== 3) {
      // A dependency's name comes from Unity Catalog complete; a call is checked here anyway.
      throw needsPlan(`The plugin can only check a function named catalog.schema.function, and ${quoted(full)} has ${full.split(".").length} parts.`)
    }
    if (partsOf(full)[0] === "system") {
      throw needsPlan(`${quoted(full)} is in the system catalog and is not one of the built-ins the read path allows.`, "Use an allowlisted built-in, or plan the statement with databricks_plan({ sql }).")
    }
    if (this.known.has(full)) return
    const routine = await this.lookupFunction(full, signal)
    if (!routine) throw needsPlan(`Unity Catalog does not return the function ${quoted(full)} to this identity, so the plugin cannot check its body.`)
    if (routine.isTableFunction) throw needsPlan(`The function ${quoted(full)} is a table function; a user-defined table function always needs a plan.`)
    if (routine.routineBody !== "SQL") throw needsPlan(`The function ${quoted(full)} is a Python or Scala function (${quoted(routine.externalLanguage ?? "EXTERNAL", 40)}), whose code the plugin cannot check.`)
    if (!routine.routineDefinition) throw needsPlan(`Unity Catalog did not return the body of the function ${quoted(full)} to this identity.`)
    if (depth >= this.input.depth) throw needsPlan(`The function chain from ${quoted(full)} is deeper than dependencyDepth (${this.input.depth}).`)
    this.known.add(full)
    const what = quoted(full)
    const context = contextOf(full)
    const recorded = routine.routineDependencies ?? []
    const body = this.readBody(routine.routineDefinition, `the function ${full}`, true)
    if (!body) throw needsPlan(`The body of the function ${what} does not parse as one expression the read path allows, so the plugin cannot tell what it calls.`)
    // The union: Unity Catalog's record, and everything the body names, resolved the way the body resolved it at creation.
    await this.dependencies(what, recorded, depth, signal, context)
    await this.bodyCalls(what, body.invocations, recorded, depth, signal)
    await this.bodyTables(what, body.tables, recorded, depth, signal, context)
    this.assertCapturedPath(body.pathDecides, routine, full)
  }

  /**
   * Everything Unity Catalog records as a dependency of a view or a function, walked exactly as the caller's own tables
   * are: a connection or a credential needs a plan, a function is checked as a function, and a table is fenced and
   * asserted. Names that are not full are completed from the object's own catalog and schema, never the caller's.
   */
  private async dependencies(what: string, list: readonly Dependency[], depth: number, signal: AbortSignal, context: ReadContext): Promise<void> {
    // `what` is the object's name, already quoted for the plugin's own words.
    for (const dependency of list) {
      if (dependency.kind === "connection" || dependency.kind === "credential") {
        throw needsPlan(`${what} depends on the ${dependency.kind} ${quoted(dependency.name)}, which reaches outside the query.`)
      }
    }
    for (const dependency of list) if (dependency.kind === "function") await this.functionByName(dependency.name, depth + 1, signal)
    for (const dependency of list) if (dependency.kind === "table") await this.table(partsOf(dependency.name), { pathRead: false, maybeCte: false }, depth + 1, signal, context)
  }

  /**
   * The PATH Databricks captured when the function was created. Anything in the body that the path decides on — an
   * unqualified call (the allowlist's built-ins included: in a body nothing is qualified, so `upper` is whatever the
   * captured path names first), a keyword form, `count(*)`, an unqualified table — is only allowed when UC returned
   * `sql_path` and `pathIsSafe` holds for it. No `sql_path`, or an unsafe one, is `NEEDS_PLAN`.
   */
  private assertCapturedPath(pathDecides: boolean, routine: FunctionInfo, full: string): void {
    if (!pathDecides) return
    const captured = routine.sqlPath
    if (captured === undefined) {
      throw needsPlan(
        `The function ${quoted(full)} calls names Databricks resolves along the PATH captured when it was created, and Unity Catalog did not return that path, so the plugin cannot tell what it calls.`,
        "Plan it with databricks_plan({ sql }).",
      )
    }
    if (!pathIsSafe(captured)) {
      throw needsPlan(
        `The function ${quoted(full)} was created with the SQL path ${safeText(captured, 300)}, which does not put system.builtin before every user schema, so a name in its body could resolve to a user function.`,
        "Recreate the function under the default path, or plan the statement with databricks_plan({ sql }).",
      )
    }
  }

  /**
   * What a body says, as the plugin reads it: the calls it makes, the tables it names, and whether the PATH decides any
   * of them. `undefined` when the body is not text one query or one expression — the caller then needs a plan, because
   * the recorded dependencies alone are never enough.
   */
  private readBody(text: string, what: string, expression: boolean): Body | undefined {
    const analysis = analyzeRead(expression ? `SELECT ${text}` : text)
    if (analysis.ok) {
      return { invocations: analysis.invocations, tables: analysis.tables, pathDecides: pathDecides(analysis) }
    }
    const refusal = analysis.refusal
    // A construct that runs code or reads a secret refuses the read outright, with the code the read path would give it.
    if (THROWING.has(refusal.code)) throw new DatabricksError(refusal.code, `${what}: ${refusal.detail}`, refusal.next)
    // A one- or two-part call is not a refusal in a body: Databricks resolves it in the object's own captured path, and
    // the union below reconciles it with Unity Catalog's record. Parse the text again to see every name it uses.
    if (refusal.code !== "FUNCTION_NAME_PARTIAL") return undefined
    const parsed = parseStatement(expression ? `SELECT ${text}` : text)
    if (!parsed.ok || !parsed.tree) return undefined
    const walked = walk(parsed.tree)
    for (const item of walked.refusals) throw new DatabricksError(item.code, `${what}: ${item.detail}`, item.next)
    for (const invocation of walked.invocations) {
      if (invocation.decision.kind !== "refused") continue
      const decision = invocation.decision
      throw new DatabricksError(decision.code, `${what} calls ${decision.name}: ${decision.why}`, "Plan the statement, or read the table the view selects from.")
    }
    return { invocations: walked.invocations, tables: walked.tables, pathDecides: pathDecidesOf(walked) }
  }

  /**
   * Every table a body names, resolved as the object itself would resolve it: the recorded dependency with that last
   * part when exactly one has it (what the name meant where the object was created), otherwise completed from the
   * object's own catalog and schema. A name that neither source can pin, or that Unity Catalog does not return, is
   * `NEEDS_PLAN`: the two sources cannot be reconciled, so the plugin will not guess.
   */
  private async bodyTables(what: string, tables: readonly TableReference[], recorded: readonly Dependency[], depth: number, signal: AbortSignal, context: ReadContext): Promise<void> {
    const recordedTables = recorded.filter((dependency) => dependency.kind === "table").map((dependency) => dependency.name)
    for (const table of tables) {
      if (table.maybeCte) continue
      const resolved = this.reconcileTable(table.parts, recordedTables, context)
      if (!resolved) {
        throw needsPlan(
          `${what} reads ${quoted(table.parts.join("."))}, and neither its recorded dependencies nor its own catalog and schema say which table that is.`,
          "Name the table in full in the object's definition, or plan the statement with databricks_plan({ sql }).",
        )
      }
      if (table.pathRead) {
        await this.table(resolved, table, depth, signal, context)
        continue
      }
      try {
        await this.table(resolved, { pathRead: false, maybeCte: false }, depth, signal, context)
      } catch (error) {
        if (error instanceof DatabricksError && error.code === "NOT_FOUND") {
          throw needsPlan(
            `${what} reads ${quoted(table.parts.join("."))}, which Unity Catalog does not return as ${quoted(resolved.join("."))}.`,
            "Plan it with databricks_plan({ sql }), or ask the object's owner to name the table in full.",
          )
        }
        throw error
      }
    }
  }

  /**
   * Every call a body makes. A three-part name is checked as written; a one- or two-part name is what the object's
   * captured path resolved, so it is allowed only when exactly one recorded function dependency has that name — that
   * dependency is already checked — and `NEEDS_PLAN` otherwise.
   */
  private async bodyCalls(what: string, invocations: readonly Invocation[], recorded: readonly Dependency[], depth: number, signal: AbortSignal): Promise<void> {
    const recordedFunctions = recorded.filter((dependency) => dependency.kind === "function").map((dependency) => dependency.name)
    for (const invocation of invocations) {
      if (invocation.decision.kind !== "unknown") continue
      if (invocation.parts.length === 3) {
        await this.call(invocation, depth + 1, signal)
        continue
      }
      const last = invocation.parts.at(-1)?.toLowerCase()
      const matches = recordedFunctions.filter((name) => partsOf(name).at(-1)?.toLowerCase() === last)
      if (matches.length === 1) continue
      throw needsPlan(
        `${what} calls ${quoted(invocation.parts.join("."))}, which only the SQL path captured when it was created resolves, and ${matches.length === 0 ? "no recorded dependency names it" : "more than one recorded dependency could be it"}.`,
        "Write the function's full name in the object's definition, or plan the statement with databricks_plan({ sql }).",
      )
    }
  }

  /** The recorded dependency a body's name must mean, or undefined when neither source pins it. */
  private reconcileTable(parts: readonly string[], recorded: readonly string[], context: ReadContext): string[] | undefined {
    if (parts.length === 3) return [...parts]
    if (parts.length === 2) return context.catalog ? [context.catalog, ...parts] : undefined
    const last = parts[0]?.toLowerCase()
    const matches = recorded.filter((name) => partsOf(name).at(-1)?.toLowerCase() === last)
    if (matches.length > 1) return undefined
    if (matches.length === 1) return partsOf(matches[0]!)
    return context.catalog && context.schema ? [context.catalog, context.schema, parts[0]!] : undefined
  }

  /**
   * What `tables.get` already said about masks and row filters (design §5.7, review LOW 5): every read of a masked or
   * filtered table carries `MASKED_COLUMNS` and `ROW_FILTERED`, not only `databricks_table`. The functions behind them
   * stay unchecked, as Day 0 discloses.
   */
  private warningsFor(table: TableInfo, full: string): void {
    if (table.columns.some((column) => column.mask)) this.warnings.push({ code: "MASKED_COLUMNS", message: `${WARNINGS.MASKED_COLUMNS} The table ${quoted(full)} has one or more.` })
    if (table.rowFilter) this.warnings.push({ code: "ROW_FILTERED", message: `${WARNINGS.ROW_FILTERED} The table ${quoted(full)} has one.` })
  }

  result(): ResolvedRead {
    return { tables: [...this.tables], warnings: this.warnings, pathSensitive: this.pathSensitive }
  }
}

/** Resolves one read's tables and functions (design §5.4). Throws the read path's codes; never sends a statement. */
export async function resolveRead(input: ResolveInput, signal: AbortSignal): Promise<ResolvedRead> {
  const resolver = new Resolver(input)
  for (const table of input.analysis.tables) await resolver.table(table.parts, table, 0, signal)
  for (const invocation of input.analysis.userFunctions) await resolver.call(invocation, 0, signal)
  return resolver.result()
}
