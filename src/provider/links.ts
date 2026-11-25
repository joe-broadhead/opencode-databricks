/**
 * The external result links, `EXTERNAL_LINKS` answers carry (design §8.2 step 2–4).
 *
 * Databricks' own warnings, and what they cost a client:
 * - "The URL contains temporary access credentials, so protect it and do not set an `Authorization` header in the
 *   download request." So a link is fetched with **no** `Authorization` header, `redirect: "error"`, and its URL never
 *   reaches an error, a log line or the model (design §5.8).
 * - A link "is valid for only a short period, <= 15 minutes"; the answer's `expiration` says when. An expired link is
 *   re-read from the chunk index (`GET …/result/chunks/{chunk_index}` returns a fresh link), once.
 * - The link's host is the workspace cloud's storage: S3 presigned URLs on AWS (`*.amazonaws.com`), Azure SAS URLs
 *   (`*.blob.core.windows.net`, `*.dfs.core.windows.net`) and a GCS signed URL on GCP
 *   (`storage.googleapis.com`). Anything else is `EXTERNAL_LINK_REFUSED` — the plugin never sends a request to a host
 *   Databricks did not name.
 * - A link the network cannot reach (an egress policy, a proxy) is `UNAVAILABLE`, the code a save treats as "links are
 *   unavailable, use the INLINE fallback" (design §8.2 step 4).
 *
 * References: Statement Execution `POST /api/2.0/sql/statements` ("External-link URLs"; the `external_link`,
 * `expiration`, `next_chunk_index` fields) and `GET …/result/chunks/{chunk_index}`.
 */
import { DatabricksError } from "../domain/errors.js"
import type { AccountInfo, ExternalLink } from "../ports.js"
import { redact } from "./redact.js"
import type { Fetch } from "./http.js"
import type { ChunkSource } from "./chunks.js"

export type Cloud = AccountInfo["cloud"]

/**
 * The S3 hosts a Databricks workspace's links use: the global endpoint, the regional forms (`s3.<region>` and
 * `s3-<region>`), their dual-stack names, and the virtual-hosted bucket forms of each (`<bucket>.s3…`), plus the China
 * partition. `*.amazonaws.com` alone would also admit `execute-api`, `sqs` and every other AWS service, which this
 * plugin never needs to fetch from.
 */
const S3_HOSTS: readonly RegExp[] = [
  /^s3\.amazonaws\.com$/u,
  /^s3\.dualstack\.[a-z0-9-]+\.amazonaws\.com$/u,
  /^s3[.-][a-z0-9-]+\.amazonaws\.com$/u,
  /^[a-z0-9.-]+\.s3\.amazonaws\.com$/u,
  /^[a-z0-9.-]+\.s3\.dualstack\.[a-z0-9-]+\.amazonaws\.com$/u,
  /^[a-z0-9.-]+\.s3[.-][a-z0-9-]+\.amazonaws\.com$/u,
  /^s3\.amazonaws\.com\.cn$/u,
  /^s3\.dualstack\.[a-z0-9-]+\.amazonaws\.com\.cn$/u,
  /^s3[.-][a-z0-9-]+\.amazonaws\.com\.cn$/u,
  /^[a-z0-9.-]+\.s3\.amazonaws\.com\.cn$/u,
  /^[a-z0-9.-]+\.s3[.-][a-z0-9-]+\.amazonaws\.com\.cn$/u,
]

/**
 * The storage hosts a cloud's links use. A `custom` workspace (a private link, an unknown cloud) may answer with any of
 * the three: the set stays closed either way. Azure SAS URLs and GCS signed URLs are per-account names under a fixed
 * suffix, so no narrower set exists there.
 */
export const LINK_HOSTS: Readonly<Record<Cloud, readonly RegExp[]>> = {
  aws: S3_HOSTS,
  azure: [/\.blob\.core\.windows\.net$/u, /\.dfs\.core\.windows\.net$/u],
  gcp: [/^storage\.googleapis\.com$/u],
  custom: [...S3_HOSTS, /\.blob\.core\.windows\.net$/u, /\.dfs\.core\.windows\.net$/u, /^storage\.googleapis\.com$/u],
}

/** A link this close to its expiration is treated as expired, so a large stream does not outlive it. */
export const LINK_EXPIRY_MARGIN_MS = 30_000

/** Whether a host is one of `cloud`'s storage hosts: the whole host, so `evil-amazonaws.com` never matches. */
export function linkHostAllowed(hostname: string, cloud: Cloud): boolean {
  const host = hostname.toLowerCase()
  return LINK_HOSTS[cloud].some((pattern) => pattern.test(host))
}

/**
 * A link's URL, checked before any request: https, the cloud's storage host, no credentials in the URL and no port
 * other than 443. A refusal never repeats the URL, which carries a credential.
 */
