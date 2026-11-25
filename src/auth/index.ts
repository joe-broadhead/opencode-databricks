/**
 * Package A's entry point (design §16): the auth port, and the host registration behind it.
 *
 * `createAuth` is what `src/index.ts` calls. It:
 * 1. validates every account's mode-specific options, so a misconfiguration fails at startup (`OPTIONS_INVALID`,
 *    `HOST_INVALID`) rather than on the first tool call;
 * 2. loads the non-secret sign-in summary so status can name a workspace before the first call;
 * 3. registers one integration per alias through the contract's `accounts` module, with the OAuth form and refresh for
 *    an interactive account;
 * 4. returns the `AuthPort` every provider call mints a token through.
 *
 * The token call is the one seat belt every Databricks request passes: a missing sign-in is `AUTH_REQUIRED`, a scope
 * the sign-in does not carry is `AUTH_SCOPE_MISSING` before any fetch, and a configured role that differs from the one
 * bound at sign-in is `AUTH_REQUIRED`. `pat`, `m2m` and `cli` read a secret only from the environment or the CLI's own
 * cache; no option holds one.
 */
import { DISPLAY_NAME } from "../constants.js"
import type { EnforcementKind } from "../handlers/schemas.js"
import { DatabricksError } from "../domain/errors.js"
import type { Options } from "../options.js"
import type { AccountInfo, AuthPort, Token } from "../ports.js"
import { accountSettings, accountInfo, settingsOf, validateAccounts, type AccountBase, type AccountSettings } from "./accounts.js"
import { readSignIn, type SignIn } from "./credential.js"
import { authorizeDatabricks, OAUTH_METHOD_ID } from "./oauth.js"
import { integrationIdFor, readSignInAnswer, signInForm, type RedirectDefaults } from "./form.js"
import { cliToken, m2mToken, patToken, tokenCache, type CliRunner } from "./headless.js"
import { readHostCredential } from "./host-credential.js"
import { parseWorkspaceHost } from "./host.js"
import { refreshSignIn, refreshState, type RefreshState } from "./refresh.js"
import { featureOfScope, requestedScopes } from "./scopes.js"
import { SignInSummaries, type SummaryStorage } from "./store.js"
import { registerAccounts, type IntegrationMethodRegistration } from "@we-the-rebel-alliance/plugin-contract/accounts"
import type { Manifest } from "@we-the-rebel-alliance/plugin-contract/manifest"
import type { AuthContext, HostCredential } from "./types.js"

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
  readonly fetch: typeof globalThis.fetch
  readonly runCli?: CliRunner
  readonly cliCommand?: string
  readonly tokenEndpoint?: string
}

const signInAgain = (alias: string) => `Run /connect and choose ${DISPLAY_NAME}, or run opencode auth login ${integrationIdFor(alias)}.`

