/**
 * One account is one workspace (design §3.1). These are the option-derived settings, the mode-specific requirements
 * checked at setup, and the `AccountInfo` the auth port hands to every tool and to status.
 *
 * The settings hold no secret: `tokenEnv` and `clientSecretEnv` name variables, `profile` names a CLI profile, and the
 * client ID of a public app connection is public [11][12]. A missing requirement of a headless mode is an option error
 * (`OPTIONS_INVALID`) at setup, before any call: a `pat` account without `tokenEnv` can never work, and failing at
 * startup says so once instead of on every tool call.
 */
import type { Feature } from "../domain/actions.js"
import { DatabricksError } from "../domain/errors.js"
import type { Options } from "../options.js"
import type { EnforcementKind } from "../domain/contract.js"
import type { AccountInfo, Mode } from "../ports.js"
import { parseWorkspaceHost } from "./host.js"
import type { ScopeChoice } from "./scopes.js"

export const DEFAULT_ALIAS = "default"
export const HEADLESS_MODES: readonly Mode[] = ["pat", "m2m", "cli"]
export const isHeadless = (mode: Mode): boolean => HEADLESS_MODES.includes(mode)

export interface AccountSettings {
  readonly alias: string
  readonly mode: Mode
  readonly host?: string
  readonly clientId?: string
  readonly role?: string
  readonly features: readonly Feature[]
  readonly warehouse?: string
  readonly catalog?: string
  readonly schema?: string
  readonly scopes: ScopeChoice
  readonly tokenEnv?: string
  readonly clientSecretEnv?: string
  readonly profile?: string
}

/** Every configured account, or the single `default` interactive account when `accounts` is absent (design §3.1). */
export function accountSettings(options: Options): AccountSettings[] {
  const configured = options.accounts
  if (!configured) return [{ alias: DEFAULT_ALIAS, mode: "interactive", features: [], scopes: "fine" }]
  return Object.entries(configured).map(([alias, account]) => ({
    alias,
    mode: account.mode,
    ...(account.host !== undefined ? { host: account.host } : {}),
    ...(account.clientId !== undefined ? { clientId: account.clientId } : {}),
    ...(account.role !== undefined ? { role: account.role } : {}),
    features: [...account.features],
    ...(account.warehouse !== undefined ? { warehouse: account.warehouse } : {}),
    ...(account.catalog !== undefined ? { catalog: account.catalog } : {}),
    ...(account.schema !== undefined ? { schema: account.schema } : {}),
    scopes: account.scopes,
    ...(account.tokenEnv !== undefined ? { tokenEnv: account.tokenEnv } : {}),
    ...(account.clientSecretEnv !== undefined ? { clientSecretEnv: account.clientSecretEnv } : {}),
    ...(account.profile !== undefined ? { profile: account.profile } : {}),
  }))
}

/** The account `alias`, or the first one; undefined when no account has that alias. */
export function settingsOf(options: Options, alias?: string): AccountSettings | undefined {
  const all = accountSettings(options)
  return alias === undefined ? all[0] : all.find((account) => account.alias === alias)
}

const option = (alias: string, key: string) => `accounts.${alias}.${key}`

function invalidOption(alias: string, key: string, why: string, next: string): never {
  throw new DatabricksError("OPTIONS_INVALID", `${option(alias, key)} ${why}.`, next)
}

const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u
export const ROLE_GROUP = /^\d{1,40}$/u

/**
 * Check every account's mode-specific settings at setup. Interactive accounts may leave `host` and `clientId` to the
 * sign-in form; a host that is set must be valid now, so a typo fails at startup instead of at the browser.
 */
export function validateAccounts(options: Options): void {
  for (const account of accountSettings(options)) {
    const { alias, mode } = account
    if (account.host !== undefined) parseWorkspaceHost(account.host, options.allowCustomHost)
    if (account.clientId !== undefined && !CLIENT_ID.test(account.clientId)) {
      invalidOption(alias, "clientId", "is not an OAuth client ID", "Copy the client ID from the app connection in the account console.")
    }
    if (account.role !== undefined && !ROLE_GROUP.test(account.role)) {
      invalidOption(
        alias,
        "role",
        "is not a numeric group ID",
        "Use the numeric ID of the role's backing group (account console → Identity and access → Groups); Databricks' assume_group takes the group ID.",
      )
    }
    if (mode === "interactive") continue
    if (mode === "pat" && account.role !== undefined) {
      invalidOption(alias, "role", "cannot apply to mode pat", "A personal access token is the person's own identity; use interactive or m2m to assume a role.")
    }
    if (account.host === undefined) invalidOption(alias, "host", "is required for a headless mode", "Set the workspace URL, such as https://dbc-1234abcd-5678.cloud.databricks.com.")
    if (mode === "pat" && account.tokenEnv === undefined) {
      invalidOption(alias, "tokenEnv", "is required for mode pat", "Name the environment variable that holds the personal access token, for example DATABRICKS_TOKEN.")
    }
    if (mode === "m2m") {
      if (account.clientId === undefined) {
        invalidOption(alias, "clientId", "is required for mode m2m", "Set the service principal's client ID, which is its application ID.")
      }
      if (account.clientSecretEnv === undefined) {
        invalidOption(alias, "clientSecretEnv", "is required for mode m2m", "Name the environment variable that holds the OAuth secret, for example DATABRICKS_CLIENT_SECRET.")
      }
    }
    if (mode === "cli" && account.profile === undefined) {
      invalidOption(alias, "profile", "is required for mode cli", "Name the Databricks CLI profile, such as DEFAULT, that `databricks auth login` created.")
    }
  }
}

/**
 * The account as the ports see it. Undefined when no workspace host is known yet: an interactive account whose host is
 * only asked at sign-in cannot be described until that sign-in happened (or its cached summary is loaded).
 *
 * A role bound at sign-in is shown when the configuration does not name one: the person chose it on the form, and it is
 * the identity the token carries. A configured role that differs from the bound one is `AUTH_REQUIRED` at the token, so
 * it is not shown as if it were in force.
 */
export type AccountBase = Omit<AccountInfo, "enforcement">

export function accountInfo(account: AccountSettings, snapshotHost: string | undefined, allowCustomHost: boolean, roleGroupId?: string, roleName?: string): AccountBase | undefined {
  const raw = account.host ?? snapshotHost
  if (!raw) return undefined
  const { host, cloud } = parseWorkspaceHost(raw, allowCustomHost)
  const role =
    account.mode === "interactive"
      ? roleGroupId !== undefined && (account.role === undefined || account.role === roleGroupId)
        ? { groupId: roleGroupId, ...(roleName !== undefined ? { name: roleName } : {}) }
        : undefined
      : account.role !== undefined
        ? { groupId: account.role }
        : undefined
  return {
    alias: account.alias,
    mode: account.mode,
    host,
    cloud,
    features: account.features,
    ...(role ? { role } : {}),
    ...(account.warehouse !== undefined ? { warehouse: account.warehouse } : {}),
    ...(account.catalog !== undefined ? { catalog: account.catalog } : {}),
    ...(account.schema !== undefined ? { schema: account.schema } : {}),
  }
}

/**
 * The enforcement a token carries, before `doctor` proves the role (design §5.6). Status words `role-requested` as
 * "<name> (requested)" until a clean doctor report earns `role`; this package owns the doctor, package F words status.
 */
export function enforcementOf(account: Pick<AccountInfo, "mode" | "role">): EnforcementKind {
  if (account.mode === "m2m") return "service-principal"
  return account.role !== undefined ? "role-requested" : "identity"
}
