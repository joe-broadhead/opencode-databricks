/**
 * The read path (design §5.1): the one entry point every read goes through, as `ReadGuardPort` (`src/ports.ts`).
 *
 * The call's own `wait` (`ReadRequest.wait`) bounds the wait for a `STARTING` warehouse, so a call that asked for 10
 * seconds does not block 50 (review `databricks-4.md`, LOW 3); it defaults to the `wait` option.
 *
 * `analyzeRead` decides steps 1 and 2 on the plugin's own parse (`src/sql/analyze.ts`), then this module does the rest:
 *
 * 3. **Dependencies** (`src/guards/dependencies.ts`): every table reference resolved with `tables.get`, every view's
 *    dependencies and body followed, every Unity Catalog function's body checked — all of them under the same rules.
 * 4. **The fence and the inline rules** (`src/guards/fence.ts`, `src/guards/inline.ts`), over the resolved source
 *    tables — never the result's columns.
 * 5. **The warehouse policy** (`src/guards/warehouse.ts`): `warehouses.get`; a stopped warehouse without an allowed
 *    start is `WAREHOUSE_STOPPED`: a start is its own method, with its own ask.
 * 6. **Tables are asserted** as `<account>:table:<c>.<s>.<t>` under the calling tool's own dotted action, before any
 *    statement is sent; the register has already asked the method's declared operations. A table's name needs
 *    `tables.get` before it can be named, so it is resolved before the statement, never after
 *    a person's rule stops the read before anything runs or bills.
 * 7. **The path check** (`src/guards/path.ts`) for the forms the plugin cannot qualify.
 *
 * The statement itself is the caller's: `prepared.sent` is exactly `analyzeRead(sql).sent` — the wrapper around the
 * caller's text with every allowlisted call qualified. A read never sends anything else.
 *
 * Every step fails closed. Anything this version cannot classify is refused or needs a plan: an unresolvable table, a
 * function Unity Catalog does not return, a body that does not parse or that resolves names along a path Unity Catalog
 * did not return, a dependency deeper than `dependencyDepth`, a path read under a fence, an inline rule the plugin
 * cannot evaluate.
 *
 * **TOCTOU**, said plainly: a warehouse that stops between the check and the submit is restarted by Databricks [18]; the
 * guard's own view of the warehouse can be one round trip stale.
 */
import { DatabricksError, WARNINGS } from "../../domain/errors.js"
import { sizeRank } from "../cost.js"
import type { Options } from "../../options.js"
import type { AuthPort, Clock, DatabricksPort, LedgerPort, PreparedRead, ReadGuardPort, ReadRequest, Warehouse } from "../../ports.js"
import { analyzeRead } from "../sql/analyze.js"
import { assertBudgetRoom } from "./budget.js"
import { resolveRead, type Warning } from "./dependencies.js"
import { fenceRefusal } from "./fence.js"
import { inlineRefusal } from "./inline.js"
import { assertPathSafe } from "./path.js"
import type { Refusal } from "./refusal.js"
import { describe, sizeOf, stateClass, stoppedRefusal } from "./warehouse.js"

/** The ports the read path needs. `Deps` (`src/registry.ts`) satisfies it. */
export interface GuardDeps {
  readonly options: Options
  readonly auth: AuthPort
  readonly databricks: DatabricksPort
  readonly ledger: LedgerPort
  readonly clock: Clock
}

/** What `prepareRead` answers: the port's `PreparedRead`, plus the warehouse it resolved (for the caller's cost text). */
export interface PreparedReadEx extends PreparedRead {
  readonly warehouse: Warehouse
  readonly warnings: readonly Warning[]
}

/** How long between two `warehouses.get` calls while a warehouse starts. */
export const START_POLL_MS = 1000