/** The auth port over one set of options. Tests build it with fakes; `createAuth` with the host. */
export class AuthCore implements AuthPort {
  readonly port: AuthPort = this
  readonly refreshes: RefreshState = refreshState()
  private readonly input: CoreInput
  private readonly cache = tokenCache()

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
        const info = accountInfo(settings, summary?.host, this.input.options.allowCustomHost, summary?.roleGroupId)
        if (info) infos.push({ ...info, enforcement: this.enforcementFor(info) })
      } catch {
        // A workspace this plugin would refuse is not an account; account() throws HOST_INVALID for it.
      }
    }
    return infos
  }

  account(alias?: string): AccountInfo {
    const settings = this.settings(alias)
    const summary = this.input.summaries.get(settings.alias)
    const info = accountInfo(settings, summary?.host, this.input.options.allowCustomHost, summary?.roleGroupId)
    if (!info) {
      throw new DatabricksError(
        "AUTH_REQUIRED",
        `No workspace URL is known for ${settings.alias} yet.`,
        `Run /connect and choose ${DISPLAY_NAME} and enter the workspace URL, or set accounts.${settings.alias}.host.`,
      )
    }
    return { ...info, enforcement: this.enforcementFor(info) }
  }

  async token(alias: string, scopes: readonly string[], signal: AbortSignal): Promise<Token> {
    if (signal.aborted) throw new DatabricksError("CANCELLED", "The call was stopped.")
    const settings = this.settings(alias)
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

  /** Record a completed sign-in or a resolved token's triple. */
  async remember(alias: string, credential: HostCredential, kind: "sign-in" | "read" = "read"): Promise<void> {
    const stored = readSignIn(credential.metadata)
    if (!stored) return
    const generation = stored.generation ?? 0
    const latest = this.refreshes.latest.get(alias)
    // A delayed read of an older sign-in never replaces a newer one; a fresh sign-in at the same millisecond does.
    if (!latest || generation > latest.generation || (kind === "sign-in" && generation >= latest.generation)) {
      this.refreshes.latest.set(alias, { credential, generation })
    }
    await this.input.summaries.remember(alias, { host: stored.host, ...(stored.roleGroupId !== undefined ? { roleGroupId: stored.roleGroupId } : {}) })
  }

  private enforcementFor(info: AccountBase): EnforcementKind {
    return info.mode === "m2m" ? "service-principal" : info.role !== undefined ? "role-requested" : "identity"
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
  /** Test seams; production takes the process's. */
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
  readonly env?: NodeJS.ProcessEnv
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

/** One OAuth integration per interactive account. */
export interface AuthSetup {
  readonly port: AuthPort
  readonly problems: readonly string[]
}

/**
 * The auth port and the one integration per alias, through the contract's `accounts` module. The plugin holds the
 * credentials: an interactive alias signs in through its own integration (`databricks` or `databricks-<alias>`), while
 * a headless alias reads its token from the environment or the CLI and needs no sign-in.
 */
export async function createAuth(input: CreateAuthInput & { readonly manifest: Manifest }): Promise<AuthSetup> {
  validateAccounts(input.options)
  const context = input.ctx as AuthContext
  const fetch = input.fetch ?? globalThis.fetch
  const now = input.now ?? Date.now
  const core = new AuthCore({
    options: input.options,
    credentials: { read: (alias, signal) => readHostCredential(context.integration.connection, alias, signal) },
    summaries: new SignInSummaries(input.storage ?? context.storage),
    env: input.env ?? process.env,
    now,
    fetch,
    ...(input.runCli !== undefined ? { runCli: input.runCli } : {}),
    ...(input.cliCommand !== undefined ? { cliCommand: input.cliCommand } : {}),
    ...(input.tokenEndpoint !== undefined ? { tokenEndpoint: input.tokenEndpoint } : {}),
  })
  await core.load()
  const defaults = redirectDefaults(input.options)
  const registered = await registerAccounts(context, {
    manifest: input.manifest,
    options: input.options,
    auth: (account): readonly IntegrationMethodRegistration[] => {
      const settings = settingsOf(input.options, account.alias)
      if (settings === undefined || settings.mode !== "interactive") return []
      return [
        {
          integrationID: "",
          method: { id: OAUTH_METHOD_ID, type: "oauth", label: "Sign in with Databricks", form: signInForm(settings, defaults) },
          authorize: async (answer: Record<string, unknown>) => {
            const parsed = readSignInAnswer(answer, settings, defaults, input.options.allowCustomHost)
            const authorization = await authorizeDatabricks({
              alias: settings.alias,
              host: parsed.host.host,
              clientId: parsed.clientId,
              scopes: requestedScopes(settings.features, parsed.scopes),
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
                await core.remember(settings.alias, credential, "sign-in")
                return credential
              }),
            }
          },
          refresh: (credential: HostCredential) => core.refresh(settings.alias, credential),
        },
      ]
    },
  })
  return { port: core.port, problems: registered.problems }
}
