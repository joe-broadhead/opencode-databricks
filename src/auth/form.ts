/**
 * The sign-in form OpenCode renders before a Databricks sign-in, and how its answer is read (design §3.1, §3.2).
 *
 * The fields are the gws mechanism's: the workspace URL, the public client ID of the customer's own app connection, the
 * scope set (fine-grained, or the single `all-apis` scope an app made in the account console needs), and an optional
 * RBAC role; then two hidden fields a host fills, `redirectUri` and `callbackPort`, for a host's relay (§18.1). The role
 * field carries the §5.6 disclosure verbatim, and recommends a read-only role: it is the only hard limit.
 *
 * A configured value wins over the form for the host and the client ID, and the form shows it hidden. Everything an
 * answer can get wrong is refused here, before the browser opens: a bad host (`HOST_INVALID`), a missing or
 * unparseable client ID and a non-numeric role (`AUTH_CLIENT_INVALID`), and a redirect this plugin cannot listen on.
 */
import { DISPLAY_NAME } from "../constants.js"
import { accountName } from "@we-the-rebel-alliance/plugin-contract/accounts"
import { WRITE_DISCLOSURE } from "../handlers/schemas.js"
import { DatabricksError } from "../domain/errors.js"
import { parseWorkspaceHost, type WorkspaceHost } from "./host.js"
import { ROLE_GROUP, type AccountSettings } from "./accounts.js"
import { signInRedirect, type SignInRedirect } from "./redirect.js"
import { requestedScopes, type ScopeChoice } from "./scopes.js"

export interface FieldOption {
  readonly value: string
  readonly label: string
  readonly description?: string
}

interface FieldBase {
  readonly key: string
  readonly title: string
  readonly description?: string
  readonly required?: boolean
  readonly hidden?: boolean
}

export interface StringField extends FieldBase {
  readonly type: "string"
  readonly placeholder?: string
  readonly pattern?: string
  readonly default?: string
  readonly options?: readonly FieldOption[]
}

export interface IntegerField extends FieldBase {
  readonly type: "integer"
  readonly minimum: number
  readonly maximum: number
  readonly default?: number
}

export type SignInForm = readonly (StringField | IntegerField)[]

export interface RedirectDefaults {
  readonly redirectUri?: string
  readonly callbackPort: number
}

const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u
const CLIENT_PATTERN = "^\\s*$|[A-Za-z0-9][A-Za-z0-9._-]{7,127}$"
const HOST_PATTERN = "^\\s*$|https://\\S+$"

/** The one integration name of an account: `databricks`, or `databricks-<alias>` (contract §3). */
export function integrationIdFor(alias: string): string {
  return accountName(DISPLAY_NAME.toLowerCase(), alias)
}

/**
 * The fields, in the order the host shows them. `host` and `clientId` are visible until the account configures them,
 * then hidden with that value; the two relay fields are always hidden.
 */
export function signInForm(account: AccountSettings, redirect: RedirectDefaults): SignInForm {
  const fine = requestedScopes(account.features, "fine")
  const all = requestedScopes(account.features, "all-apis")
  const hosted = account.host !== undefined
  const cliented = account.clientId !== undefined
  return [
    {
      key: "host",
      type: "string",
      title: "Workspace URL",
      description: "The URL of the Databricks workspace you work in, from the browser's address bar. It must start with https://.",
      required: !hosted,
      placeholder: "https://dbc-1234abcd-5678.cloud.databricks.com",
      pattern: HOST_PATTERN,
      ...(hosted ? { default: account.host, hidden: true } : {}),
    },
    {
      key: "clientId",
      type: "string",
      title: "OAuth client ID",
      description: `The public client ID of the app connection an account admin creates once (a public client, no secret). It is kept with the sign-in in OpenCode's credential store.`,
      required: !cliented,
      placeholder: "7f3e2a10-5c4b-4d8e-9a1f-2b6c8d0e4f12",
      pattern: CLIENT_PATTERN,
      ...(cliented ? { default: account.clientId, hidden: true } : {}),
    },
    {
      key: "scopes",
      type: "string",
      title: "API scopes",
      description: "Fine-grained is recommended: the app connection allows exactly these. Choose All APIs only for an app made in the account console with All APIs.",
      required: true,
      default: account.scopes,
      options: [
        { value: "fine", label: "Fine-grained (recommended)", description: `Requests: ${fine.join(" ")}` },
        { value: "all-apis", label: "All APIs", description: `Requests: ${all.join(" ")}` },
      ],
    },
    {
      key: "role",
      type: "string",
      title: "Role to assume (optional)",
      description: `The numeric ID of an RBAC role (group) to assume, from the account console under Identity and access → Groups. A role with only USE and SELECT is recommended; it is the only hard limit on what the agent can do. ${WRITE_DISCLOSURE}`,
      required: false,
      ...(account.role !== undefined ? { default: account.role } : {}),
      placeholder: "1234567890123456",
    },
    {
      key: "redirectUri",
      type: "string",
      title: "OAuth redirect URI",
      description: "Filled by a host that serves OpenCode to a browser on another machine: the public address Databricks sends the browser to. Blank: http://localhost:<callbackPort>/callback.",
      required: false,
      hidden: true,
      pattern: "^\\s*$|https?://\\S+$",
      ...(redirect.redirectUri !== undefined ? { default: redirect.redirectUri } : {}),
    },
    {
      key: "callbackPort",
      type: "integer",
      title: "OAuth callback port",
      description: "The port on 127.0.0.1 where the sign-in's listener waits for the redirect.",
      required: false,
      hidden: true,
      minimum: 1,
      maximum: 65_535,
      default: redirect.callbackPort,
    },
  ]
}

