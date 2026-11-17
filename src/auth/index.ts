/**
 * Package A's entry point (design §16): the auth port, and the host registration behind it.
 *
 * `createAuth` is what `src/plugin.ts`'s one-line auth seam calls. It:
 * 1. validates every account's mode-specific options, so a misconfiguration fails at startup (`OPTIONS_INVALID`,
 *    `HOST_INVALID`) rather than on the first tool call;
 * 2. loads the non-secret sign-in summary so status can name a workspace before the first call;
 * 3. registers one OAuth integration per interactive account, `databricks-<alias>`, with the form, the browser flow,
 *    the refresh callback and the role binding (design §3.2);
 * 4. registers `/databricks-doctor` (design §14), and keeps the certification it earns in memory only;
 * 5. returns the `AuthPort` package B and every tool call `token(account, scopes, signal)` on.
 *
 * The token call is the one seat belt every Databricks request passes: a missing sign-in is `AUTH_REQUIRED`, a scope
 * the sign-in does not carry is `AUTH_SCOPE_MISSING` before any fetch, a configured role that differs from the one
 * bound at sign-in is `AUTH_REQUIRED`, and a headless mode in a Jelly-hosted engine is `HEADLESS_REFUSED`. `pat`, `m2m`
 * and `cli` read a secret only from the environment or the CLI's own cache (design §3.2); no option holds one.
 *
 * Two accepted contract additions are computed here before the keeper lands them, and are returned as extra fields:
 * `AccountInfo.enforcement` (design §5.6; `role` only from a doctor report of this process, bound to the credential's
 * host, role and grant, and cleared by any sign-in or refresh that changes them) and `Token.host` (the workspace the
 * token was minted for, so package B never uses a stale display summary).
 */
import { DISPLAY_NAME } from "../constants.js"
import type { EnforcementKind } from "../domain/contract.js"
import { DatabricksError } from "../domain/errors.js"
import type { Options } from "../options.js"
import type { AccountInfo, AuthPort, DatabricksPort, Token } from "../ports.js"
import { accountSettings, accountInfo, isHeadless, settingsOf, validateAccounts, type AccountBase, type AccountSettings } from "./accounts.js"
import { registerDoctorCommand } from "./commands.js"
import { readSignIn, type SignIn } from "./credential.js"
import type { DoctorReport } from "./doctor.js"
import { authorizeDatabricks, OAUTH_METHOD_ID } from "./oauth.js"
import { integrationIdFor, integrationNames, readSignInAnswer, signInForm, type RedirectDefaults } from "./form.js"
import { cliToken, m2mToken, patToken, tokenCache, type CliRunner } from "./headless.js"
import { readHostCredential } from "./host-credential.js"
import { parseWorkspaceHost } from "./host.js"
import { isHostedEngine, headlessRefused } from "./jelly.js"
import { refreshSignIn, refreshState, type RefreshState } from "./refresh.js"
import { featureOfScope, requestedScopes } from "./scopes.js"
import { SignInSummaries, type SummaryStorage } from "./store.js"
import type { AuthContext, HostCredential, Registration } from "./types.js"

/** Where a token comes from in production: the host's credential store, resolved through the integration. */
export interface CredentialsSource {
  read(alias: string, signal: AbortSignal): Promise<HostCredential | undefined>
}

export interface CoreInput {
  readonly options: Options
  readonly credentials: CredentialsSource
  readonly summaries: SignInSummaries
  readonly env: NodeJS.ProcessEnv
  readonly now: () => number
  readonly hosted: boolean
  readonly fetch: typeof globalThis.fetch
  readonly runCli?: CliRunner
  readonly cliCommand?: string
  readonly tokenEndpoint?: string
}

const signInAgain = (alias: string) => `Run /connect and choose ${DISPLAY_NAME}, or run opencode auth login databricks-${alias}.`

/** What makes a doctor certification apply to the credential now in force: the workspace, role and granted scopes. */
interface Seen {
  readonly host: string
  readonly roleGroupId?: string
  readonly grantedScopes: readonly string[]
}

