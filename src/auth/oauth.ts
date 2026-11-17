/**
 * The browser sign-in: OAuth U2M with PKCE against the workspace's own endpoint (design §3.2, D2).
 *
 * Databricks' instructions are followed literally [9]:
 * - authorize at `https://<workspace>/oidc/v1/authorize` with `response_type=code`, `client_id`, `redirect_uri`,
 *   `scope`, `state`, `code_challenge`, `code_challenge_method=S256`, and `assume_group=<group-id>` for a role;
 * - exchange the code at `https://<workspace>/oidc/v1/token` with `grant_type=authorization_code`, `code`,
 *   `client_id`, `redirect_uri`, `code_verifier` and `scope`;
 * - the answer is `{ access_token, refresh_token, scope, token_type: "Bearer", expires_in: 3600 }`;
 * - the customer's own app connection must be enabled and its `client_id` used: "If you're not using a built-in
 *   Databricks tool such as the CLI or SDKs, you must enable a custom OAuth application and use its `client_id`" [9].
 *   The app is a public client with no secret [11][12], so no secret is sent.
 *
 * The listener is the loopback one the redirect names, or the local port a host's relay forwards to. The state is
 * compared byte for byte before the code is used, and the code is exchanged once; a second callback is refused.
 */
import { createServer, type Server } from "node:http"
import { DISPLAY_NAME } from "../constants.js"
import { DatabricksError } from "../domain/errors.js"
import { signInMetadata } from "./credential.js"
import { createPkce, createState, sameState, type Pkce } from "./pkce.js"
import { requestToken } from "./token.js"
import type { HostCredential } from "./types.js"
import type { SignInRedirect } from "./redirect.js"
import type { ScopeChoice } from "./scopes.js"

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
export const OAUTH_METHOD_ID = "databricks"

export interface AuthorizeInput {
  readonly alias: string
  readonly host: string
  readonly clientId: string
  readonly scopes: readonly string[]
  readonly choice: ScopeChoice
  readonly roleGroupId?: string
  readonly redirect: SignInRedirect
  readonly fetch: typeof globalThis.fetch
  readonly now: () => number
  readonly timeoutMs?: number
  /** Tests point these at a local endpoint; production leaves them to the workspace. */
  readonly authorizeEndpoint?: string
  readonly tokenEndpoint?: string
}

export interface Authorization {
  readonly url: string
  readonly instructions: string
  readonly expiresAt: number
  readonly mode: "auto"
  readonly callback: Promise<HostCredential>
}

