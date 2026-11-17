/**
 * Where Databricks sends the browser back, and where this process listens (design §3.2, §18.1).
 *
 * Two shapes, the gws mechanism:
 * - **Loopback**, the default: `http://localhost:<callbackPort>/callback`, the URL an admin registers on the app
 *   connection, and the listener binds `127.0.0.1` on that port. Databricks allows `http` for a loopback redirect and
 *   `https` for every other [12].
 * - **The host's relay**, when a host serves OpenCode to a browser on another machine: `redirectUri` is the public
 *   address (Jelly's `<issuer>/connect/callback`), registered on the app connection exactly, and `callbackPort` is the
 *   local port the relay forwards to. The listener accepts the relay's own path.
 *
 * Databricks matches a registered redirect URL character for character [12], so the URL is sent exactly as configured
 * and a loopback one must name the callback port the listener uses.
 */
import { DatabricksError } from "../domain/errors.js"

export interface SignInRedirect {
  /** The `redirect_uri` sent to Databricks, and registered on the app connection. */
  readonly uri: string
  /** The local port the listener binds on 127.0.0.1. */
  readonly port: number
  /** The callback paths the listener accepts. */
  readonly paths: readonly string[]
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])
const MAX_REDIRECT = 256

function invalid(what: string, next: string): never {
  throw new DatabricksError("AUTH_CLIENT_INVALID", `The sign-in's redirect URL is unusable: ${what}.`, next)
}

/** Whether a host name is loopback, where Databricks allows an `http` redirect [12]. */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase())
}

/** Any control, space or non-ASCII inside a URL is a copy-paste accident, not a redirect. */
function wellFormed(value: string): boolean {
  return /^[\x21-\x7e]+$/u.test(value)
}

/**
 * The redirect for one sign-in. `callbackPort` is always a number (the option's 8765 by default); `redirectUri` is the
 * host's relay when one fills the form's hidden field.
 */
export function signInRedirect(input: { readonly redirectUri?: string; readonly callbackPort: number }): SignInRedirect {
  const port = input.callbackPort
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    invalid("callbackPort is not a port from 1 to 65535", "Set the plugin's callbackPort to the local port the redirect reaches, or leave it at 8765.")
  }
  const configured = input.redirectUri?.trim()
  if (!configured) {
    return { uri: `http://localhost:${port}/callback`, port, paths: ["/callback"] }
  }
  if (!wellFormed(configured) || configured.length > MAX_REDIRECT) {
    invalid("it contains a space, a control character or an unencoded character, or is longer than 256 characters", "Set redirectUri to the exact relay address the host gives you.")
  }
  let url: URL
  try {
    url = new URL(configured)
  } catch {
    invalid("it is not an absolute URL", "Set redirectUri to the exact relay address the host gives you, such as https://id.example.com/connect/callback.")
  }
  if (url.username || url.password) invalid("it carries a user name or password", "Use the relay address from the host, without credentials.")
  if (url.hash) invalid("it has a fragment", "Use the relay address from the host, without a fragment.")
  const loopback = isLoopbackHost(url.hostname)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    invalid("it must use https, unless it points at localhost or 127.0.0.1", "Use the https relay address the host gives you, or a loopback redirect.")
  }
  if (loopback) {
    if (url.port !== String(port)) {
      invalid("a loopback redirect must name the callback port", "Set callbackPort to the port in redirectUri, or leave redirectUri unset for http://localhost:8765/callback.")
    }
    if (!url.pathname || url.pathname === "/") invalid("a loopback redirect needs a callback path", "Use the path /callback, or leave redirectUri unset.")
  }
  return { uri: configured, port, paths: [url.pathname || "/callback"] }
}
