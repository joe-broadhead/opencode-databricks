/**
 * External result links (design §8.2 steps 2–3): a link must be `https` on the cloud's own storage hosts, and it is
 * fetched **without** an `Authorization` header. Anything else is `EXTERNAL_LINK_REFUSED`; the host check here is the
 * plugin's own, and package B's `fetchLink` checks it again before it sends anything.
 *
 * The allowed hosts for each cloud are the ones Databricks' presigned links use [6]:
 *
 * - AWS: `*.amazonaws.com` (S3 presigned URLs);
 * - Azure: `*.blob.core.windows.net` and `*.dfs.core.windows.net` (SAS URLs);
 * - GCP: `storage.googleapis.com` (signed URLs).
 *
 * A custom-host account (`allowCustomHost`) may be any of the three; the link still has to be one of them.
 */
import { DatabricksError } from "../../domain/errors.js"
import type { AccountInfo, DatabricksPort, ExternalLink } from "../../ports.js"

export function linkHostAllowed(cloud: AccountInfo["cloud"], url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== "https:") return false
  const host = parsed.hostname.toLowerCase()
  const aws = host === "s3.amazonaws.com" || host.endsWith(".amazonaws.com")
  const azure = host.endsWith(".blob.core.windows.net") || host.endsWith(".dfs.core.windows.net")
  const gcp = host === "storage.googleapis.com"
  if (cloud === "aws") return aws
  if (cloud === "azure") return azure
  if (cloud === "gcp") return gcp
  return aws || azure || gcp
}

/** Refuse a link that is not https on the cloud's storage hosts. Never quotes the URL: it carries a credential (§5.8). */
export function assertLinkHost(cloud: AccountInfo["cloud"], url: string): void {
  if (!linkHostAllowed(cloud, url)) {
    throw new DatabricksError("EXTERNAL_LINK_REFUSED", "A result link was not https on this workspace cloud's storage hosts.", "Report it; databricks_save falls back only when links are unavailable, never when they point elsewhere.")
  }
}

/** True when the provider already says the link has expired. */
export const linkExpired = (link: ExternalLink, now: number): boolean => {
  const at = Date.parse(link.expiration)
  return Number.isFinite(at) ? at <= now : false
}

/** A link's bytes: read to its end, with no Authorization header (package B's `fetchLink`). */
export async function readLink(databricks: DatabricksPort, account: string, link: ExternalLink, signal: AbortSignal): Promise<Uint8Array> {
  const stream = await databricks.fetchLink(account, link, signal)
  const parts: Uint8Array[] = []
  let total = 0
  for await (const part of stream as unknown as AsyncIterable<Uint8Array>) {
    parts.push(part)
    total += part.length
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}