const sameSeen = (left: Seen, right: Seen): boolean =>
  left.host === right.host && left.roleGroupId === right.roleGroupId && [...left.grantedScopes].sort().join(" ") === [...right.grantedScopes].sort().join(" ")

const seenOf = (stored: SignIn): Seen => ({ host: stored.host, ...(stored.roleGroupId !== undefined ? { roleGroupId: stored.roleGroupId } : {}), grantedScopes: stored.grantedScopes })

/** The auth port over one set of options. Tests build it with fakes; `createAuth` with the host. */
export class AuthCore implements AuthPort {
  readonly port: AuthPort = this
  readonly refreshes: RefreshState = refreshState()
  private readonly input: CoreInput
  private readonly cache = tokenCache()
  /** The credential in force per account, for the certification binding. In memory only. */
  private readonly current = new Map<string, Seen>()
  /** A doctor report that earned `role`, bound to the credential it proved. In memory only, never in storage. */
  private readonly certified = new Map<string, Seen>()
  /** The role group's display name, when SCIM returned it: display only (the contract's `AccountInfo.role.name`). */
  private readonly roleNames = new Map<string, string>()

  constructor(input: CoreInput) {
    this.input = input
  }

  async load(): Promise<void> {
    await this.input.summaries.load()
  }

  /** The account as far as a display goes: only one whose workspace is known (from the options or the summary). */
  accounts(): readonly AccountInfo[] {
    const infos: AccountInfo[] = []
    for (const settings of accountSettings(this.input.options)) {
      const summary = this.input.summaries.get(settings.alias)
      try {
        const info = accountInfo(settings, summary?.host, this.input.options.allowCustomHost, summary?.roleGroupId, this.roleNames.get(settings.alias))
        if (info) infos.push({ ...info, enforcement: this.enforcementFor(settings.alias, info) })
      } catch {
        // A workspace this plugin would refuse is not an account; account() throws HOST_INVALID for it.
      }
    }
    return infos
  }

  account(alias?: string): AccountInfo {
    const settings = this.settings(alias)
    const summary = this.input.summaries.get(settings.alias)
    const info = accountInfo(settings, summary?.host, this.input.options.allowCustomHost, summary?.roleGroupId, this.roleNames.get(settings.alias))
    if (!info) {
      throw new DatabricksError(
        "AUTH_REQUIRED",
        `No workspace URL is known for ${settings.alias} yet.`,
        `Run /connect and choose ${DISPLAY_NAME} and enter the workspace URL, or set accounts.${settings.alias}.host.`,
      )
    }
    return { ...info, enforcement: this.enforcementFor(settings.alias, info) }
  }

  async token(alias: string, scopes: readonly string[], signal: AbortSignal): Promise<Token> {
    if (signal.aborted) throw new DatabricksError("CANCELLED", "The call was stopped.")
    const settings = this.settings(alias)
    if (isHeadless(settings.mode) && this.input.hosted && !this.input.options.allowHeadlessInHost) throw headlessRefused(alias, settings.mode)
    switch (settings.mode) {
      case "interactive":
        return this.interactive(settings, scopes, signal)
      case "pat": {
        const host = this.workspaceOf(settings)
        return this.checked(patToken(alias, settings, this.input.env), scopes, settings, host)
      }
      case "m2m": {
        const host = this.workspaceOf(settings)
        return this.checked(
          await m2mToken({
            alias,
            settings,
            env: this.input.env,
            scopes,
            fetch: this.input.fetch,
            now: this.input.now,
            allowCustomHost: this.input.options.allowCustomHost,
            signal,
            cache: this.cache,
            ...(this.input.tokenEndpoint !== undefined ? { tokenEndpoint: this.input.tokenEndpoint } : {}),
          }),
          scopes,
          settings,
          host,
        )
      }
      case "cli": {
        const host = this.workspaceOf(settings)
        return this.checked(
          await cliToken({
            alias,
            settings,
            env: this.input.env,
            now: this.input.now,
            signal,
            cache: this.cache,
            ...(this.input.runCli !== undefined ? { run: this.input.runCli } : {}),
            ...(this.input.cliCommand !== undefined ? { command: this.input.cliCommand } : {}),
          }),
          scopes,
          settings,
          host,
        )
      }
    }
  }

