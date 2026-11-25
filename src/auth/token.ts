/**
 * One POST to a Databricks OAuth token endpoint, and the one place its failures become the plugin's codes.
 *
 * The request is the shape Databricks documents: `application/x-www-form-urlencoded`, and for M2M the client ID and
 * secret as HTTP Basic ("`--user \"$CLIENT_ID:$CLIENT_SECRET\"`") [10]. The answer's `access_token`, `refresh_token`,
 * `expires_in` and `scope` are the OAuth U2M example's fields [9]. Nothing from the request or the answer is ever put
 * in a message: an error names the endpoint's status and its fixed OAuth `error` code (`invalid_client`,
 * `invalid_grant`, `invalid_scope`) and never `error_description`, which is free text.
 *
 * Endpoints, all relative to the workspace the token is for:
 * - U2M authorize: `https://<workspace>/oidc/v1/authorize` [9] (the AWS page; Azure and GCP give the same workspace
 *   paths on their own pages: learn.microsoft.com/azure/databricks/dev-tools/auth/oauth-u2m and
 *   docs.databricks.com/gcp/en/dev-tools/auth/oauth-u2m).
 * - U2M and M2M token: `https://<workspace>/oidc/v1/token` [9][10] (Azure and GCP: the same M2M page on each cloud).
 * - Refresh: `POST` the token endpoint with `grant_type=refresh_token&refresh_token=…&client_id=…` [partner guide].
 */
import { DatabricksError } from "../domain/errors.js"

const TIMEOUT_MS = 30_000

/** The timeout in a message: whole seconds as written, a shorter one as its fraction ("0.05 seconds"). */
const secondsText = (ms: number): string => `${ms >= 1000 ? Math.round(ms / 1000) : ms / 1000} seconds`
/** The codes an endpoint may return, as the OAuth standard defines them; anything else is not repeated. */
const OAUTH_CODE = /^[a-z][a-z0-9_]{2,40}$/u

export interface TokenSet {
  readonly accessToken: string
  readonly refreshToken?: string
  /** Seconds; Databricks answers 3600 for a workspace token [9][10]. */
  readonly expiresIn: number
  /** The granted scopes, when the answer lists them; `all-apis` is one value. */
  readonly scopes?: string[]
}

export interface TokenRequest {
  readonly endpoint: string
  readonly form: Readonly<Record<string, string>>
  readonly fetch: typeof globalThis.fetch
  readonly signal: AbortSignal
  /** HTTP Basic credentials: M2M only. */
  readonly basic?: { readonly user: string; readonly secret: string }
  /** What an `invalid_scope` means here: `client` at authorize, `scope` at an M2M token. */
  readonly invalidScope?: "client" | "scope"
  readonly timeoutMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function failure(status: number, json: Record<string, unknown>, invalidScope: "client" | "scope"): DatabricksError {
  const raw = typeof json["error"] === "string" ? json["error"] : ""
  const code = OAUTH_CODE.test(raw) ? raw : ""
  const says = code ? ` Databricks answered ${code}.` : ""
  const next = "Check the client ID and the app connection's redirect URLs and scopes; app changes can take 30 minutes."
  if (code === "invalid_scope") {
    return invalidScope === "scope"
      ? new DatabricksError("AUTH_SCOPE_MISSING", `The OAuth token request asked for a scope the OAuth secret does not allow (HTTP ${status}).${says}`, "Generate a secret with the API scopes this plugin needs, or sign in interactively.")
      : new DatabricksError("AUTH_CLIENT_INVALID", `Databricks refused the app connection's scopes (HTTP ${status}).${says}`, "Choose the other scope set on the sign-in form (fine or all-apis), or ask the admin to allow the scope on the app connection.")
  }
  if (code === "invalid_client" || code === "unauthorized_client") {
    return new DatabricksError("AUTH_CLIENT_INVALID", `Databricks refused the OAuth client (HTTP ${status}).${says}`, next)
  }
  if (code === "invalid_grant") {
    return new DatabricksError("AUTH_REQUIRED", `The sign-in's grant is no longer valid (HTTP ${status}).${says}`, "Sign in again with /connect, or with opencode auth login databricks-<alias>.")
  }
  return new DatabricksError("UNAVAILABLE", `The OAuth token endpoint failed (HTTP ${status}).${says}`, "Try again in a few seconds; if it persists, check the workspace URL and the app connection.")
}

/**
 * Exchange one request for a token set. Throws `CANCELLED` when the caller's signal aborts, `UNAVAILABLE` when the
 * endpoint is unreachable, slow or answers something that is not a token, and `AUTH_*` for the OAuth errors.
 */
export async function requestToken(request: TokenRequest): Promise<TokenSet> {
  if (request.signal.aborted) throw new DatabricksError("CANCELLED", "The call was stopped.")
  // The one effective timeout: the abort signal and the message name the same number.
  const timeoutMs = request.timeoutMs ?? TIMEOUT_MS
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = AbortSignal.any([request.signal, timeout])
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }
  if (request.basic) headers["Authorization"] = `Basic ${Buffer.from(`${request.basic.user}:${request.basic.secret}`).toString("base64")}`
  let response: Response
  try {
    response = await request.fetch(request.endpoint, {
      method: "POST",
      headers,
      body: new URLSearchParams(request.form).toString(),
      redirect: "error",
      signal,
    })
  } catch (error) {
    if (request.signal.aborted) throw new DatabricksError("CANCELLED", "The call was stopped.")
    if (timeout.aborted) throw new DatabricksError("UNAVAILABLE", `The OAuth token endpoint did not answer within ${secondsText(timeoutMs)}.`, "Try again; if it persists, check the network and the workspace URL.")
    throw new DatabricksError("UNAVAILABLE", "The OAuth token endpoint could not be reached.", "Try again; if it persists, check the network and the workspace URL.")
  }
  let text = ""
  try {
    text = await response.text()
  } catch {
    // An error body is optional; a success without one is handled below.
  }
  let json: Record<string, unknown> = {}
  if (text.trim()) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (isRecord(parsed)) json = parsed
    } catch {
      if (response.ok) throw new DatabricksError("UNAVAILABLE", "The OAuth token endpoint answered something that is not JSON.", "Try again; if it persists, report it.")
    }
  }
  if (!response.ok) throw failure(response.status, json, request.invalidScope ?? "client")
  const accessToken = typeof json["access_token"] === "string" ? json["access_token"] : ""
  if (!accessToken) throw new DatabricksError("UNAVAILABLE", "The OAuth token endpoint returned no access token.", "Try again; if it persists, check the app connection.")
  const refreshToken = typeof json["refresh_token"] === "string" && json["refresh_token"] ? json["refresh_token"] : undefined
  const rawExpires = typeof json["expires_in"] === "number" ? json["expires_in"] : Number(json["expires_in"])
  const expiresIn = Number.isFinite(rawExpires) && rawExpires > 0 ? Math.floor(rawExpires) : 3600
  const scope = typeof json["scope"] === "string" ? json["scope"] : undefined
  const scopes = scope ? scope.split(/\s+/u).filter(Boolean) : undefined
  return { accessToken, expiresIn, ...(refreshToken ? { refreshToken } : {}), ...(scopes && scopes.length > 0 ? { scopes } : {}) }
}
