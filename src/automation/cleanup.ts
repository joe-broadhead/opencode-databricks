/**
 * `/databricks-cleanup` (design §7, layer 4). A command, so only a person types it; an agent has no tool that reaches
 * this code, and nothing here is on the tools RPC.
 *
 * What it does, in this order:
 * 1. reports what costs money: running warehouses (with $/hour, auto-stop and the idle time of the statements this
 *    identity can see), the statements this plugin started that are still running, and the one call for each;
 * 2. at `read-only`, stops there: a report and no action, no prompt, no Databricks call that changes anything;
 * 3. at `ask-changes`, asserts each action's own dotted action (`databricks.stop`, `databricks.cancel`) through
 *    `ctx.permission.assert` **without a `source`** — the host's own prompt, which only a person answers, and which is
 *    not a session message the model could replay;
 * 4. at `all`, the typed command is the confirmation, so it asserts nothing and acts;
 * 5. runs only stops and cancels, in-process, and reports each outcome.
 *
 * It never deletes a table, file, job, warehouse or result. Cancelling a **change** statement is not offered: a change
 * can leave partial effects. A stop may end another user's statement if this identity can see it; the report names what
 * it can see and says plainly what it cannot.
 */
import type { Plugin } from "@opencode/plugin"
import { operationResource, warehouseResource } from "../domain/actions.js"
import { DatabricksError } from "../domain/errors.js"
import { safeText } from "../guards/pattern.js"
import { usdPerHour } from "../guards/warehouse.js"
import { CLEANUP_COMMAND } from "../rpc.js"
import { READ_TOOLS } from "./index.js"
import { scanAccounts, type StatusPorts } from "../status.js"

export type CleanupContext = {
  readonly command: Pick<Plugin.Context["command"], "transform">
  readonly permission: Pick<Plugin.Context["permission"], "assert">
  readonly session: Pick<Plugin.Context["session"], "synthetic">
}

type Action =
  | { readonly kind: "cancel"; readonly account: string; readonly statementId: string; readonly what: string }
  | { readonly kind: "stop"; readonly account: string; readonly warehouseId: string; readonly what: string; readonly usdPerHour: number }

/** The report and the actions it offers. Every action names its account and its plugin-built words. */
export interface CleanupPlan {
  readonly text: string
  readonly actions: readonly Action[]
}

const money = (value: number) => `$${value.toFixed(2)}`

/** What the report says and what it offers, without doing anything. */
export async function planCleanup(ports: StatusPorts, sessionID: string, signal: AbortSignal): Promise<CleanupPlan> {
  const scan = await scanAccounts(ports, sessionID, signal)
  const actions: Action[] = []
  const lines: string[] = ["Databricks cleanup"]
  const running = scan.running

  if (running.length > 0) {
    lines.push("", "Statements this plugin started that are still running:")
    for (const item of running) {
      const separator = item.id.indexOf(":")
      const account = item.id.slice(0, separator)
      const statementId = item.id.slice(separator + 1)
      const tool = item.tool
      lines.push(`- ${account}: ${tool} on ${item.warehouse ?? "a warehouse"}, started ${item.startedAt} (${statementId})`)
      if (READ_TOOLS.has(tool)) {
        actions.push({
          kind: "cancel",
          account,
          statementId,
          what: `cancel the ${safeText(tool, 40)} statement ${safeText(statementId, 64)} this plugin started on ${safeText(item.warehouse ?? "a warehouse", 40)}`,
        })
      }
    }
  }

  const warehouses = scan.scans.flatMap((item) => item.warehouses.map((entry) => ({ ...entry, account: item.account.alias, price: usdPerHour(entry.warehouse, ports.options) })))
  if (warehouses.length > 0) {
    lines.push("", "Running warehouses:")
    for (const entry of [...warehouses].sort((a, b) => b.price - a.price)) {
      const idle =
        entry.busy !== undefined
          ? `a statement is running on it (${entry.busy})`
          : entry.idleMinutes === undefined
            ? "no statement you can see in the last six hours"
            : `idle ${entry.idleMinutes} min by the statements you can see`
      lines.push(`- ${entry.account}: ${safeText(entry.warehouse.id, 64)} ${safeText(entry.warehouse.name, 60)}, ${safeText(entry.warehouse.clusterSize, 24)} ${entry.warehouse.serverless ? "serverless" : entry.warehouse.warehouseType.toLowerCase()}, auto-stop ${entry.warehouse.autoStopMins} min, about ${money(entry.price)}/hour, ${idle}`)
      actions.push({
        kind: "stop",
        account: entry.account,
        warehouseId: entry.warehouse.id,
        what: `stop warehouse ${safeText(entry.warehouse.name || entry.warehouse.id, 60)} (${safeText(entry.warehouse.id, 64)}) at about ${money(entry.price)}/hour`,
        usdPerHour: entry.price,
      })
    }
    lines.push(
      "",
      "Only the statements your identity can see are counted. Without Can monitor on a warehouse, another user's statement is invisible here, and a stop may end it; the stop needs Can manage.",
    )
  }

  lines.push("", `Access: ${ports.options.access}.`)
  if (ports.options.access === "read-only") lines.push("Read only: this command reports and takes no action.")
  else if (ports.options.access === "ask-changes") lines.push("Ask before changes: each action asks you first, and only you can answer that prompt.")
  else lines.push("Allowed: typing this command is the confirmation for each action below.")
  if (actions.length === 0) lines.push("Nothing to cancel or stop.")
  lines.push("Nothing here deletes a table, file, job, warehouse or result.")
  for (const problem of scan.problems) lines.push(`Problem: ${problem}`)

  return { text: lines.join("\n"), actions }
}

