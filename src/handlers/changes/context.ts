/**
 * What the change tools share (design §5.5, §6.2): the account and feature a call needs, the warehouse a plan previews
 * and a commit re-checks, and the one submit a committed statement makes.
 *
 * **Nothing here sends a statement.** `databricks_plan` calls only `warehouses.get` and `tables.get` (free reads,
 * design §5.5 step 4) and never `EXPLAIN`s anything (step 3), so this module has no path to `submit` except
 * `submitChange`, which only a commit calls.
 *
 * **The warehouse, as a plan promises.** A plan reads the warehouse once and previews what committing will do:
 *
 * - `RUNNING` (or `STARTING`): the statement runs there, and no start is involved.
 * - `STOPPED`: a plan may still be made, because a change is a deliberate act and the preview can say what it costs —
 *   but only when the start policy allows it (`startVerdict`, design §6.2). The preview then says plainly that
 *   committing starts the warehouse and bills until it auto-stops, and the plan records that intent.
 * - anything else: `WAREHOUSE_STOPPED`.
 *
 * A commit re-reads the warehouse and honours **exactly** what the plan previewed: a start happens only when the plan
 * said so, it asserts `databricks.start` on `<account>:warehouse:<id>` before anything is charged or started (so a
 * person's rule can stop it), it is charged to the ledger before Databricks is asked, and the commit waits for
 * `RUNNING`. A warehouse that moved out from under the plan in any other way answers `PLAN_CHANGED`: the person
 * previewed one thing and would get another.
 */
import { DatabricksError, WARNINGS } from "../../domain/errors.js"
import { chargeStart, chargeStatement } from "../../provider/guards/budget.js"
import type { Warning } from "../../provider/guards/dependencies.js"
import { describe, sizeOf, stateClass, usdPerHour } from "../../provider/guards/warehouse.js"
import type { StatementAnswer, StatementRequest, Warehouse } from "../../ports.js"
import type { Deps } from "../deps.js"
import type { Feature } from "../../methods.js"
import type { Call } from "../types.js"
import { queryTags, statementRef, type ParamLike, typeOf, waitTimeoutOf } from "../reads/context.js"

export { accountOf, warehouseUse } from "../reads/context.js"

/** How long between two `warehouses.get` calls while a commit waits for a warehouse to start. */
export const START_POLL_MS = 1000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The API family a tool needs (design §3.3). With fine-grained scopes the sign-in carries exactly the families it asked
 * for, so a missing one is `AUTH_SCOPE_MISSING` **before** any call: the server would refuse it anyway, and the message
 * can name the option that fixes it.
 */
export function requireFeature(deps: Deps, account: string, feature: Feature, what: string): void {
  const identity = deps.auth.account(account)
  if (identity.features.includes(feature)) return
  throw new DatabricksError(
    "AUTH_SCOPE_MISSING",
    `${what} needs the ${feature} API family, and this account's sign-in does not carry it.`,
    `Add "${feature}" to accounts.${account}.features and sign in again, or ask the admin to allow the ${feature} scope on the app connection.`,
  )
}

/** What a plan promised about the warehouse. */
export type WarehouseIntent = "running" | "start"

/**
 * What a plan promised, kept in `Plan.fingerprint.policy` as JSON so the commit can compare it (design §5.5's "Commit
 * re-checks the warehouse policy and the targets", and the review of #7's LOW 4: a fingerprint that holds names only
 * misses a target that changed type, or a warehouse that was resized after the preview showed its price).
 */
export interface PlanPolicy {
  readonly kind: "sql" | "job" | "notebook" | "warehouse"
  /** The warehouse the plan previewed, with the shape the preview's price was based on. */
  readonly warehouse?: {
    readonly id: string
    readonly intent: WarehouseIntent
    readonly size: string
    readonly minClusters: number
    readonly maxClusters: number
    readonly autoStopMinutes: number
  }
  /** Each target with its kind, type and CASCADE contents, so a retyped target or a changed drop set is a change. */
  readonly targets?: readonly { readonly name: string; readonly kind: string; readonly type?: string; readonly children?: readonly { readonly name: string; readonly kind: string }[] }[]
  /** A job plan's job and, once `getJob` lands, a hash of the settings the preview listed. */
  readonly job?: { readonly jobId: number; readonly settings?: string }
  /** A notebook plan's path. */
  readonly notebook?: { readonly path: string }
}

export const encodePolicy = (policy: PlanPolicy): string => JSON.stringify(policy)

/** A plan's policy, or undefined for a plan written before this field held JSON. */
export function decodePolicy(text: string | undefined): PlanPolicy | undefined {
  if (!text) return undefined
  try {
    const parsed = JSON.parse(text) as PlanPolicy
    return typeof parsed === "object" && parsed !== null && typeof parsed.kind === "string" ? parsed : undefined
  } catch {
    return undefined
  }
}

export interface PlannedWarehouse {
  readonly warehouse: Warehouse
  readonly intent: WarehouseIntent
  readonly warnings: readonly Warning[]
}

