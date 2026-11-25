/**
 * The host surfaces this package uses, typed structurally from the public `@opencode/plugin` API, so `src/auth/` stays
 * host-agnostic and unit-testable: `createAuth` adapts the real context once (design §16, package A).
 *
 * Only what package A needs is here: the integration registration and the credential lookup it resolves a token
 * through, and storage for the non-secret sign-in summary. No private host package is imported.
 */
export interface Registration {
  dispose(): Promise<void>
}

export interface IntegrationRef {
  id: string
  name: string
}

export interface OAuthMethod {
  readonly id: string
  readonly type: "oauth"
  readonly label: string
  readonly form: readonly unknown[]
}

/** The OAuth credential shape OpenCode stores; `methodID` is "databricks". */
export interface HostCredential {
  readonly type: "oauth"
  readonly methodID: string
  readonly refresh: string
  readonly access: string
  readonly expires: number
  readonly metadata?: Record<string, unknown>
}

export interface OAuthAuthorization {
  readonly url: string
  readonly instructions: string
  readonly expiresAt?: number
  readonly mode: "auto"
  readonly callback: Promise<HostCredential>
}

export interface MethodRegistration {
  readonly integrationID: string
  readonly method: OAuthMethod
  readonly authorize: (answer: Record<string, unknown>) => Promise<OAuthAuthorization>
  readonly refresh?: (credential: HostCredential) => Promise<HostCredential>
  readonly label?: (credential: HostCredential) => string | undefined
}

export interface IntegrationDraft {
  list(): readonly IntegrationRef[]
  get(id: string): IntegrationRef | undefined
  update(id: string, update: (integration: IntegrationRef) => void): void
  readonly method: { update(input: MethodRegistration): void }
}

/** The connection OpenCode's integration API hands back; only its identity matters here. */
export interface HostConnection {
  readonly type: "credential"
  readonly id: string
}

export interface AuthContext {
  readonly integration: {
    transform(callback: (draft: IntegrationDraft) => void): Promise<Registration>
    readonly connection: {
      active(integrationID: string): Promise<HostConnection | undefined>
      resolve(connection: HostConnection): Promise<HostCredential | undefined>
    }
  }
  readonly mcp: { transform(callback: (editor: unknown) => void): Promise<Registration> }
  readonly storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
}
