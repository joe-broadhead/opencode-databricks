// A fake for every port (src/ports.ts), so each package tests its handlers without a network, an OpenCode host or a
// Databricks workspace. Invented values only: no real host, id, person or token.
import type { Options } from "../../src/options.js"
import { loadOptions } from "../../src/options.js"
import { createPlanStore } from "../../src/domain/plans.js"
import { DatabricksError } from "../../src/domain/errors.js"
import type { AccountInfo, AuthPort, Charge, Clock, DatabricksPort, LedgerPort, PermissionPort, PermissionRequest, PreparedRead, ReadGuardPort, ReadRequest, SpendTotals, Token, Warehouse } from "../../src/ports.js"
import { startsOf } from "../../src/ledger.js"
import { analyzeRead } from "../../src/sql/analyze.js"
import type { Deps } from "../../src/registry.js"

export const FAKE_HOST = "https://fake-workspace.cloud.databricks.com"
/** A running Small serverless warehouse with a 10-minute auto-stop: the fakes' default. */
export const FAKE_WAREHOUSE: Warehouse = { id: "wh-small", name: "small", state: "RUNNING", warehouseType: "PRO", serverless: true, clusterSize: "Small", autoStopMins: 10, minNumClusters: 1, maxNumClusters: 1, numClusters: 1 }
/** A token-shaped value that must never appear in an error, a status, a log line or a result. */
export const DUMMY_TOKEN = "dapi00000000000000000000000000000000-not-real"

export class FakeAuth implements AuthPort {
  readonly requests: { account: string; scopes: readonly string[] }[] = []
  constructor(
    readonly list: AccountInfo[] = [{ alias: "work", mode: "interactive", host: FAKE_HOST, cloud: "aws", features: [], warehouse: "wh-small", enforcement: "identity" }],
    readonly granted: readonly string[] = ["sql", "unity-catalog", "query-history", "openid", "email", "profile", "offline_access"],
  ) {}
  accounts() {
    return this.list
  }
  account(alias?: string) {
    const found = alias ? this.list.find((account) => account.alias === alias) : this.list[0]
    if (!found) throw new DatabricksError("AUTH_REQUIRED")
    return found
  }
  async token(account: string, scopes: readonly string[], _signal?: AbortSignal): Promise<Token> {
    this.requests.push({ account, scopes })
    const missing = scopes.filter((scope) => scope !== "any" && !this.granted.includes(scope) && !this.granted.includes("all-apis"))
    if (missing.length) throw new DatabricksError("AUTH_SCOPE_MISSING", `The sign-in lacks the ${missing.join(", ")} scope.`)
    return { accessToken: DUMMY_TOKEN, expiresAt: Date.now() + 3_600_000, scopes: this.granted, host: this.account(account).host }
  }
}

const TERMINAL: ReadonlySet<string> = new Set(["SUCCEEDED", "FAILED", "CANCELED", "CLOSED"])

/**
 * Records every call by name. A method a test has not given an answer refuses with UNAVAILABLE, except
 * `waitForStatement`, which by default polls the test's `getStatement` answer (through the port, so each poll is
 * recorded) until it is terminal or `untilMs` passes on `now` (review of #3, request 2).
 */
export function fakeDatabricks(answers: Partial<Record<keyof DatabricksPort, (...args: unknown[]) => unknown>> = {}, now: () => number = Date.now): { port: DatabricksPort; calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = []
  const port: DatabricksPort = new Proxy({} as DatabricksPort, {
    get: (_target, name) => async (...args: unknown[]) => {
      calls.push({ method: String(name), args })
      const answer = answers[name as keyof DatabricksPort]
      if (answer) return answer(...args)
      if (name === "waitForStatement" && answers.getStatement) {
        const [account, statementId, options, signal] = args as [string, string, { untilMs: number }, AbortSignal]
        for (;;) {
          const current = await port.getStatement(account, statementId, signal)
          if (TERMINAL.has(current.state) || now() >= options.untilMs) return current
        }
      }
      throw new DatabricksError("UNAVAILABLE", `The fake has no answer for ${String(name)}.`)
    },
  })
  return { port, calls }
}

