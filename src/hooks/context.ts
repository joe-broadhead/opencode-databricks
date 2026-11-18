/**
 * The `context` hook (design §7 layer 3, boxd C.4): one line, at most 200 characters, on the **tail** of the request,
 * only for a warehouse this plugin started that has been left running with nothing using it, and that nothing else will
 * stop (review of F, M5).
 *
 * - The line is added to the last message's parts when it is a `user` message, or in one new `user` message after a
 *   `tool` message. `system` is never touched: providers cache the prefix tools → system → messages, so any change there
 *   would uncache the whole history.
 * - The change applies to this request only (the hook's `messages`), never to the stored history.
 * - It is fingerprinted per session: the warehouse set, the access choice and the idle time in 30-minute buckets. The
 *   same fingerprint adds nothing, so a 300-warehouse fleet costs one line per real change, not one per request.
 * - Only a session that has used the plugin gets a line. The check runs over the messages added since the last request,
 *   not the whole history on every request, and a session found once stays interested.
 * - The figures come from the automation's cached snapshot (free calls, the owner's sweep), which contains only
 *   warehouses the ledger says this plugin started; a snapshot older than five minutes adds nothing. When the start
 *   record is unavailable the snapshot is empty, so the hook says nothing rather than guessing.
 */
import type { Plugin } from "@opencode/plugin"
import type { Access } from "../constants.js"
import type { Clock } from "../ports.js"
import { type Automation, burningLine, type IdleWarehouse } from "../automation/index.js"

type WireMessage = { role?: string; content?: unknown }

/** A coarse fingerprint: the same warehouses, the same access, and an idle time that moves only every 30 minutes. */
export function fingerprintOf(items: readonly IdleWarehouse[], access: string): string {
  return `${access}|${items.map((item) => `${item.account}:${item.warehouse.id}:${Math.floor((item.idleMinutes ?? 0) / 30)}`).join(",")}`
}

/** Whether an array of messages mentions this plugin: a tool name, a tool result's code, or the word in a summary. */
function mentionsDatabricks(messages: readonly WireMessage[]): boolean {
  try {
    return JSON.stringify(messages).includes("databricks_")
  } catch {
    return false
  }
}

/**
 * Appends `line` to the tail of `messages`: one text part on a final user message, else one new user message after a
 * tool message. The request only; the stored history is untouched.
 */
export function appendTail(messages: unknown[], line: string): void {
  const list = messages as WireMessage[]
  const last = list.at(-1)
  const part = { type: "text", text: line }
  if (last && last.role === "user") {
    if (Array.isArray(last.content)) last.content.push(part)
    else last.content = [part]
    return
  }
  list.push({ role: "user", content: [part] })
}

export type HookContext = { readonly session: Pick<Plugin.Context["session"], "hook"> }

/** Registers the hook. It never throws: a failure adds no line and leaves the request as built. */
export async function registerContextHook(ctx: HookContext, automation: Automation, clock: Clock, access: Access): Promise<{ dispose(): Promise<void> }> {
  const seen = new Map<string, string>()
  const interested = new Set<string>()
  const counted = new Map<string, number>()
  return ctx.session.hook("context", (event) => {
    try {
      const sessionID = String(event.sessionID)
      if (!interested.has(sessionID)) {
        const messages = event.messages as unknown as WireMessage[]
        const checked = counted.get(sessionID) ?? 0
        if (messages.length <= checked) return
        counted.set(sessionID, messages.length)
        // Only what is new since the last request: a long history is scanned once, not on every request.
        if (!mentionsDatabricks(messages.slice(checked))) return
        interested.add(sessionID)
      }
      const items = automation.burning(clock.now())
      if (items.length === 0) return
      const line = burningLine(items)
      if (!line) return
      const fingerprint = fingerprintOf(items, access)
      if (seen.get(sessionID) === fingerprint) return
      appendTail(event.messages as unknown[], line)
      seen.set(sessionID, fingerprint)
    } catch {
      // A hook failure never breaks the model request.
    }
  })
}
