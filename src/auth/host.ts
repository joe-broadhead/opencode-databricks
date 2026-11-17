/**
 * The workspace URL, and the cloud it belongs to (design §3.1).
 *
 * One account is one workspace, so its host is the plugin's whole target: the OAuth endpoints are built from it, and
 * every REST call package B makes goes to it. The rule is the design's: `https://` and one of `*.cloud.databricks.com`
 * (AWS), `*.azuredatabricks.net` (Azure) or `*.gcp.databricks.com` (GCP); another host, such as PrivateLink or a
 * custom domain, needs `allowCustomHost`.
 *
 * Databricks' account-console hosts also match the AWS and Azure suffixes, and account-level APIs are never called
 * (design §3.1), so they are refused by name. The value is never echoed in an error: a URL can carry a user name, a
 * password or a path, and none of it belongs in a message.
 */
import { DatabricksError } from "../domain/errors.js"

export type Cloud = "aws" | "azure" | "gcp" | "custom"

export interface WorkspaceHost {
  /** `https://<hostname>`, lower case, no trailing slash, no path. */
  readonly host: string
  readonly cloud: Cloud
}

/** The suffixes the declaration's `urlHosts` names, in the same order. */
export const DATABRICKS_HOSTS = ["*.cloud.databricks.com", "*.azuredatabricks.net", "*.gcp.databricks.com"] as const

const REGIONS: readonly { readonly suffix: string; readonly cloud: Exclude<Cloud, "custom"> }[] = [
  { suffix: ".cloud.databricks.com", cloud: "aws" },
  { suffix: ".azuredatabricks.net", cloud: "azure" },
  { suffix: ".gcp.databricks.com", cloud: "gcp" },
]

/** The account consoles (`https://accounts.<cloud>`), refused because this plugin calls workspace APIs only. */
const ACCOUNT_CONSOLES = new Set(["accounts.cloud.databricks.com", "accounts.azuredatabricks.net", "accounts.gcp.databricks.com"])

const REFUSED = "The workspace URL is not an https Databricks workspace URL."

function invalid(what: string, next = "Enter the workspace URL from the browser's address bar, such as https://dbc-1234abcd-5678.cloud.databricks.com."): never {
  throw new DatabricksError("HOST_INVALID", `${REFUSED} ${what}`, next)
}

/**
 * Parse and normalise a workspace URL. Throws `HOST_INVALID` (never echoing the value) for anything the design does not
 * name as a workspace; `allowCustomHost` admits any other https host and marks it `custom`.
 */
export function parseWorkspaceHost(raw: string, allowCustomHost: boolean): WorkspaceHost {
  const input = raw.trim()
  if (!input) invalid("The value is empty.", "Enter the workspace URL, or set accounts.<alias>.host.")
  let url: URL
  try {
    url = new URL(input)
  } catch {
    invalid("It is not an absolute URL.")
  }
  if (url.protocol !== "https:") invalid("It does not start with https://.")
  if (url.username || url.password) invalid("It carries a user name or password.")
  if (url.search) invalid("It has a query string; the workspace URL has no path or query.")
  if (url.hash) invalid("It has a fragment; the workspace URL has no path or query.")
  if (url.pathname !== "/" && url.pathname !== "") invalid("It has a path; the workspace URL has no path or query.")
  const hostname = url.hostname.toLowerCase()
  if (!hostname) invalid("It has no host name.")
  if (ACCOUNT_CONSOLES.has(hostname)) {
    invalid("That is the account console, and this plugin calls workspace APIs only.", "Use the workspace URL for the workspace you work in, not the account console.")
  }
  const region = REGIONS.find((candidate) => hostname.endsWith(candidate.suffix) && hostname.length > candidate.suffix.length)
  if (region) {
    // A workspace host has the default port; an explicit one is not that workspace.
    if (url.port) invalid("It names a port; a Databricks workspace host uses the default.")
    return { host: `https://${hostname}`, cloud: region.cloud }
  }
  if (!allowCustomHost) {
    throw new DatabricksError(
      "HOST_INVALID",
      `${REFUSED} It is not one of ${DATABRICKS_HOSTS.join(", ")}.`,
      "Enter the workspace URL; for PrivateLink or a custom domain, set the option allowCustomHost and the account's host.",
    )
  }
  return { host: url.port ? `https://${hostname}:${url.port}` : `https://${hostname}`, cloud: "custom" }
}
