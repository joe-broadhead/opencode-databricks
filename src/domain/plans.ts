/**
 * The plan store (design §4 "Plans", §5.5): single-use plans that live `planTtlSeconds` (300 by default), bound to
 * the session, agent and account that made them, as in gws. `databricks_plan` creates one; the commit tool named by its
 * category takes it once. Routing: a plan committed with another category's tool is CATEGORY_MISMATCH, and nothing is
 * consumed. In memory: a plan never outlives the process, so a restart means planning again.
 */
import { randomUUID } from "node:crypto"
import { type Category, COMMIT_TOOL, type ToolName } from "./actions.js"
import { DatabricksError } from "./errors.js"

/** What a commit needs to run and to re-check (design §5.5 "Commit re-checks the warehouse policy and the targets"). */
export type PlanPayload =
  | { readonly kind: "sql"; readonly sql: string; readonly params?: readonly { name: string; value: unknown; type?: string }[]; readonly warehouse: string; readonly catalog?: string; readonly schema?: string }
  | { readonly kind: "job"; readonly jobId: number; readonly params?: Readonly<Record<string, string>> }
  | { readonly kind: "notebook"; readonly path: string; readonly params?: Readonly<Record<string, string>>; readonly timeoutSeconds: number }
  | { readonly kind: "warehouse"; readonly id: string; readonly edit: Readonly<Record<string, unknown>> }

export interface Plan {
  /** `pln_<uuid>`; also the job run's `idempotency_token` (design §4, §15.1). */
  readonly id: string
  readonly category: Category
  /** The statement form (`DropTableContext`, `script`, `unparsed`, `job`, `notebook`, `warehouse`). */
  readonly kind: string
  readonly account: string
  readonly sessionId: string
  readonly agentId: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly payload: PlanPayload
  /** The preview shown to the person, as the plan tool returned it. */
  readonly preview: Readonly<Record<string, unknown>>
  /** What commit compares again: the targets and the warehouse policy's answer at plan time (PLAN_CHANGED). */
  readonly fingerprint: { readonly targets: readonly string[]; readonly warehouse?: string; readonly policy?: string }
  readonly reason?: string
}

export type NewPlan = Omit<Plan, "id" | "createdAt" | "expiresAt">

export interface Caller {
  readonly sessionId: string
  readonly agentId: string
  readonly account: string
}

export interface PlanStorePort {
  create(plan: NewPlan): Plan
  /** Takes a plan for `tool` once: throws PLAN_NOT_FOUND, PLAN_ALREADY_USED, PLAN_EXPIRED, PLAN_CALLER_MISMATCH or CATEGORY_MISMATCH. */
  take(id: string, tool: ToolName, caller: Caller): Plan
  /** A plan's state without taking it, for status and tests. */
  peek(id: string): { readonly plan: Plan; readonly used: boolean } | undefined
}

export interface PlanStoreOptions {
  readonly ttlSeconds: number
  readonly now?: () => number
  readonly id?: () => string
  /** Plans kept, oldest dropped first: a session cannot grow memory without bound. */
  readonly max?: number
}

/** The commit tool for a category. */
export const commitToolFor = (category: Category): ToolName => COMMIT_TOOL[category]

export function createPlanStore(options: PlanStoreOptions): PlanStorePort {
  const now = options.now ?? Date.now
  const newId = options.id ?? (() => `pln_${randomUUID()}`)
  const max = options.max ?? 200
  const plans = new Map<string, { plan: Plan; used: boolean }>()
  return {
    create(input) {
      const createdAt = now()
      const plan: Plan = { ...input, id: newId(), createdAt, expiresAt: createdAt + options.ttlSeconds * 1000 }
      plans.set(plan.id, { plan, used: false })
      while (plans.size > max) plans.delete(plans.keys().next().value!)
      return plan
    },
    take(id, tool, caller) {
      const entry = plans.get(id)
      if (!entry) throw new DatabricksError("PLAN_NOT_FOUND")
      const { plan } = entry
      if (plan.sessionId !== caller.sessionId || plan.agentId !== caller.agentId || plan.account !== caller.account) throw new DatabricksError("PLAN_CALLER_MISMATCH")
      if (entry.used) throw new DatabricksError("PLAN_ALREADY_USED")
      if (now() >= plan.expiresAt) throw new DatabricksError("PLAN_EXPIRED")
      const expected = commitToolFor(plan.category)
      if (tool !== expected) throw new DatabricksError("CATEGORY_MISMATCH", `This is a ${plan.category} plan.`, `Commit it with databricks_${expected}({ planId }).`)
      entry.used = true
      return plan
    },
    peek(id) {
      const entry = plans.get(id)
      return entry ? { plan: entry.plan, used: entry.used } : undefined
    },
  }
}