export function throwRefusal(refusal: Refusal): never {
  throw new DatabricksError(refusal.code, refusal.detail, refusal.next)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForRunning(deps: GuardDeps, account: string, warehouse: Warehouse, wait: number, signal: AbortSignal): Promise<Warehouse | undefined> {
  if (warehouse.state === "RUNNING") return warehouse
  const seconds = Math.max(0, wait)
  let current: Warehouse = warehouse
  for (let elapsed = 0; elapsed < seconds; elapsed++) {
    if (signal.aborted) throw new DatabricksError("CANCELLED")
    await sleep(START_POLL_MS)
    current = await deps.databricks.getWarehouse(account, warehouse.id, signal)
    if (current.state === "RUNNING") return current
    if (current.state !== "STARTING") return undefined
  }
  return current.state === "RUNNING" ? current : undefined
}

function checkRunSize(deps: GuardDeps, warehouse: Warehouse): void {
  const limit = deps.options.maxRunSize
  if (!limit) return
  const size = sizeOf(warehouse)
  if (size && sizeRank(size) > sizeRank(limit)) {
    throw new DatabricksError("RUN_SIZE_REFUSED", `${describe(warehouse, deps.options)} is above maxRunSize ${limit}, so an agent may not run on it.`, "Use a smaller warehouse, or raise maxRunSize.")
  }
}

interface EnsuredWarehouse {
  readonly warehouse: Warehouse
  readonly started: boolean
  readonly warnings: readonly Warning[]
}

async function ensureWarehouse(
  deps: GuardDeps,
  input: { readonly account: string; readonly warehouseId: string; readonly request: ReadRequest; readonly wait: number; readonly signal: AbortSignal; readonly warnings: Warning[] },
): Promise<EnsuredWarehouse> {
  const warehouse = await deps.databricks.getWarehouse(input.account, input.warehouseId, input.signal)
  const state = stateClass(warehouse.state)
  if (input.request.runningOnly) {
    // A source read never starts one (design §11.3): no start: true, no policy, no charge.
    if (state !== "ready") {
      throw new DatabricksError("UNAVAILABLE", `${describe(warehouse, deps.options)} is ${warehouse.state.toLowerCase()}, and this source never starts one.`, "Call databricks_start for it, or pick a warehouse that is already running.")
    }
    checkRunSize(deps, warehouse)
    return { warehouse, started: false, warnings: [] }
  }
  if (state === "ready") {
    checkRunSize(deps, warehouse)
    return { warehouse, started: false, warnings: [] }
  }
  if (state === "hopeless") throwRefusal(stoppedRefusal(warehouse, deps.options, warehouse.state))
  if (state === "starting") {
    const running = await waitForRunning(deps, input.account, warehouse, input.wait, input.signal)
    if (!running) {
      throw new DatabricksError("UNAVAILABLE", `${describe(warehouse, deps.options)} is starting and did not reach RUNNING within ${input.wait} seconds.`, "Try again in a few seconds.")
    }
    checkRunSize(deps, running)
    return { warehouse: running, started: false, warnings: [] }
  }
  // This plugin never starts a warehouse in a read: a start is its own method, with its own ask. A stopped warehouse
  // refuses here, before anything is sent.
  throwRefusal(stoppedRefusal(warehouse, deps.options, warehouse.state))
}

const dedupe = (warnings: readonly Warning[]): readonly Warning[] => {
  const seen = new Set<string>()
  return warnings.filter((warning) => {
    const key = `${warning.code}|${warning.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Steps 1–7 for one read. Answers the exact text to send and where; the caller submits it. Throws the read path's
 * codes; nothing is sent here except the `current_path()` probe, after the warehouse policy.
 */
export async function prepareRead(deps: GuardDeps, request: ReadRequest, signal: AbortSignal): Promise<PreparedReadEx> {
  const account = deps.auth.account(request.account)
  const analysis = analyzeRead(request.sql)
  if (!analysis.ok) throwRefusal(analysis.refusal)
  const configured = deps.options.accounts?.[account.alias]
  const catalog = request.catalog ?? account.catalog ?? configured?.catalog
  const schema = request.schema ?? account.schema ?? configured?.schema
  const warehouseId = request.warehouse ?? account.warehouse
  if (!warehouseId) throw new DatabricksError("WAREHOUSE_REQUIRED", "This account has no default warehouse and the call named none.", "Call databricks_warehouses({}) to choose one, then pass warehouse.")
  const resolved = await resolveRead(
    {
      ports: { options: deps.options, databricks: deps.databricks, now: deps.clock.now },
      account: account.alias,
      ...(catalog ? { catalog } : {}),
      ...(schema ? { schema } : {}),
      analysis,
      depth: deps.options.dependencyDepth,
    },
    signal,
  )
  const fence = fenceRefusal(deps.options, account.alias, resolved.tables)
  if (fence) throwRefusal(fence)
  const inline = inlineRefusal({ options: deps.options, account: account.alias, tool: request.tool, tables: resolved.tables })
  if (inline) throwRefusal(inline)
  const warehouseWarnings: Warning[] = []
  const wait = request.wait ?? deps.options.wait
  const ensured = await ensureWarehouse(deps, { account: account.alias, warehouseId, request, wait, signal, warnings: warehouseWarnings })
  await assertBudgetRoom(deps.ledger, deps.options, account.alias, request.sessionID)
  if (analysis.pathSensitive.length > 0 || resolved.pathSensitive.length > 0) {
    await assertPathSafe({ databricks: deps.databricks, now: deps.clock.now }, { account: account.alias, warehouseId: ensured.warehouse.id, sessionID: request.sessionID }, signal)
  }
  const warnings = dedupe([...resolved.warnings, ...warehouseWarnings, ...(ensured.started ? [{ code: "STARTED_WAREHOUSE" as const, message: WARNINGS.STARTED_WAREHOUSE }] : [])])
  return { sent: analysis.sent, warehouseId: ensured.warehouse.id, warehouse: ensured.warehouse, started: ensured.started, tables: resolved.tables, enforcement: account.enforcement, warnings }
}

/** The `ReadGuardPort` implementation (design §16; package E's `saved_read` and `save` call it through the port). */
export function createReadGuard(deps: GuardDeps): ReadGuardPort {
  return { prepare: (request, signal) => prepareRead(deps, request, signal) }
}
