/**
 * One refusal shape for the guards: a code from the one error table, the plugin's own words, and the one next step.
 * `src/guards/read.ts` turns it into a `DatabricksError`, so a guard can decide without throwing (a test reads it as
 * data) while every refusal a caller sees is still the family form.
 */
import type { Category } from "../../methods.js"
import type { Code } from "../../domain/errors.js"

export interface Refusal {
  readonly code: Code
  readonly detail: string
  readonly next?: string
  /** For NEEDS_PLAN: the category the plan would take. */
  readonly category?: Category
}
