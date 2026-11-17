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
 *   same read-path rules and recursed. A view that depends on a connection or a credential needs a plan. A view whose
 *   dependencies are not provided, or whose body is not returned: `DEPENDENCIES_UNKNOWN` as a warning by default — a
 *   view is data its owner published — and a refusal when a fence or an inline rule applies, or under
 *   `strictDependencies`.
 * - A path read (`delta.\`/path\``) cannot be resolved before the run: refused with `FENCE_UNVERIFIABLE` when a fence is
 *   set (design §5.4), allowed otherwise (no fence can be checked, and nothing else can).
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
 * - A SQL function is allowed only when its body is returned, parses, and passes the same rules recursively; a body that
 *   is not returned, does not parse, or sits deeper than `dependencyDepth` is `NEEDS_PLAN`.
 *
 * Resolution is cached per account for 5 minutes and only ever feeds the read path's decision (design §5.4).
 */
import { analyzeRead, type Invocation, type PathSensitive, type ReadAnalysis } from "../sql/analyze.js"
import { DatabricksError, type WarningCode } from "../domain/errors.js"
import type { Options } from "../options.js"
import type { DatabricksPort, FunctionInfo, TableInfo } from "../ports.js"
import { RESOLUTION_TTL_MS, ttlCache, type TtlCache } from "./cache.js"
import { fenceApplies } from "./fence.js"
import { inlineApplies } from "./inline.js"
import { quoted } from "./pattern.js"

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

const needsPlan = (detail: string, next = "Plan it with databricks_plan({ sql })."): DatabricksError => new DatabricksError("NEEDS_PLAN", detail, next)

/** Refusal codes a body keeps as they are: they mean the body runs code or reads a secret, not that it is unknown. */
const THROWING: ReadonlySet<string> = new Set(["SECRET_FUNCTION_REFUSED", "FUNCTION_REFUSED", "IDENTIFIER_REFUSED", "NEEDS_PLAN"])

interface ResolveInput {
  readonly ports: ResolverPorts
  readonly account: string
  readonly catalog?: string
  readonly schema?: string
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

  private unknownView(full: string, table: TableInfo): void {
    const noBody = !table.viewDefinition
    const noDependencies = !table.viewDependencies
    if (noBody) this.warnings.push({ code: "VIEW_BODY_UNREAD", message: `Unity Catalog did not return the definition of the view ${quoted(full)} to this identity, so its calls were not checked.` })
    if (noDependencies) this.warnings.push({ code: "DEPENDENCIES_UNKNOWN", message: `Unity Catalog records no dependencies for the view ${quoted(full)}, so its tables and functions were not checked.` })
    if (!noBody && !noDependencies) return
    const strict = this.fence() || inlineApplies(this.ports.options, this.account) || this.ports.options.strictDependencies
    if (!strict) return
    throw new DatabricksError(
      "DEPENDENCIES_UNKNOWN",
      `The view ${quoted(full)} does not say what it depends on${noBody ? ", and its definition was not returned" : ""}; with a fence, an inline rule or strictDependencies, the read cannot be checked.`,
      "Read the table the view selects from, or ask its owner to make its dependencies visible.",
    )
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

  /** One table reference the read names, at `depth` hops from the caller's own text. */
  async table(parts: readonly string[], reference: { readonly pathRead: boolean; readonly maybeCte: boolean }, depth: number, signal: AbortSignal): Promise<void> {
    if (reference.pathRead) {
      if (this.fence()) throw new DatabricksError("FENCE_UNVERIFIABLE", `The path read ${quoted(parts.join("."))} cannot be checked against the fence before it runs.`, "Read the table by its Unity Catalog name.")
      return
    }
    const full = qualify(parts, this.input.catalog, this.input.schema)
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
    if (!isView(table)) return
    if (depth >= this.input.depth) throw needsPlan(`The view chain from ${quoted(full)} is deeper than dependencyDepth (${this.input.depth}).`)
    const dependencies = table.viewDependencies
    let unknown = dependencies === undefined || table.viewDefinition === undefined
    if (!unknown && dependencies) {
      for (const dependency of dependencies) {
        if (dependency.kind === "connection" || dependency.kind === "credential") {
          throw needsPlan(`The view ${quoted(full)} depends on the ${dependency.kind} ${quoted(dependency.name)}, which reaches outside the query.`)
        }
      }
      for (const dependency of dependencies) if (dependency.kind === "function") await this.functionByName(dependency.name, depth + 1, signal)
      for (const dependency of dependencies) if (dependency.kind === "table") await this.table(partsOf(dependency.name), { pathRead: false, maybeCte: false }, depth + 1, signal)
    }
    if (table.viewDefinition) {
      const body = this.analyseQuery(table.viewDefinition, `the view ${full}`)
      if (!body) unknown = true
      else await this.followBody(body, depth + 1, signal)
    }
    if (unknown) this.unknownView(full, table)
  }

  /** One function call from the caller's text, at `depth` hops. */
  async call(invocation: Invocation, depth: number, signal: AbortSignal): Promise<void> {
    if (invocation.parts[0] === "system") {
      throw needsPlan(`${quoted(invocation.parts.join("."))} is in the system catalog and is not one of the built-ins the read path allows.`, "Use an allowlisted built-in, or plan the statement with databricks_plan({ sql }).")
    }
    await this.functionByName(invocation.parts.join("."), depth, signal)
  }

  /** A function by its full name, from a call, a view's dependencies or another function's body. */
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
    for (const dependency of routine.routineDependencies ?? []) {
      if (dependency.kind === "connection" || dependency.kind === "credential") {
        throw needsPlan(`The function ${quoted(full)} depends on the ${dependency.kind} ${quoted(dependency.name)}, which reaches outside the query.`)
      }
    }
    if (depth >= this.input.depth) throw needsPlan(`The function chain from ${quoted(full)} is deeper than dependencyDepth (${this.input.depth}).`)
    this.known.add(full)
    const body = this.analyseExpression(routine.routineDefinition, `the function ${full}`)
    if (!body) throw needsPlan(`The body of the function ${quoted(full)} does not parse as one expression the read path allows.`)
    await this.followBody(body, depth + 1, signal)
  }

