/**
 * Every code the plugin raises, in one table (design §12), in the family form `CODE: What happened. Next step: What to
 * do.` The README's Troubleshooting rows and docs/errors.md are generated from this table (`errorRows`), and a test
 * fails when they differ. Databricks' own error text never goes in `message` or `next`: it goes only in
 * `providerError`, marked untrusted (design §5.8).
 */

export type ErrorState = "refused" | "failed"

export interface ErrorEntry {
  /** `refused`: the plugin or Databricks declined before any effect. `failed`: something ran or was attempted. */
  readonly state: ErrorState
  /** What happened, one sentence. */
  readonly what: string
  /** The next step, one sentence. */
  readonly next: string
}

export const ERRORS = {
  // Shared with every plugin of the family.
  HOST_UNTESTED: { state: "refused", what: "This OpenCode version is outside the tested range.", next: "Use a tested OpenCode release, or set the option allowUntestedHost." },
  OPTIONS_INVALID: { state: "refused", what: "A plugin option is invalid or unknown.", next: "Fix the plugin's options in opencode.json; the message names the option." },
  SKILLS_INVALID: { state: "refused", what: "A packaged skill is missing or malformed.", next: "Reinstall the plugin." },
  CANCELLED: { state: "failed", what: "The call was stopped, and the statement it started was cancelled.", next: "Call the tool again if you still need the result." },
  INPUT_INVALID: { state: "refused", what: "The input does not fit the tool's schema.", next: "Check the input against the tool's schema, then call it again." },
  RULES_NOT_ADDED: { state: "failed", what: "The default permission rules could not be added to the agents.", next: "Restart OpenCode." },
  STATUS_UNAVAILABLE: { state: "failed", what: "Status could not be computed right now.", next: "Try again in a few seconds; if it persists, restart OpenCode." },
  NOT_RELEASED: { state: "refused", what: "This copy is not a released install, so Databricks was not called.", next: "Wait for a release tag: only a tagged release calls Databricks." },
  // Auth (design §3).
  AUTH_REQUIRED: { state: "refused", what: "No usable Databricks credential: none stored, a refresh failed, or the configured role differs from the one bound at sign-in.", next: "Run /connect and choose Databricks, or run opencode auth login databricks-<alias>." },
  AUTH_SCOPE_MISSING: { state: "refused", what: "The sign-in lacks the API scope this call needs, so Databricks was not called.", next: "Add the feature and sign in again, or ask the admin to allow the scope on the app connection." },
  AUTH_CLIENT_INVALID: { state: "refused", what: "Databricks refused the OAuth client, its scopes or its redirect URL.", next: "Check the client ID; for invalid_scope choose the other scope set on the form; app changes can take 30 minutes." },
  HOST_INVALID: { state: "refused", what: "The workspace URL is not https, or not a Databricks host.", next: "Enter the workspace URL from the browser, or set allowCustomHost for a private link." },
  // Warehouses and cost (design §6).
  WAREHOUSE_REQUIRED: { state: "refused", what: "No SQL warehouse was given or configured.", next: "Call databricks_warehouses({}), then pass warehouse." },
  WAREHOUSE_STOPPED: { state: "refused", what: "The warehouse is stopped and the call did not ask to start it.", next: "Use a running warehouse, or pass start: true." },
  START_REFUSED: { state: "refused", what: "The start policy refuses this warehouse: not serverless, too large, or its auto-stop is too long or off.", next: "Use another warehouse; maxStartSize and maxStartAutoStopMinutes are your options to raise." },
  RUN_SIZE_REFUSED: { state: "refused", what: "The warehouse is larger than maxRunSize, so an agent may not run on it.", next: "Use a smaller warehouse, or raise maxRunSize." },
  WAREHOUSE_FORBIDDEN: { state: "refused", what: "The identity has no Can use permission on the warehouse.", next: "Ask the warehouse's owner for Can use." },
  BUDGET_REACHED: { state: "refused", what: "An opt-in budget with action refuse is spent.", next: "Wait for the reset, or raise the budget option." },
  STOP_NOT_PERMITTED: { state: "refused", what: "Stopping needs Can manage, or other users' statements are not visible without Can monitor.", next: "Ask the warehouse's owner to stop it." },
  // Permissions and lookups.
  PERMISSION_DENIED: { state: "refused", what: "Unity Catalog or an access control list refused the call.", next: "Ask for the privilege the message names." },
  NOT_FOUND: { state: "refused", what: "The catalog, schema, table, function, statement, job or run was not found or is not visible.", next: "Call databricks_catalog with filter to find the name." },
  // The read path (design §5).
  SQL_INVALID: { state: "refused", what: "The plugin's parser or Databricks rejected the SQL.", next: "Fix it; databricks_table lists columns, and databricks_explain checks a read." },
  STATEMENT_NOT_READ: { state: "refused", what: "A read tool got text that is not one query, has a semicolon, or has a refused construct.", next: "Plan it with databricks_plan({ sql })." },
  SQL_UNSUPPORTED: { state: "refused", what: "The pinned Spark grammar cannot parse this text, so it fails closed.", next: "Rewrite it in standard Spark SQL, or plan it with databricks_plan, where it is category run." },
  IDENTIFIER_REFUSED: { state: "refused", what: "A read used IDENTIFIER(…), a name chosen at run time.", next: "Write the table or function name literally, and pass values in params." },
  SESSION_STATEMENT_REFUSED: { state: "refused", what: "SET, SET PATH, RESET, USE, DECLARE, temporary objects and other session statements are refused: the API keeps no session, and a changed path could redirect a function name.", next: "Pass catalog, schema and params on the call instead; for SET TAG, write ALTER … SET TAGS, which plans as run." },
  PATH_NOT_DEFAULT: { state: "refused", what: "The workspace's SQL path does not put system.builtin before every user schema, so a keyword-form built-in could resolve to a user function.", next: "Ask an admin to restore the default path, or write the function call form, which the plugin qualifies as system.builtin." },
  NEEDS_PLAN: { state: "refused", what: "A read calls a function that is not on the built-in allowlist, a user-defined table function, an external function, or a function whose body cannot be read.", next: "Plan it with databricks_plan({ sql })." },
  FUNCTION_NAME_PARTIAL: { state: "refused", what: "A read calls a function that is not an allowlisted built-in by a one- or two-part name, which Databricks resolves along the SQL path, not where the plugin checks it.", next: "Write the function's full name, catalog.schema.function." },
  FUNCTION_REFUSED: { state: "refused", what: "reflect, java_method, try_reflect, a script transform or a bucket sample on a function is refused.", next: "Do it another way; these run code outside SQL." },
  SECRET_FUNCTION_REFUSED: { state: "refused", what: "secret, try_secret and list_secrets are refused.", next: "Do not read secrets through the agent." },
  DEPENDENCIES_UNKNOWN: { state: "refused", what: "A view's dependencies cannot be resolved while a fence or an inline rule applies.", next: "Name tables fully and avoid views without recorded dependencies." },
  FENCE_UNVERIFIABLE: { state: "refused", what: "A path-based read cannot be checked against the fence.", next: "Read the table by its Unity Catalog name." },
  INLINE_WITHHELD: { state: "refused", what: "This account's inline rules keep these rows out of the conversation.", next: "Run it with databricks_save({ sql }) to write them to a file." },
  FENCED: { state: "refused", what: "A resolved table is outside the fence, or a permission rule denied it.", next: "Query allowed catalogs only, or change the fence option." },
  // Plans (design §5.5).
  STATEMENT_UNKNOWN: { state: "refused", what: "This version does not classify that statement form.", next: "Run it in the Databricks SQL editor, or update the plugin." },
  CATEGORY_MISMATCH: { state: "refused", what: "A read was sent to plan, or a plan was committed with another category's tool.", next: "Use the tool the message names." },
  PLAN_NOT_FOUND: { state: "refused", what: "No plan has that id.", next: "Plan the change again with databricks_plan." },
  PLAN_ALREADY_USED: { state: "refused", what: "That plan was already committed; a plan runs once.", next: "Plan the change again with databricks_plan." },
  PLAN_EXPIRED: { state: "refused", what: "The plan is older than planTtlSeconds.", next: "Plan the change again with databricks_plan." },
  PLAN_CALLER_MISMATCH: { state: "refused", what: "The plan belongs to another session, agent or account.", next: "Plan the change again in this session." },
  PLAN_CHANGED: { state: "refused", what: "At commit, the category, the targets or the warehouse policy changed.", next: "Plan the change again with databricks_plan." },
  ADMIN_DISABLED: { state: "refused", what: "Admin plans are turned off by this plugin's admin.enabled option.", next: "Set admin.enabled to true, or make the change in Databricks." },
  ADMIN_REASON_REQUIRED: { state: "refused", what: "An admin plan needs a reason.", next: "Plan again with reason." },
  // Runs and results.
  RATE_LIMITED: { state: "failed", what: "Databricks answered 429 or REQUEST_LIMIT_EXCEEDED after retries.", next: "Make the same call after retryAfterSec." },
  STATEMENT_FAILED: { state: "failed", what: "The warehouse ran the statement and it failed.", next: "Fix it as providerError says, or check it with databricks_statement." },
  RUN_TIMEOUT: { state: "failed", what: "Databricks cancelled the read at its wait, or the plugin did at maxRunSeconds.", next: "Narrow the query, or pass a longer wait (above 50 seconds the limit is the plugin's)." },
  RESULTS_EXPIRED: { state: "refused", what: "The statement's results are gone (kept 12 hours) or its links expired beyond re-reading.", next: "Run it again; the result cache may serve it." },
  EXTERNAL_LINK_REFUSED: { state: "refused", what: "A result link was not https on the cloud's storage host.", next: "Report it; databricks_save falls back only when links are unavailable." },
  SAVE_PATH_REFUSED: { state: "refused", what: "The save path is outside the project and allowedRoots.", next: "Save under resultsDir, or add the folder to allowedRoots." },
  SAVE_EXISTS: { state: "refused", what: "A file already exists at the save path.", next: "Pass overwrite: true, or choose another path." },
  SAVE_LIMIT: { state: "refused", what: "The result is larger than maxSaveRows or maxSaveBytes; the partial file was removed.", next: "Filter or aggregate the query, or raise the limit." },
  CLASSIFICATION_DRIFT: { state: "failed", what: "Query History's statement type differed from the plan or the read, and it was recorded.", next: "Report it; databricks_history shows the statement." },
  UNAVAILABLE: { state: "failed", what: "Databricks or the network failed, or an ambiguous submit was not found in history.", next: "Make the same call later; after an ambiguous submit, check databricks_history first." },
} as const satisfies Record<string, ErrorEntry>