type Outcome = { readonly action: Action; readonly state: "done" | "denied" | "refused" | "not-offered"; readonly detail?: string }

async function act(ctx: CleanupContext, ports: StatusPorts, sessionID: string, action: Action): Promise<Outcome> {
  const dotted = action.kind === "stop" ? "databricks.stop" : "databricks.cancel"
  const resource = action.kind === "stop" ? warehouseResource(action.account, action.warehouseId) : operationResource(action.account, "sql.statements.cancel")
  if (ports.options.access === "ask-changes") {
    try {
      // No `source`: the host's own prompt, which only a person answers (design §7 layer 4).
      await ctx.permission.assert({ sessionID, action: dotted, resources: [resource], metadata: { what: action.what } })
    } catch {
      return { action, state: "denied", detail: "you declined it" }
    }
  }
  try {
    if (action.kind === "stop") await ports.databricks.stopWarehouse(action.account, action.warehouseId, new AbortController().signal)
    else await ports.databricks.cancelStatement(action.account, action.statementId, new AbortController().signal)
    return { action, state: "done" }
  } catch (error) {
    if (error instanceof DatabricksError) return { action, state: "refused", detail: `${error.code}: ${error.detail}` }
    return { action, state: "refused", detail: "Databricks or the network failed." }
  }
}

/** Registers `/databricks-cleanup`. */
export async function registerCleanup(ctx: CleanupContext, ports: StatusPorts): Promise<{ dispose(): Promise<void> }> {
  return ctx.command.transform((editor) => {
    editor.add({
      name: CLEANUP_COMMAND,
      description: "List what Databricks costs money and stop or cancel what you confirm; never deletes",
      execute: async ({ sessionID, delivery }) => {
        const plan = await planCleanup(ports, sessionID, new AbortController().signal)
        await ctx.session.synthetic({ sessionID, delivery, text: plan.text, description: "Databricks cleanup", resume: false })
        if (ports.options.access === "read-only" || plan.actions.length === 0) return
        const outcomes: Outcome[] = []
        for (const action of plan.actions) {
          // One prompt per action, and the next action still runs after a no (boxd C.5).
          outcomes.push(await act(ctx, ports, sessionID, action))
        }
        const summary = outcomes
          .map((outcome) => `${outcome.state === "done" ? "done" : outcome.state === "denied" ? "not done" : "failed"}: ${outcome.action.what}${outcome.detail ? ` (${outcome.detail})` : ""}`)
          .join("\n")
        await ctx.session.synthetic({ sessionID, delivery, text: `Databricks cleanup results\n${summary}\nNothing was deleted.`, description: "Databricks cleanup results", resume: false })
      },
    })
  })
}