  /** A view's definition: one query, read through the same rules (design §5.4). */
  private analyseQuery(text: string, what: string): ReadAnalysis | undefined {
    return this.analyse(analyzeRead(text), what)
  }

  /** A SQL function's body: one expression, so it is read as `SELECT <body>` (design §5.4). */
  private analyseExpression(text: string, what: string): ReadAnalysis | undefined {
    return this.analyse(analyzeRead(`SELECT ${text}`), what)
  }

  /**
   * A body is not the caller's text. A construct that runs code or reads a secret refuses the read outright, with the
   * code the read path would give the same text; a name the plugin cannot check (`FUNCTION_NAME_PARTIAL`) is
   * `NEEDS_PLAN`. What is left — text the pinned grammar cannot parse, or a statement where a query belongs — makes the
   * body *unknown*, and the caller decides: a view is a warning (or a refusal under a fence), a function `NEEDS_PLAN`.
   */
  private analyse(analysis: ReturnType<typeof analyzeRead>, what: string): ReadAnalysis | undefined {
    if (!analysis.ok) {
      const refusal = analysis.refusal
      if (THROWING.has(refusal.code)) throw new DatabricksError(refusal.code, `${what}: ${refusal.detail}`, refusal.next)
      if (refusal.code === "FUNCTION_NAME_PARTIAL") throw needsPlan(`${what} calls a function the plugin cannot check: ${refusal.detail}`, "Write the function's full name, catalog.schema.function, or plan the statement.")
      return undefined
    }
    for (const invocation of analysis.invocations) {
      if (invocation.decision.kind !== "refused") continue
      const decision = invocation.decision
      throw new DatabricksError(decision.code, `${what} calls ${decision.name}: ${decision.why}`, "Plan the statement, or read the table the view selects from.")
    }
    return analysis
  }

  /** Recurse into a body's calls, tables and path-sensitive forms. */
  private async followBody(body: ReadAnalysis, depth: number, signal: AbortSignal): Promise<void> {
    for (const invocation of body.userFunctions) await this.call(invocation, depth, signal)
    for (const table of body.tables) await this.table(table.parts, table, depth, signal)
    for (const form of body.pathSensitive) this.pathSensitive.push(form)
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