export type Code = keyof typeof ERRORS
export const CODES = Object.keys(ERRORS).sort() as Code[]

/** Warnings: carried in a result's `warnings`, never a refusal (design §12). */
export const WARNINGS = {
  ESTIMATE_ONLY: "Cost figures are estimates from list prices.",
  SAVE_INLINE_FALLBACK: "External links were unavailable, so the result was read inline (25 MiB at most).",
  MASKED_COLUMNS: "A column has a mask: values are what Databricks returns to this identity.",
  ROW_FILTERED: "A table has a row filter: rows are what Databricks returns to this identity.",
  DEPENDENCIES_UNKNOWN: "A view's dependencies are not recorded, so its functions were not checked.",
  AUTO_STOP_OFF: "The warehouse never auto-stops.",
  AUTO_STOP_LONG: "The warehouse auto-stops after more than 30 minutes.",
  SCOPE_WIDER_THAN_FEATURES: "The sign-in's scopes are wider than the features configured.",
  ROLE_CAN_WRITE: "The role holds a grant beyond reading.",
  STARTED_WAREHOUSE: "This call started a stopped warehouse, which bills until it auto-stops.",
  CLASSIFICATION_DRIFT: "Query History reported a different statement type, and it was recorded.",
  BUDGET_OVER: "An opt-in budget with action warn is exceeded; the estimate is in status.",
  SPEND_UNAVAILABLE: "system.billing.usage could not be read for the reconciliation: no grant, no running default warehouse, or the statement failed.",
  PATH_READ: "A path read (format.`path`) cannot be checked against a fence or Unity Catalog.",
} as const

