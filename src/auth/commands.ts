/**
 * `/databricks-doctor`, the person's own command (design §14). It is a read-only report: it asserts no tool action and
 * asks no permission prompt, because the person typed it, and every call it makes is a free control-plane read (or the
 * sign-in itself). It never starts a warehouse and never runs a statement.
 *
 * The text is built only from the plugin's own codes, the checks' details and validated values: no token, no provider
 * message, and no free text from Databricks. A synthetic message with `resume: false` puts it in the session without
 * starting a model turn.
 */
import { DISPLAY_NAME } from "../constants.js"
import type { Options } from "../options.js"
import type { AuthPort, DatabricksPort } from "../ports.js"
import { runDoctor, type DoctorReport } from "./doctor.js"
import type { AuthContext, Registration } from "./types.js"

export const DOCTOR_COMMAND = "databricks-doctor"

export interface DoctorCommandDeps {
  readonly options: Options
  readonly auth: AuthPort
  readonly databricks: () => DatabricksPort
  /** Told about every report, so an earned `role` can be remembered for status (in memory only). */
  readonly onReport?: (report: DoctorReport) => void
}

/** One account's block, in a stable order: the title, each check, the claim, then the warnings and one next step. */
export function formatAccount(report: DoctorReport): string[] {
  const place = [report.mode, report.host ?? "no workspace URL yet", report.cloud].filter(Boolean).join(", ")
  const lines = [`${report.alias} (${place}): enforcement ${report.enforcement}`]
  if (report.claim) lines.push(`Guarantee: ${report.claim}`)
  for (const item of report.checks) lines.push(`- ${item.id}: ${item.status} · ${item.detail}${item.next ? ` Next step: ${item.next}` : ""}`)
  if (report.warnings.length > 0) lines.push(`Warnings: ${report.warnings.map((warning) => `${warning.code} (${warning.message})`).join("; ")}`)
  lines.push(`Next step: ${report.nextStep}`)
  return lines
}

/** The whole report. */
export function formatDoctor(reports: readonly DoctorReport[]): string {
  const lines = [`${DISPLAY_NAME} doctor`, ""]
  if (reports.length === 0) lines.push("No account is configured.")
  for (const report of reports) lines.push(...formatAccount(report), "")
  return lines.join("\n").trimEnd()
}

/** The one line the transcript shows. */
export function summarizeDoctor(reports: readonly DoctorReport[]): string {
  if (reports.length === 0) return `${DISPLAY_NAME} doctor: no account is configured`
  const attention = reports.filter((report) => report.checks.some((item) => item.status !== "OK" && item.status !== "NOT_CHECKED" && item.status !== "ROLE_CAN_WRITE")).length
  return `${DISPLAY_NAME} doctor: ${reports.length} account${reports.length === 1 ? "" : "s"}${attention > 0 ? ` · ${attention} need${attention === 1 ? "s" : ""} attention` : ""}`
}

/** Register the command and return its registration for the plugin's cleanup. */
export async function registerDoctorCommand(ctx: Pick<AuthContext, "command" | "session">, deps: DoctorCommandDeps): Promise<Registration> {
  return ctx.command.transform((editor) => {
    editor.add({
      name: DOCTOR_COMMAND,
      description: `Check each ${DISPLAY_NAME} workspace's sign-in, identity, role and warehouse cost settings`,
      execute: async ({ sessionID, delivery }) => {
        const outcome = await runDoctor({
          options: deps.options,
          auth: deps.auth,
          databricks: deps.databricks(),
          signal: new AbortController().signal,
          now: Date.now,
        }).then(
          (reports) => {
            for (const report of reports) deps.onReport?.(report)
            return { text: formatDoctor(reports), description: summarizeDoctor(reports) }
          },
          () => ({ text: `${DISPLAY_NAME} doctor could not run.`, description: `${DISPLAY_NAME} doctor could not run` }),
        )
        await ctx.session.synthetic({ sessionID, delivery, text: outcome.text, description: outcome.description, resume: false })
      },
    })
  })
}
