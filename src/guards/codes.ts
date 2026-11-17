/**
 * The codes the contract adds in its Day 0 follow-up (review `databricks-4.md`, contract requests 5), and this package's
 * use of them until they exist:
 *
 * - `INLINE_WITHHELD`: this account's inline rules keep the rows out of the conversation;
 * - `RUN_SIZE_REFUSED`: the warehouse is above `maxRunSize` for an agent's statements;
 * - warning `BUDGET_OVER`: an opt-in budget with `action: "warn"` is exceeded;
 * - warning `PATH_READ`: a `format.\`path\`` read cannot be checked against a fence or Unity Catalog.
 *
 * `src/domain/errors.ts` is the contract's, and its table is the only place a code's words come from, so a code that is
 * not in it cannot be raised. Each helper answers the new code when the table has it and the code that means the same
 * thing today when it does not — `FENCED`, `START_REFUSED`, and no warning. The Day 0 change therefore needs no edit
 * here: the moment the entries exist, the guards use them.
 */
import { type Code, ERRORS, WARNINGS, type WarningCode } from "../domain/errors.js"

/** A code from the Day 0 follow-up, or `fallback` until the error table holds it. */
export const addedCode = (code: string, fallback: Code): Code => (Object.hasOwn(ERRORS, code) ? (code as Code) : fallback)

/** A warning from the Day 0 follow-up, or nothing until the warning table holds it. */
export const addedWarning = (code: string, message: string): { readonly code: WarningCode; readonly message: string } | undefined =>
  Object.hasOwn(WARNINGS, code) ? { code: code as WarningCode, message } : undefined