  /** The host's refresh callback: one serialized renewal, and the rotated credential it returns for the host to store. */
  async refresh(alias: string, credential: HostCredential, signal?: AbortSignal): Promise<HostCredential> {
    const renewed = await refreshSignIn({
      alias,
      name: `${DISPLAY_NAME}${alias === "default" ? "" : ` (${alias})`}`,
      credential,
      fetch: this.input.fetch,
      now: this.input.now,
      allowCustomHost: this.input.options.allowCustomHost,
      state: this.refreshes,
      ...(signal !== undefined ? { signal } : {}),
      ...(this.input.tokenEndpoint !== undefined ? { tokenEndpoint: this.input.tokenEndpoint } : {}),
    })
    await this.remember(alias, renewed, "read")
    return renewed
  }

  /** Record a completed sign-in or a resolved token's triple; clears a certification the new credential no longer matches. */
  async remember(alias: string, credential: HostCredential, kind: "sign-in" | "read" = "read"): Promise<void> {
    const stored = readSignIn(credential.metadata)
    if (!stored) return
    const seen = seenOf(stored)
    this.current.set(alias, seen)
    const certified = this.certified.get(alias)
    if (certified && !sameSeen(certified, seen)) this.certified.delete(alias)
    const generation = stored.generation ?? 0
    const latest = this.refreshes.latest.get(alias)
    // A delayed read of an older sign-in never replaces a newer one; a fresh sign-in at the same millisecond does.
    if (!latest || generation > latest.generation || (kind === "sign-in" && generation >= latest.generation)) {
      this.refreshes.latest.set(alias, { credential, generation })
    }
    await this.input.summaries.remember(alias, { host: stored.host, ...(stored.roleGroupId !== undefined ? { roleGroupId: stored.roleGroupId } : {}) })
  }

  /** A doctor report raised `role`: remember the credential it proved, so `account().enforcement` can say so in this process. */
  certify(report: DoctorReport): void {
    if (report.role?.name !== undefined) this.roleNames.set(report.alias, report.role.name)
    if (report.enforcement !== "role" || report.role === undefined || report.binding === undefined) return
    // The report proved the credential it ran with. A sign-in that landed during the run is not covered (R2-L1).
    const current = this.current.get(report.alias)
    if (current && sameSeen(report.binding, current)) this.certified.set(report.alias, current)
  }

  private enforcementFor(alias: string, info: AccountBase): EnforcementKind {
    const base = info.mode === "m2m" ? "service-principal" : info.role !== undefined ? "role-requested" : "identity"
    const certified = this.certified.get(alias)
    const current = this.current.get(alias)
    return info.role !== undefined && certified && current && sameSeen(certified, current) ? "role" : base
  }

  private settings(alias?: string): AccountSettings {
    const settings = settingsOf(this.input.options, alias)
    if (!settings) {
      throw new DatabricksError("AUTH_REQUIRED", `No Databricks account is named ${alias}.`, `Use one of the configured accounts: ${accountSettings(this.input.options).map((account) => account.alias).join(", ")}.`)
    }
    return settings
  }

  private workspaceOf(settings: AccountSettings): string {
    if (!settings.host) {
      throw new DatabricksError("AUTH_REQUIRED", `No workspace URL is configured for ${settings.alias}.`, `Set accounts.${settings.alias}.host.`)
    }
    return parseWorkspaceHost(settings.host, this.input.options.allowCustomHost).host
  }