export interface SignInAnswer {
  readonly host: WorkspaceHost
  readonly clientId: string
  readonly scopes: ScopeChoice
  readonly roleGroupId?: string
  readonly redirect: SignInRedirect
}

function text(answer: Record<string, unknown>, key: string): string {
  const value = answer[key]
  if (value === undefined || value === null) return ""
  if (typeof value !== "string") {
    throw new DatabricksError("AUTH_CLIENT_INVALID", `The sign-in form's ${key} answer is not text.`, "Run /connect again and enter the workspace URL and the app connection's client ID.")
  }
  return value.trim()
}

function clientError(what: string, next: string): never {
  throw new DatabricksError("AUTH_CLIENT_INVALID", what, next)
}

/** The port from the form, or the option's default; a non-integer is refused before it reaches the listener. */
function portOf(answer: Record<string, unknown>, fallback: number): number {
  const raw = answer["callbackPort"]
  if (raw === undefined || raw === null || raw === "") return fallback
  const port = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/u.test(raw.trim()) ? Number(raw.trim()) : Number.NaN
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    clientError("The sign-in form's callbackPort is not a port from 1 to 65535.", "Set the plugin's callbackPort to the local port the redirect reaches, or leave it at 8765.")
  }
  return port
}

/**
 * Read a submitted form. A configured host or client ID wins; an answer that names a different host is refused rather
 * than silently ignored, because the stored token is for the configured workspace.
 */
export function readSignInAnswer(answer: Record<string, unknown>, account: AccountSettings, redirect: RedirectDefaults, allowCustomHost: boolean): SignInAnswer {
  const answeredHost = text(answer, "host")
  let host: WorkspaceHost
  if (account.host !== undefined) {
    host = parseWorkspaceHost(account.host, allowCustomHost)
    if (answeredHost) {
      const other = parseWorkspaceHost(answeredHost, allowCustomHost)
      if (other.host !== host.host) {
        throw new DatabricksError(
          "HOST_INVALID",
          `accounts.${account.alias}.host is ${host.host}, and the form named another workspace.`,
          `Sign in to ${host.host}, or change accounts.${account.alias}.host first.`,
        )
      }
    }
  } else {
    if (!answeredHost) throw new DatabricksError("HOST_INVALID", "The sign-in needs the workspace URL.", "Enter the workspace URL from the browser's address bar.")
    host = parseWorkspaceHost(answeredHost, allowCustomHost)
  }
  const clientId = account.clientId ?? text(answer, "clientId")
  if (!clientId) clientError("No OAuth client ID: the app connection's client ID is required.", "Ask your account admin for the client ID of the app connection they created for databricks-plugin, then sign in again.")
  if (!CLIENT_ID.test(clientId)) clientError("The sign-in's client ID is not an OAuth client ID.", "Copy the client ID from the app connection (it is a UUID) and sign in again.")
  const rawScopes = text(answer, "scopes")
  const scopes: ScopeChoice =
    rawScopes === "" ? account.scopes : rawScopes === "fine" || rawScopes === "all-apis" ? rawScopes : clientError("The sign-in's scope choice is not fine or all-apis.", "Run /connect again and choose Fine-grained or All APIs.")
  // An omitted role keeps a configured one. With no configured role, the form's role is the identity the person asked
  // to run as, and sign-in binds it; a configured role that differs is refused, because no token could use that sign-in.
  const role = text(answer, "role") || account.role || ""
  if (role && !ROLE_GROUP.test(role)) {
    clientError(
      "The sign-in's role is not a numeric group ID.",
      "Enter the numeric ID of the role's backing group (account console → Identity and access → Groups), or leave the role blank and sign in as yourself.",
    )
  }
  // The configured role is what the account must run as; a sign-in that chose another (or none) could never be used.
  if (account.role !== undefined && role !== account.role) {
    throw new DatabricksError(
      "AUTH_REQUIRED",
      `accounts.${account.alias}.role is ${account.role}, and the sign-in form chose ${role || "no role"}.`,
      `Sign in with role ${account.role}, or change accounts.${account.alias}.role first.`,
    )
  }
  const redirectUri = text(answer, "redirectUri") || redirect.redirectUri
  const resolved = signInRedirect({ ...(redirectUri ? { redirectUri } : {}), callbackPort: portOf(answer, redirect.callbackPort) })
  return { host, clientId, scopes, ...(role ? { roleGroupId: role } : {}), redirect: resolved }
}