export function assertLink(link: ExternalLink, cloud: Cloud): URL {
  let url: URL
  try {
    url = new URL(link.url)
  } catch {
    throw new DatabricksError("EXTERNAL_LINK_REFUSED", "A result link is not a URL.", "Report it; the result can be read inline instead.")
  }
  if (url.protocol !== "https:") throw new DatabricksError("EXTERNAL_LINK_REFUSED", "A result link is not https.", "Report it; the result can be read inline instead.")
  if (url.username !== "" || url.password !== "") throw new DatabricksError("EXTERNAL_LINK_REFUSED", "A result link carries credentials in its URL rather than in its query.", "Report it; the result can be read inline instead.")
  if (url.port !== "" && url.port !== "443") throw new DatabricksError("EXTERNAL_LINK_REFUSED", "A result link names a port other than 443.", "Report it; the result can be read inline instead.")
  if (!linkHostAllowed(url.hostname, cloud)) {
    throw new DatabricksError("EXTERNAL_LINK_REFUSED", `A result link points at ${redact(url.hostname)}, which is not the workspace cloud's storage.`, "Report it; the result can be read inline instead.")
  }
  return url
}

/** Whether the answer's `expiration` has passed, or is within `marginMs` of passing (a link with no expiration: no). */
export function linkExpired(link: ExternalLink, now: number = Date.now(), marginMs = 0): boolean {
  if (!link.expiration) return false
  const expires = Date.parse(link.expiration)
  return Number.isFinite(expires) && expires <= now + marginMs
}

/** One link's bytes: no Authorization header, no redirect, streamed (design §8.2 step 2). */
export async function fetchLinkBytes(fetchImpl: Fetch, link: ExternalLink, cloud: Cloud, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const url = assertLink(link, cloud)
  let response: Response
  try {
    response = await fetchImpl(url.href, { method: "GET", headers: {}, redirect: "error", signal })
  } catch (error) {
    if (signal.aborted) throw new DatabricksError("CANCELLED")
    const reason = error instanceof Error ? redact(error.message) : ""
    throw new DatabricksError("UNAVAILABLE", `A result link could not be reached${reason ? ` (${reason})` : ""}; the storage host may be blocked by the egress policy.`, "Retry the call; a save can read the result inline instead.")
  }
  if (!response.ok) {
    // An expired link is refused by the storage host: S3 and Azure answer 403 (or 404), GCS answers 400.
    if (response.status === 403 || response.status === 404 || (response.status === 400 && linkExpired(link, Date.now(), LINK_EXPIRY_MARGIN_MS))) {
      throw new LinkGone(`The result link was refused (HTTP ${response.status}); it has expired.`)
    }
    throw new DatabricksError("UNAVAILABLE", `A result link answered HTTP ${response.status}.`, "Retry the call; a save can read the result inline instead.")
  }
  if (!response.body) throw new DatabricksError("UNAVAILABLE", "A result link answered with no body.", "Retry the call; a save can read the result inline instead.")
  return response.body
}

/** A link that is gone: the caller may re-read the chunk index once for a fresh one. */
export class LinkGone extends DatabricksError {
  constructor(message: string) {
    super("RESULTS_EXPIRED", message, "Re-read the result chunk, or run the query again.")
  }
}

/**
 * One chunk's bytes, re-reading the chunk index when the link has expired or the storage refused it (design §8.2
 * step 3). The fresh link passes the same host check before it is fetched.
 */
export async function linkStream(
  source: ChunkSource,
  fetchImpl: Fetch,
  input: { readonly account: string; readonly statementId: string; readonly link: ExternalLink; readonly cloud: Cloud; readonly signal: AbortSignal; readonly now?: () => number },
): Promise<ReadableStream<Uint8Array>> {
  const now = input.now ?? Date.now
  if (!linkExpired(input.link, now(), LINK_EXPIRY_MARGIN_MS)) {
    try {
      return await fetchLinkBytes(fetchImpl, input.link, input.cloud, input.signal)
    } catch (error) {
      if (!(error instanceof LinkGone)) throw error
    }
  }
  // The chunk index always answers a fresh URL while the statement's results are retained (12 hours).
  const page = await source.getChunk(input.account, input.statementId, input.link.chunkIndex, input.signal)
  const fresh = (page.links ?? []).find((link) => link.chunkIndex === input.link.chunkIndex) ?? page.links?.[0]
  // A chunk exists only after the statement succeeded, so a chunk index with no link means the result is gone.
  if (!fresh) throw new DatabricksError("RESULTS_EXPIRED", "The statement's result is gone, and its chunk index no longer names a link.", "Run the query again.")
  try {
    return await fetchLinkBytes(fetchImpl, fresh, input.cloud, input.signal)
  } catch (error) {
    if (error instanceof LinkGone) throw new DatabricksError("RESULTS_EXPIRED", "A fresh result link was refused, so the result has expired.", "Run the query again.")
    throw error
  }
}