/** The authorize URL, with every parameter Databricks' U2M page lists [9]. */
export function authorizeUrl(input: {
  readonly host: string
  readonly clientId: string
  readonly redirectUri: string
  readonly scopes: readonly string[]
  readonly state: string
  readonly pkce: Pkce
  readonly roleGroupId?: string
  readonly endpoint?: string
}): string {
  const url = new URL(input.endpoint ?? `${input.host}/oidc/v1/authorize`)
  url.searchParams.set("client_id", input.clientId)
  url.searchParams.set("redirect_uri", input.redirectUri)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("state", input.state)
  url.searchParams.set("code_challenge", input.pkce.challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("scope", input.scopes.join(" "))
  if (input.roleGroupId) url.searchParams.set("assume_group", input.roleGroupId)
  return url.toString()
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; background: Canvas; color: CanvasText; }
  main { max-width: 34rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.35rem; margin: 0 0 0.75rem; }
  p { margin: 0.5rem 0; color: color-mix(in srgb, CanvasText 78%, Canvas); }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body>
</html>`
}

function respond(response: import("node:http").ServerResponse, status: number, title: string, body: string): void {
  if (response.writableEnded) return
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "close",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  })
  response.end(page(title, body))
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (): void => {
      server.off("listening", ready)
      reject(new DatabricksError("AUTH_CLIENT_INVALID", `The sign-in could not listen on 127.0.0.1:${port}; another program may be using callbackPort ${port}.`, "Free the port, or set the plugin's callbackPort to another local port."))
    }
    const ready = (): void => {
      server.off("error", failed)
      resolve()
    }
    server.once("error", failed)
    server.once("listening", ready)
    server.listen(port, "127.0.0.1")
  })
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      server.closeAllConnections?.()
      resolve()
    }, 500)
    timer.unref?.()
    server.close(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** What the person sees beside the URL: the workspace, every scope, and what a redirect error would mean. */
function instructions(input: AuthorizeInput): string {
  const relay = input.redirect.uri.startsWith("https://")
  const hint = relay
    ? `If ${DISPLAY_NAME} shows redirect_uri_mismatch, the app connection does not list ${input.redirect.uri} exactly.`
    : `If ${DISPLAY_NAME} shows redirect_uri_mismatch, the app connection does not list ${input.redirect.uri} exactly, character for character.`
  return `Sign in to ${DISPLAY_NAME}${input.alias === "default" ? "" : ` (${input.alias})`} at ${input.host}. Databricks will ask you to approve exactly these scopes: ${input.scopes.join(", ")}. ${hint} Changes to an app connection can take 30 minutes.`
}

/**
 * Start one sign-in. It resolves as soon as the listener is ready and the URL is built; `callback` settles when the
 * browser comes back and the code is exchanged, or rejects with the plugin's code.
 */
export async function authorizeDatabricks(input: AuthorizeInput): Promise<Authorization> {
  const pkce = createPkce()
  const state = createState()
  const now = input.now
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const tokenEndpoint = input.tokenEndpoint ?? `${input.host}/oidc/v1/token`

  let settle!: (credential: HostCredential) => void
  let fail!: (error: Error) => void
  const callback = new Promise<HostCredential>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  void callback.catch(() => {})

  let finished = false
  let processing = false
  let timer: NodeJS.Timeout | undefined

  const finish = async (error?: Error, credential?: HostCredential): Promise<void> => {
    if (finished) return
    finished = true
    if (timer) clearTimeout(timer)
    await closeServer(server)
    if (error) fail(error)
    else if (credential) settle(credential)
    else fail(new DatabricksError("AUTH_REQUIRED", "The Databricks sign-in produced no credential.", "Run /connect again and choose Databricks."))
  }

  const handle = async (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> => {
    try {
      if (request.method !== "GET") {
        respond(response, 405, "Method not allowed", "<p>Use the sign-in link from OpenCode.</p>")
        return
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      if (!input.redirect.paths.includes(url.pathname)) {
        respond(response, 404, "Not found", "<p>This is not the OAuth callback.</p>")
        return
      }
      if (finished) {
        respond(response, 409, "Sign-in already finished", "<p>This sign-in attempt has already completed.</p>")
        return
      }
      const answerState = url.searchParams.get("state") ?? ""
      const denied = url.searchParams.get("error")
      const code = url.searchParams.get("code")
      if (!answerState && !denied && !code) {
        respond(response, 400, "Waiting for the Databricks sign-in", "<p>Open the sign-in link from OpenCode.</p>")
        return
      }
      if (!sameState(answerState, state)) {
        respond(response, 400, "Sign-in failed", "<p>The OAuth state did not match. Start the sign-in again.</p>")
        await finish(new DatabricksError("AUTH_REQUIRED", "The Databricks sign-in's state did not match.", "Run /connect again and choose Databricks."))
        return
      }
      if (denied) {
        const named = /^[A-Za-z0-9_.-]{1,80}$/u.test(denied) ? denied : "authorization failed"
        respond(response, 400, "Sign-in failed", `<p>${DISPLAY_NAME} returned: ${escapeHtml(named)}.</p>`)
        await finish(
          named === "invalid_scope"
            ? new DatabricksError("AUTH_CLIENT_INVALID", "Databricks refused the requested scopes (invalid_scope).", "Choose the other scope set on the sign-in form (fine or all-apis), or ask the admin to allow the scope on the app connection.")
            : new DatabricksError("AUTH_REQUIRED", `The Databricks sign-in was not completed (${named}).`, "Run /connect again and choose Databricks."),
        )
        return
      }
      if (!code) {
        respond(response, 400, "Sign-in failed", "<p>The callback did not include an authorization code.</p>")
        await finish(new DatabricksError("AUTH_REQUIRED", "The Databricks callback did not include an authorization code.", "Run /connect again and choose Databricks."))
        return
      }
      if (processing) {
        respond(response, 409, "Sign-in already in progress", "<p>This sign-in attempt is already being completed.</p>")
        return
      }
      processing = true
      try {
        const token = await requestToken({
          endpoint: tokenEndpoint,
          form: {
            grant_type: "authorization_code",
            code,
            client_id: input.clientId,
            redirect_uri: input.redirect.uri,
            code_verifier: pkce.verifier,
            scope: input.scopes.join(" "),
          },
          fetch: input.fetch,
          signal: new AbortController().signal,
        })
        if (!token.refreshToken) {
          throw new DatabricksError(
            "AUTH_REQUIRED",
            "Databricks returned no refresh token, so this sign-in would stop working after an hour.",
            "Ask the account admin to include the offline_access scope on the app connection, then sign in again.",
          )
        }
        const metadata = signInMetadata({
          host: input.host,
          clientId: input.clientId,
          scopes: input.choice,
          requestedScopes: input.scopes,
          grantedScopes: token.scopes ?? input.scopes,
          ...(input.roleGroupId !== undefined ? { roleGroupId: input.roleGroupId } : {}),
        })
        const credential: HostCredential = {
          type: "oauth",
          methodID: OAUTH_METHOD_ID,
          refresh: token.refreshToken,
          access: token.accessToken,
          expires: Math.floor(now() + token.expiresIn * 1000),
          metadata,
        }
        if (!finished) respond(response, 200, "Databricks connected", "<p>Authentication is complete. You can close this window.</p>")
        await finish(undefined, credential)
      } catch (error) {
        if (!finished) respond(response, 500, "Sign-in failed", "<p>OpenCode could not complete the Databricks token exchange. Check the terminal for the next step.</p>")
        await finish(error instanceof Error ? error : new DatabricksError("UNAVAILABLE", "The Databricks sign-in failed.", "Try again."))
      }
    } catch {
      if (!finished) respond(response, 500, "Sign-in failed", "<p>OpenCode could not process the local OAuth callback.</p>")
      await finish(new DatabricksError("UNAVAILABLE", "The local OAuth callback could not be processed.", "Try the sign-in again."))
    }
  }

  const server = createServer((request, response) => {
    void handle(request, response)
  })
  try {
    await listen(server, input.redirect.port)
  } catch (error) {
    await closeServer(server)
    throw error
  }
  // A pending sign-in must never hold the process open: the listener is a handle only while a browser is expected.
  server.unref?.()
  server.on("error", () => {
    void finish(new DatabricksError("UNAVAILABLE", "The local callback server stopped unexpectedly.", "Try the sign-in again."))
  })
  timer = setTimeout(() => {
    const minutes = Math.max(1, Math.round(timeoutMs / 60_000))
    void finish(new DatabricksError("AUTH_REQUIRED", `The Databricks sign-in timed out after ${minutes} minute${minutes === 1 ? "" : "s"}.`, "Run /connect again and choose Databricks."))
  }, timeoutMs)
  timer.unref?.()

  let url: string
  try {
    url = authorizeUrl({
      host: input.host,
      clientId: input.clientId,
      redirectUri: input.redirect.uri,
      scopes: input.scopes,
      state,
      pkce,
      ...(input.roleGroupId !== undefined ? { roleGroupId: input.roleGroupId } : {}),
      ...(input.authorizeEndpoint !== undefined ? { endpoint: input.authorizeEndpoint } : {}),
    })
  } catch (error) {
    await closeServer(server)
    throw error instanceof Error ? error : new DatabricksError("UNAVAILABLE", "The authorize URL could not be built.", "Check the workspace URL.")
  }
  return { url, instructions: instructions(input), expiresAt: now() + timeoutMs, mode: "auto", callback }
}