export type WarningCode = keyof typeof WARNINGS

/** The one error shape: `CODE: What happened. Next step: What to do.` */
export const errorText = (code: Code, message: string, next: string) => `${code}: ${message} Next step: ${next}`

/** Databricks' own error, kept apart from the plugin's words (design §5.8). */
export interface ProviderError {
  readonly errorCode?: string
  readonly sqlState?: string
  readonly message?: string
  readonly trust: "untrusted"
}

export class DatabricksError extends Error {
  readonly code: Code
  /** What happened, without the code or the next step. */
  readonly detail: string
  readonly nextStep: string
  readonly providerError?: ProviderError
  /** For RATE_LIMITED: the seconds to wait before the same call, when Databricks or the client's cap names them. */
  readonly retryAfterSec?: number

  constructor(code: Code, message?: string, next?: string, providerError?: ProviderError, extra?: { readonly retryAfterSec?: number }) {
    const entry: ErrorEntry = ERRORS[code]
    const what = message ?? entry.what
    const step = next ?? entry.next
    super(errorText(code, what, step))
    this.name = "DatabricksError"
    this.code = code
    this.detail = what
    this.nextStep = step
    if (providerError) this.providerError = providerError
    if (extra?.retryAfterSec !== undefined) this.retryAfterSec = extra.retryAfterSec
  }

  get state(): ErrorState {
    return ERRORS[this.code].state
  }
}

/** The rows of the README's Troubleshooting table and docs/errors.md, generated from the table. */
export function errorRows(): string {
  const escape = (text: string) => text.replaceAll("|", "\\|")
  return [
    "| Code | State | What happened | Next step |",
    "|---|---|---|---|",
    ...CODES.map((code) => `| \`${code}\` | ${ERRORS[code].state} | ${escape(ERRORS[code].what)} | ${escape(ERRORS[code].next)} |`),
  ].join("\n")
}