/**
 * The plan's read of the warehouse (design §5.5 step 4, §6.2). Sends nothing and starts nothing: a stopped warehouse
 * refuses the plan, with the start method as its next step, so the start's ask is never hidden in a change.
 */
export async function planWarehouse(deps: Deps, input: { readonly account: string; readonly warehouseId: string; readonly signal: AbortSignal }): Promise<PlannedWarehouse> {
  const warehouse = await deps.databricks.getWarehouse(input.account, input.warehouseId, input.signal)
  const state = stateClass(warehouse.state)
  if (state === "ready" || state === "starting") return { warehouse, intent: "running", warnings: [] }
  throw new DatabricksError("WAREHOUSE_STOPPED", `The warehouse ${describe(warehouse, deps.options)} is stopped, and a plan writes nothing.`, `Start it with databricks_start({ warehouse: ${JSON.stringify(warehouse.id)} }), then plan the change.`)
}

/** The one line a preview uses for the warehouse. */
export function warehouseNote(warehouse: Warehouse, intent: WarehouseIntent, deps: Deps): string {
  void intent
  if (warehouse.state === "STARTING") return `The warehouse ${describe(warehouse, deps.options)} is starting; committing this plan waits for it to be running.`
  return `Runs on ${describe(warehouse, deps.options)}; the warehouse is already running.`
}

/** The preview's `warehouse`, in the contract's shape. A plan starts nothing, so `started` is always false. */
export function warehouseUseOf(warehouse: Warehouse, deps: Deps): { id: string; name: string; started: boolean; usdPerHour: number } {
  return { id: warehouse.id, name: warehouse.name, started: false, usdPerHour: usdPerHour(warehouse, deps.options) }
}

async function waitForRunning(deps: Deps, account: string, warehouse: Warehouse, wait: number, signal: AbortSignal): Promise<Warehouse | undefined> {
  const seconds = Math.max(0, wait)
  let current = warehouse
  for (let elapsed = 0; elapsed < seconds; elapsed++) {
    if (signal.aborted) throw new DatabricksError("CANCELLED")
    await sleep(START_POLL_MS)
    current = await deps.databricks.getWarehouse(account, warehouse.id, signal)
    if (current.state === "RUNNING") return current
    if (current.state !== "STARTING") return undefined
  }
  return current.state === "RUNNING" ? current : undefined
}

const planChanged = (detail: string, next = "Plan the change again, and show the new preview before committing it."): DatabricksError =>
  new DatabricksError("PLAN_CHANGED", detail, next)

export interface EnsuredChangeWarehouse {
  readonly warehouse: Warehouse
  readonly started: boolean
  readonly warnings: readonly Warning[]
}

/**
 * The commit's re-check of the warehouse policy (design §5.5, §6.2). Honours only what the plan previewed: a start
 * happens when the plan recorded that intent, and never otherwise.
 */
export async function ensureChangeWarehouse(
  deps: Deps,
  input: {
    readonly account: string
    readonly warehouseId: string
    readonly intent: WarehouseIntent
    /** The warehouse's shape at plan time: a resize since the preview is PLAN_CHANGED. */
    readonly planned?: { readonly size: string; readonly minClusters: number; readonly maxClusters: number; readonly autoStopMinutes: number }
    readonly wait: number
    readonly sessionID: string
    readonly messageID?: string
    readonly callID?: string
    readonly signal: AbortSignal
  },
): Promise<EnsuredChangeWarehouse> {
  const warehouse = await deps.databricks.getWarehouse(input.account, input.warehouseId, input.signal)
  if (input.planned) {
    const now = { size: warehouse.clusterSize, minClusters: warehouse.minNumClusters, maxClusters: warehouse.maxNumClusters, autoStopMinutes: warehouse.autoStopMins }
    const changed = (Object.keys(now) as (keyof typeof now)[]).filter((key) => now[key] !== input.planned![key])
    if (changed.length) {
      throw planChanged(`The warehouse ${describe(warehouse, deps.options)} changed since the plan was made: ${changed.map((key) => `${key} was ${String(input.planned![key])} and is ${String(now[key])}`).join("; ")}.`)
    }
  }
  const state = stateClass(warehouse.state)
  if (state === "ready") return { warehouse, started: false, warnings: [] }
  if (state === "starting") {
    const running = await waitForRunning(deps, input.account, warehouse, input.wait, input.signal)
    if (!running) throw planChanged(`The warehouse ${describe(warehouse, deps.options)} is still starting and did not reach RUNNING within ${input.wait} seconds.`)
    return { warehouse: running, started: false, warnings: [] }
  }
  // This plugin never starts a warehouse inside a change: a start is its own method, so its ask is not hidden in a
  // plan the person approved for another reason. A stopped warehouse refuses here, before anything is sent.
  throw planChanged(`The warehouse ${describe(warehouse, deps.options)} is ${warehouse.state.toLowerCase()} now, and this plan needs it running.`, `Start it with databricks_start({ warehouse: ${JSON.stringify(warehouse.id)} }), then commit the plan again.`)
}