  private async interactive(settings: AccountSettings, scopes: readonly string[], signal: AbortSignal): Promise<Token> {
    let credential: HostCredential | undefined
    try {
      credential = await this.input.credentials.read(settings.alias, signal)
    } catch (error) {
      if (error instanceof DatabricksError) throw error
      throw new DatabricksError("AUTH_REQUIRED", `The stored Databricks sign-in for ${settings.alias} could not be read.`, signInAgain(settings.alias))
    }
    if (!credential) throw new DatabricksError("AUTH_REQUIRED", `No Databricks sign-in is stored for ${settings.alias}.`, signInAgain(settings.alias))
    if (!credential.access) throw new DatabricksError("AUTH_REQUIRED", `The stored Databricks sign-in for ${settings.alias} has no access token.`, signInAgain(settings.alias))
    const stored = readSignIn(credential.metadata)
    if (!stored) throw new DatabricksError("AUTH_REQUIRED", `The stored Databricks sign-in for ${settings.alias} has no workspace record.`, signInAgain(settings.alias))
    const host = this.binding(settings, stored)
    await this.remember(settings.alias, credential, "read")
    return this.checked({ accessToken: credential.access, expiresAt: credential.expires, scopes: stored.grantedScopes }, scopes, settings, host, stored)
  }

  /**
   * The security binding of design §3.1: the token's workspace and role must be the configured ones, so an edit of
   * `opencode.json` can neither redirect the token nor change the identity an agent runs as. Returns the workspace.
   */
  private binding(settings: AccountSettings, stored: SignIn): string {
    const signInHost = parseWorkspaceHost(stored.host, this.input.options.allowCustomHost).host
    if (settings.host !== undefined) {
      const configured = parseWorkspaceHost(settings.host, this.input.options.allowCustomHost)
      if (configured.host !== signInHost) {
        throw new DatabricksError(
          "AUTH_REQUIRED",
          `The stored sign-in for ${settings.alias} is for ${signInHost}, and accounts.${settings.alias}.host is ${configured.host}.`,
          `Sign in to ${configured.host} again, or restore the account's host.`,
        )
      }
    }
    const wanted = settings.role
    // A role chosen on the sign-in form with no `role` option is the bound identity, and stays it. Only a configured
    // role that differs from the bound one is a mismatch: it cannot change the identity until the next browser sign-in.
    if (wanted !== undefined && wanted !== stored.roleGroupId) {
      throw new DatabricksError(
        "AUTH_REQUIRED",
        `accounts.${settings.alias}.role is ${wanted}, and the sign-in is bound to ${stored.roleGroupId !== undefined ? `role ${stored.roleGroupId}` : "no role"}.`,
        "A config change cannot change the identity a token runs as: sign in again with the role you want.",
      )
    }
    return signInHost
  }

  /** The scope check before any call (design §3.3): a missing scope is `AUTH_SCOPE_MISSING`, and nothing is fetched. */
  private checked(token: Omit<Token, "host">, needed: readonly string[], settings: AccountSettings, host: string, stored?: SignIn): Token {
    const granted = stored?.grantedScopes ?? token.scopes
    const missing = needed.filter((scope) => scope !== "any" && !granted.includes(scope) && !granted.includes("all-apis"))
    if (missing.length === 0) return { ...token, scopes: granted, host }
    const next = missing
      .map((scope) => {
        const feature = featureOfScope(scope)
        return feature && !settings.features.includes(feature)
          ? `Add "${feature}" to accounts.${settings.alias}.features, then sign in again.`
          : `Ask the account admin to allow the ${scope} scope on the app connection (changes can take 30 minutes), then sign in again.`
      })
      .join(" ")
    throw new DatabricksError("AUTH_SCOPE_MISSING", `The sign-in for ${settings.alias} does not carry the ${missing.join(", ")} ${missing.length === 1 ? "scope" : "scopes"}. Databricks was not called.`, next)
  }
}