export class RecordingPermission implements PermissionPort {
  readonly requests: PermissionRequest[] = []
  constructor(readonly decide: (request: PermissionRequest) => "allow" | "deny" = () => "allow") {}
  assert = async (request: PermissionRequest) => {
    this.requests.push(request)
    if (this.decide(request) === "deny") throw new Error(`denied: ${request.action} on ${request.resource}`)
  }
}

/**
 * The read path's fake: `analyzeRead` for real, then a running warehouse and no Unity Catalog checks. Records each
 * request. Package E builds `saved_read` and `save` against it while package C builds the real one.
 */
export class FakeReads implements ReadGuardPort {
  readonly requests: ReadRequest[] = []
  async prepare(request: ReadRequest): Promise<PreparedRead> {
    this.requests.push(request)
    const analysis = analyzeRead(request.sql)
    if (!analysis.ok) throw new DatabricksError(analysis.refusal.code, analysis.refusal.detail, analysis.refusal.next)
    return { sent: analysis.sent, warehouseId: request.warehouse ?? FAKE_WAREHOUSE.id, warehouse: { ...FAKE_WAREHOUSE, id: request.warehouse ?? FAKE_WAREHOUSE.id }, started: false, tables: analysis.tables.map((table) => table.parts.join(".")), enforcement: "identity", warnings: [] }
  }
}

export class MemoryLedger implements LedgerPort {
  readonly charges: Charge[] = []
  /** The clock a charge is stamped with; epoch 0 unless a test passes one. */
  constructor(readonly now: () => number = () => 0) {}
  async totals(account: string, sessionId?: string): Promise<SpendTotals> {
    const mine = this.charges.filter((charge) => charge.account === account)
    const session = mine.filter((charge) => sessionId !== undefined && charge.sessionId === sessionId)
    const sum = (list: Charge[]) => list.reduce((total, charge) => total + charge.dbuHours, 0)
    return { startsToday: mine.filter((c) => c.kind === "start").length, dbuHoursToday: sum(mine), startsSession: session.filter((c) => c.kind === "start").length, dbuHoursSession: sum(session), estimate: true }
  }
  async charge(charge: Omit<Charge, "at">) {
    this.charges.push({ ...charge, at: new Date(this.now()).toISOString() })
    return { recorded: true, totals: await this.totals(charge.account, charge.sessionId) }
  }
  async starts(account: string, sinceMs: number) {
    return startsOf(this.charges, account, sinceMs)
  }
}

export function fakeClock(start = 1_800_000_000_000): Clock & { advance(ms: number): void } {
  let now = start
  let ids = 0
  return { now: () => now, uuid: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`, advance: (ms) => void (now += ms) }
}

export interface FakeDeps {
  readonly deps: Deps
  readonly permission: RecordingPermission
  readonly databricks: ReturnType<typeof fakeDatabricks>
  readonly auth: FakeAuth
  readonly ledger: MemoryLedger
  readonly reads: FakeReads
  readonly clock: ReturnType<typeof fakeClock>
}

export function fakeDeps(input: { options?: Partial<Options> | Record<string, unknown>; permission?: RecordingPermission } = {}): FakeDeps {
  const options = loadOptions({ accounts: { work: { warehouse: "wh-small" } }, ...input.options })
  const permission = input.permission ?? new RecordingPermission()
  const databricks = fakeDatabricks()
  const auth = new FakeAuth()
  const ledger = new MemoryLedger()
  const reads = new FakeReads()
  const clock = fakeClock()
  const deps: Deps = { options, access: options.access, auth, databricks: databricks.port, reads, ledger, plans: createPlanStore({ ttlSeconds: options.planTtlSeconds, now: clock.now }), permission, clock }
  return { deps, permission, databricks, auth, ledger, reads, clock }
}

export const call = (id = "call_1", sessionID = "ses_test", agent = "build") => ({ sessionID, agent, messageID: "msg_test", id, signal: new AbortController().signal })