/** A parameter as the commit sends it: the plan stores the caller's own values. */
export function commitParameters(params: readonly { name: string; value: unknown; type?: string }[] | undefined): readonly { name: string; value: string | null; type?: string }[] | undefined {
  if (!params?.length) return undefined
  return params.map((param) => {
    const value = param.value as ParamLike["value"]
    const type = param.type ?? typeOf(value)
    return { name: param.name, value: value === null ? null : String(value), ...(type ? { type } : {}) }
  })
}

export interface SubmittedChange {
  readonly answer: StatementAnswer
  readonly durationMs: number
}

/**
 * The one submit a commit makes (design §5.5): the plan's exact text, with `oc_plan=<planId>` alongside the `oc_*` tags
 * of every statement, the warehouse's own wait and `on_wait_timeout: CANCEL` at or below 50 seconds so Databricks itself
 * stops a change nobody is watching. Never retried: the Statement API has no idempotency key (design §9).
 */
export async function submitChange(
  deps: Deps,
  input: {
    readonly account: string
    readonly planId: string
    readonly call: Call
    readonly statement: string
    readonly warehouse: Warehouse
    readonly tool: string
    readonly parameters?: readonly { name: string; value: string | null; type?: string }[]
    readonly catalog?: string
    readonly schema?: string
    readonly wait: number
  },
): Promise<SubmittedChange> {
  const startedAt = deps.clock.now()
  const request: StatementRequest = {
    account: input.account,
    operation: "sql.statements.change",
    statement: input.statement,
    warehouseId: input.warehouse.id,
    ...(input.catalog ? { catalog: input.catalog } : {}),
    ...(input.schema ? { schema: input.schema } : {}),
    ...(input.parameters?.length ? { parameters: input.parameters } : {}),
    byteLimit: 1024 * 1024,
    disposition: "INLINE",
    format: "JSON_ARRAY",
    waitTimeout: waitTimeoutOf(input.wait),
    onWaitTimeout: input.wait <= 50 ? "CANCEL" : "CONTINUE",
    queryTags: queryTags(input.tool, input.call, { oc_plan: input.planId }),
  }
  const answer = await deps.databricks.submit(request, input.call.signal)
  const durationMs = Math.max(0, deps.clock.now() - startedAt)
  if (answer.ambiguous && !answer.statementId) {
    throw new DatabricksError("UNAVAILABLE", "The submit got no answer, so the change may have run.", `Check it before calling again: databricks_history({}) shows the statement, and Query History records the oc_plan tag ${input.planId}.`)
  }
  // B's client joins a statement it found by this call's own `oc_call` tag after a submit that got no answer (design §9).
  // That is the statement this commit sent, not an unknown one, so its state and id are reported rather than thrown
  // away; nothing is retried.
  if (answer.state === "SUCCEEDED" || answer.state === "FAILED" || answer.state === "CANCELED") {
    const size = sizeOf(input.warehouse)
    if (size) {
      await chargeStatement(deps.ledger, deps.clock, deps.options, {
        account: input.account,
        sessionId: input.call.sessionID,
        warehouseId: input.warehouse.id,
        statementId: answer.statementId,
        size,
        autoStopMinutes: input.warehouse.autoStopMins,
        clusters: Math.max(1, input.warehouse.numClusters ?? input.warehouse.minNumClusters ?? 1),
        durationMs,
      })
    }
  }
  return { answer, durationMs }
}

/** The refusal a committed statement's terminal answer carries, or undefined when it succeeded. */
export function changeFailure(answer: StatementAnswer): DatabricksError | undefined {
  if (answer.state === "SUCCEEDED") return undefined
  const provider = answer.error ? { ...answer.error, trust: "untrusted" as const } : undefined
  if (answer.state === "FAILED") return new DatabricksError("STATEMENT_FAILED", "Databricks ran the change and it failed.", "Fix it as providerError says; the statement ran, so nothing is retried.", provider)
  if (answer.state === "CANCELED") return new DatabricksError("RUN_TIMEOUT", "Databricks cancelled the change at its wait (on_wait_timeout: CANCEL).", "Read the statement before retrying: databricks_history({}) shows whether any effect happened.")
  if (answer.state === "CLOSED") return new DatabricksError("RESULTS_EXPIRED", "The statement was closed, so its result is gone.", "The change itself may have run; databricks_history({}) shows its record.")
  if (answer.state === "PENDING" || answer.state === "RUNNING") {
    return new DatabricksError("UNAVAILABLE", "The change was accepted and is still running after its wait.", `Read it with ${statementRef(answer.statementId)}; nothing is retried.`)
  }
  return undefined
}

/** The next step a committed statement leaves: its id, for `databricks_statement`. */
export const statementNext = (statementId: string) => statementRef(statementId)