export interface CreateAuthInput {
  /** The host context; typed structurally by `types.ts`, so no private host package is imported. */
  readonly ctx: unknown
  readonly options: Options
  readonly keep: <R extends Registration>(registration: R) => R
  /** Package B's port, read when the doctor command runs, not at setup. */
  readonly databricks: () => DatabricksPort
  /** Test seams; production takes the process's. */
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
  readonly env?: NodeJS.ProcessEnv
  readonly hosted?: boolean
  readonly runCli?: CliRunner
  readonly cliCommand?: string
  readonly storage?: SummaryStorage
  readonly authorizeEndpoint?: string
  readonly tokenEndpoint?: string
  readonly timeoutMs?: number
}

function redirectDefaults(options: Options): RedirectDefaults {
  return { ...(options.redirectUri !== undefined ? { redirectUri: options.redirectUri } : {}), callbackPort: options.callbackPort }
}

/** One OAuth integration per interactive account, and the doctor command. */
export async function createAuth(input: CreateAuthInput): Promise<AuthPort> {
  validateAccounts(input.options)
  const context = input.ctx as AuthContext
  const fetch = input.fetch ?? globalThis.fetch
  const now = input.now ?? Date.now
  const registrations: Registration[] = []
  const core = new AuthCore({
    options: input.options,
    credentials: { read: (alias, signal) => readHostCredential(context.integration.connection, alias, signal) },
    summaries: new SignInSummaries(input.storage ?? context.storage),
    env: input.env ?? process.env,
    now,
    hosted: input.hosted ?? isHostedEngine(),
    fetch,
    ...(input.runCli !== undefined ? { runCli: input.runCli } : {}),
    ...(input.cliCommand !== undefined ? { cliCommand: input.cliCommand } : {}),
    ...(input.tokenEndpoint !== undefined ? { tokenEndpoint: input.tokenEndpoint } : {}),
  })
  try {
    await core.load()
    const accounts = accountSettings(input.options)
    const interactive = accounts.filter((account) => account.mode === "interactive")
    if (interactive.length > 0) {
      const names = integrationNames(accounts)
      const defaults = redirectDefaults(input.options)
      registrations.push(
        await context.integration.transform((draft) => {
          for (const account of interactive) {
            const integrationID = integrationIdFor(account.alias)
            const name = names.get(account.alias) ?? DISPLAY_NAME
            draft.update(integrationID, (integration) => {
              integration.name = name
            })
            draft.method.update({
              integrationID,
              method: { id: OAUTH_METHOD_ID, type: "oauth", label: "Sign in with Databricks", form: signInForm(account, defaults) },
              authorize: async (answer) => {
                const parsed = readSignInAnswer(answer, account, defaults, input.options.allowCustomHost)
                const authorization = await authorizeDatabricks({
                  alias: account.alias,
                  host: parsed.host.host,
                  clientId: parsed.clientId,
                  scopes: requestedScopes(account.features, parsed.scopes),
                  choice: parsed.scopes,
                  redirect: parsed.redirect,
                  fetch,
                  now,
                  ...(parsed.roleGroupId !== undefined ? { roleGroupId: parsed.roleGroupId } : {}),
                  ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
                  ...(input.authorizeEndpoint !== undefined ? { authorizeEndpoint: input.authorizeEndpoint } : {}),
                  ...(input.tokenEndpoint !== undefined ? { tokenEndpoint: input.tokenEndpoint } : {}),
                })
                return {
                  url: authorization.url,
                  instructions: authorization.instructions,
                  expiresAt: authorization.expiresAt,
                  mode: "auto" as const,
                  callback: authorization.callback.then(async (credential) => {
                    await core.remember(account.alias, credential, "sign-in")
                    return credential
                  }),
                }
              },
              refresh: (credential) => core.refresh(account.alias, credential),
            })
          }
        }),
      )
    }
    registrations.push(await registerDoctorCommand(context, { options: input.options, auth: core.port, databricks: input.databricks, onReport: (report) => core.certify(report) }))
  } catch (cause) {
    for (const registration of registrations.splice(0).reverse()) await registration.dispose().catch(() => undefined)
    throw cause
  }
  for (const registration of registrations) input.keep(registration)
  return core.port
}
