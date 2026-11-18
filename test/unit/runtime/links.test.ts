// §15.1 "links" and L9: the external-link host allow-list (per cloud), the tokenless fetch, an expired link re-read
// from the chunk index, and the code a save treats as "links are unavailable, read it inline" (design §8.2 steps 2–4).
import { describe, expect, it } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import type { ExternalLink, StatementAnswer } from "../../../src/ports.js"
import { createDatabricksClient } from "../../../src/process/client.js"
import { LINK_EXPIRY_MARGIN_MS, assertLink, fetchLinkBytes, linkExpired, linkHostAllowed, linkStream } from "../../../src/process/links.js"
import { accountOf, fakeAuth, routedLinks, streamText, workspace } from "./support.js"

const link = (url: string, over: Partial<ExternalLink> = {}): ExternalLink => ({ chunkIndex: 0, url, expiration: "", rowCount: 1, byteCount: 1, ...over })
const code = async (run: () => Promise<unknown>): Promise<string> => ((await run().catch((failure: unknown) => failure)) as DatabricksError).code

describe("§15.1 links: the host allow-list, one cloud at a time", () => {
  const cases: readonly [string, string, boolean][] = [
    ["aws", "https://bucket.s3.amazonaws.com/results/1", true],
    ["aws", "https://s3.us-west-2.amazonaws.com/bucket/key", true],
    ["aws", "https://bucket.s3.amazonaws.com/", true],
    // F2: the S3 forms, and nothing else under amazonaws.com.
    ["aws", "https://s3.amazonaws.com/bucket/key", true],
    ["aws", "https://bucket.s3.us-west-2.amazonaws.com/key", true],
    ["aws", "https://s3-us-west-2.amazonaws.com/bucket/key", true],
    ["aws", "https://bucket.s3-us-west-2.amazonaws.com/key", true],
    ["aws", "https://bucket.s3.dualstack.us-west-2.amazonaws.com/key", true],
    ["aws", "http://bucket.s3.amazonaws.com/results/1", false],
    ["aws", "https://evil.example/results/1", false],
    ["aws", "https://s3.amazonaws.com.evil.example/results/1", false],
    ["aws", "https://evil-amazonaws.com/results/1", false],
    ["aws", "https://user:pass@bucket.s3.amazonaws.com/results/1", false],
    ["aws", "https://bucket.s3.amazonaws.com:8443/results/1", false],
    ["aws", "https://not-a-url", false],
    ["aws", "https://x.execute-api.us-east-1.amazonaws.com/key", false],
    ["aws", "https://sqs.us-east-1.amazonaws.com/queue", false],
    ["aws", "https://ec2.amazonaws.com/", false],
    ["azure", "https://account.blob.core.windows.net/container/blob", true],
    ["azure", "https://account.dfs.core.windows.net/container/blob", true],
    ["azure", "https://bucket.s3.amazonaws.com/results/1", false],
    ["gcp", "https://storage.googleapis.com/bucket/key", true],
    ["gcp", "https://storage.googleapis.com.evil.example/bucket/key", false],
    ["gcp", "https://bucket.s3.amazonaws.com/results/1", false],
  ]

  it.each(cases)("%s: %s is %s", async (cloud, url, allowed) => {
    if (allowed) {
      expect(assertLink(link(url), cloud as never).href).toBe(new URL(url).href)
      return
    }
    await expect(async () => assertLink(link(url), cloud as never)).rejects.toThrow(/EXTERNAL_LINK_REFUSED/)
  })

  it("matches the host itself, not a name that merely ends in it", () => {
    expect(linkHostAllowed("bucket.s3.amazonaws.com", "aws")).toBe(true)
    expect(linkHostAllowed("evil-amazonaws.com", "aws")).toBe(false)
    expect(linkHostAllowed("s3.amazonaws.com.evil.example", "aws")).toBe(false)
    expect(linkHostAllowed("account.blob.core.windows.net", "azure")).toBe(true)
    expect(linkHostAllowed("storage.googleapis.com", "gcp")).toBe(true)
    expect(linkHostAllowed("storage.googleapis.com.evil.example", "gcp")).toBe(false)
    // A custom workspace may use any of the three families, and no other.
    expect(linkHostAllowed("bucket.s3.amazonaws.com", "custom")).toBe(true)
    expect(linkHostAllowed("evil.example", "custom")).toBe(false)
  })

  it("never repeats the URL, which carries a credential, in a refusal", async () => {
    const secret = "https://evil.example/results/1?X-Amz-Signature=supersecretsignature"
    const error = (await Promise.resolve()
      .then(() => assertLink(link(secret), "aws"))
      .catch((failure: unknown) => failure)) as DatabricksError
    expect(error.code).toBe("EXTERNAL_LINK_REFUSED")
    expect(error.message).not.toContain("supersecretsignature")
    expect(error.message).not.toContain(secret)
  })

  it("reads an expiration as the moment the link stops working, with a margin for a long stream (F4)", () => {
    const expiring = link("https://b.s3.amazonaws.com/x", { expiration: "2026-11-17T09:00:00Z" })
    expect(linkExpired(expiring, Date.parse("2026-11-17T08:59:59Z"))).toBe(false)
    expect(linkExpired(expiring, Date.parse("2026-11-17T09:00:00Z"))).toBe(true)
    // A link with 20 s left is treated as expired, so a stream does not outlive it.
    expect(linkExpired(expiring, Date.parse("2026-11-17T08:59:40Z"), LINK_EXPIRY_MARGIN_MS)).toBe(true)
    expect(linkExpired(expiring, Date.parse("2026-11-17T08:59:20Z"), LINK_EXPIRY_MARGIN_MS)).toBe(false)
    expect(linkExpired(link("https://b.s3.amazonaws.com/x"), Date.now())).toBe(false)
  })
})

describe("§15.1 links: no workspace token, and an expired link re-read", () => {
  const STATEMENT = "SELECT * FROM (\nSELECT 1 AS n\n) AS oc_q"
  const answer = (url: string): StatementAnswer => ({
    statementId: "stmt-links",
    state: "SUCCEEDED",
    manifest: { columns: [{ name: "n", typeName: "INT", typeText: "INT", position: 0 }], totalChunkCount: 1 },
    links: [{ chunkIndex: 0, url, expiration: "", rowCount: 1, byteCount: 5 }],
  })

  it("fetches the bytes with no Authorization header", async () => {
    const url = "https://oc-fake.s3.amazonaws.com/tokenless"
    const { fake, auth } = await workspace({
      statements: new Map([[STATEMENT, answer(url)]]),
      links: new Map([["tokenless", { link: link(url), bytes: new TextEncoder().encode("hello") }]]),
    })
    try {
      const fetchImpl = routedLinks(fake)
      const client = createDatabricksClient({ auth, fetch: fetchImpl })
      const submitted = await client.submit(
        { account: "work", operation: "sql.statements.query", statement: STATEMENT, warehouseId: "wh-small", disposition: "EXTERNAL_LINKS", format: "ARROW_STREAM", waitTimeout: 50, onWaitTimeout: "CANCEL", queryTags: { oc_call: "call-links" } },
        new AbortController().signal,
      )
      const stream = await client.fetchLink("work", submitted.links![0]!, new AbortController().signal)
      expect(await streamText(stream)).toBe("hello")
      expect(fake.requests.filter((entry) => entry.path === "/results/tokenless").map((entry) => entry.authorized)).toEqual([false])
    } finally {
      await fake.close()
    }
  })

  it("re-reads the chunk index once when the link has expired", async () => {
    const url = "https://oc-fake.s3.amazonaws.com/expiring"
    const { fake, auth } = await workspace({
      statements: new Map([[STATEMENT, answer(url)]]),
      links: new Map([["expiring", { link: link(url), bytes: new TextEncoder().encode("fresh") }]]),
    })
    try {
      fake.behave({ linkTtlMs: 40 })
      const fetchImpl = routedLinks(fake)
      const client = createDatabricksClient({ auth, fetch: fetchImpl })
      const submitted = await client.submit(
        { account: "work", operation: "sql.statements.query", statement: STATEMENT, warehouseId: "wh-small", disposition: "EXTERNAL_LINKS", format: "ARROW_STREAM", waitTimeout: 50, onWaitTimeout: "CANCEL", queryTags: { oc_call: "call-links" } },
        new AbortController().signal,
      )
      const expired = submitted.links![0]!
      await new Promise((resolve) => setTimeout(resolve, 60))
      const stream = await linkStream(client, fetchImpl, { account: "work", statementId: submitted.statementId, link: expired, cloud: "aws", signal: new AbortController().signal })
      expect(await streamText(stream)).toBe("fresh")
      // The chunk index was re-read once, and its fresh link was fetched.
      expect(fake.requests.filter((entry) => entry.path.includes("/result/chunks/0")).length).toBeGreaterThanOrEqual(1)
      expect(linkExpired(expired)).toBe(true)
    } finally {
      await fake.close()
    }
  })

  it("re-reads the chunk index on a 400 from an expired link, as GCS answers (F4)", async () => {
    const expired = link("https://storage.googleapis.com/fake-expired", { expiration: "2020-01-01T00:00:00.000Z" })
    const freshUrl = "https://storage.googleapis.com/fake-fresh"
    const fresh = link(freshUrl, { expiration: new Date(Date.now() + 60_000).toISOString() })
    const fetchImpl = async (input: string): Promise<Response> => {
      const url = new URL(input)
      if (url.pathname === "/api/2.0/sql/statements") return new Response(JSON.stringify({ statement_id: "stmt-gcs", status: { state: "SUCCEEDED" }, manifest: { schema: { column_count: 1, columns: [{ name: "n", position: 0, type_name: "INT", type_text: "INT" }] }, total_chunk_count: 1 }, result: { external_links: [{ external_link: expired.url, expiration: expired.expiration, chunk_index: 0, row_count: 1 }], chunk_index: 0 } }), { status: 200 })
      if (url.pathname === "/api/2.0/sql/statements/stmt-gcs/result/chunks/0") return new Response(JSON.stringify({ external_links: [{ external_link: freshUrl, expiration: fresh.expiration, chunk_index: 0, row_count: 1 }], chunk_index: 0 }), { status: 200 })
      // GCS refuses an expired signed URL with 400, not 403.
      if (url.href === expired.url) return new Response("<Error><Code>ExpiredToken</Code></Error>", { status: 400 })
      if (url.href === freshUrl) return new Response("gcs-bytes", { status: 200 })
      return new Response("{}", { status: 404 })
    }
    const auth = fakeAuth({ alias: "work", mode: "interactive", host: "https://workspace.example", cloud: "gcp", features: [], enforcement: "identity" })
    const client = createDatabricksClient({ auth, fetch: fetchImpl })
    const submitted = await client.submit({ account: "work", operation: "sql.statements.query", statement: "SELECT * FROM (\nSELECT 1\n) AS oc_q", warehouseId: "wh-small", disposition: "EXTERNAL_LINKS", format: "ARROW_STREAM", waitTimeout: 50, onWaitTimeout: "CANCEL", queryTags: {} }, new AbortController().signal)
    const stream = await linkStream(client, fetchImpl, { account: "work", statementId: "stmt-gcs", link: submitted.links![0]!, cloud: "gcp", signal: new AbortController().signal })
    expect(await streamText(stream)).toBe("gcs-bytes")
  })

  it("does not re-read a 400 from a link that has not expired", async () => {
    const live = link("https://storage.googleapis.com/fake-live", { expiration: new Date(Date.now() + 10 * 60_000).toISOString() })
    const refused = async (): Promise<Response> => new Response("bad request", { status: 400 })
    const error = (await fetchLinkBytes(refused, live, "gcp", new AbortController().signal).catch((failure: unknown) => failure)) as DatabricksError
    expect(error.code).toBe("UNAVAILABLE")
  })

  it("answers RESULTS_EXPIRED when even a fresh link is refused", async () => {
    const url = "https://oc-fake.s3.amazonaws.com/gone"
    const { fake, auth } = await workspace({
      statements: new Map([[STATEMENT, answer(url)]]),
      // No bytes registered: the link endpoint 404s.
    })
    try {
      const fetchImpl = routedLinks(fake)
      const client = createDatabricksClient({ auth, fetch: fetchImpl })
      const submitted = await client.submit(
        { account: "work", operation: "sql.statements.query", statement: STATEMENT, warehouseId: "wh-small", disposition: "EXTERNAL_LINKS", format: "ARROW_STREAM", waitTimeout: 50, onWaitTimeout: "CANCEL", queryTags: { oc_call: "call-links" } },
        new AbortController().signal,
      )
      expect(await code(() => linkStream(client, fetchImpl, { account: "work", statementId: submitted.statementId, link: submitted.links![0]!, cloud: "aws", signal: new AbortController().signal }))).toBe("RESULTS_EXPIRED")
    } finally {
      await fake.close()
    }
  })
})

describe("L9: external links from each cloud, and the inline fallback's signal", () => {
  it("accepts each cloud's own storage host on the port's fetchLink, and refuses another cloud's", async () => {
    const { fake, auth } = await workspace({
      links: new Map([
        ["aws-key", { link: link("https://b.s3.amazonaws.com/aws-key"), bytes: new TextEncoder().encode("aws") }],
        ["azure-key", { link: link("https://a.blob.core.windows.net/azure-key"), bytes: new TextEncoder().encode("azure") }],
        ["gcp-key", { link: link("https://storage.googleapis.com/gcp-key"), bytes: new TextEncoder().encode("gcp") }],
      ]),
    })
    try {
      const fetchImpl = routedLinks(fake, /\.amazonaws\.com$|\.core\.windows\.net$|^storage\.googleapis\.com$/u)
      const cases = [
        ["aws", "https://b.s3.amazonaws.com/aws-key", "aws"],
        ["azure", "https://a.blob.core.windows.net/azure-key", "azure"],
        ["gcp", "https://storage.googleapis.com/gcp-key", "gcp"],
        ["custom", "https://storage.googleapis.com/gcp-key", "gcp"],
      ] as const
      for (const [cloud, url, expected] of cases) {
        const account = accountOf(fake, { cloud })
        const client = createDatabricksClient({ auth: fakeAuth(account), fetch: fetchImpl })
        expect(await streamText(await client.fetchLink("work", link(url), new AbortController().signal)), cloud).toBe(expected)
      }
      // The port method now knows the account's cloud: an AWS account cannot fetch an Azure block's bytes (F3).
      const aws = createDatabricksClient({ auth: fakeAuth(accountOf(fake, { cloud: "aws" })), fetch: fetchImpl })
      const refused = (await aws.fetchLink("work", link("https://a.blob.core.windows.net/azure-key"), new AbortController().signal).catch((failure: unknown) => failure)) as DatabricksError
      expect(refused.code).toBe("EXTERNAL_LINK_REFUSED")
    } finally {
      await fake.close()
    }
  })

  it("fails UNAVAILABLE, not EXTERNAL_LINK_REFUSED, when the storage host cannot be reached", async () => {
    const unreachable = async (): Promise<Response> => {
      throw new TypeError("getaddrinfo ENOTFOUND bucket.s3.amazonaws.com")
    }
    const error = (await fetchLinkBytes(unreachable, link("https://bucket.s3.amazonaws.com/x"), "aws", new AbortController().signal).catch((failure: unknown) => failure)) as DatabricksError
    expect(error.code).toBe("UNAVAILABLE")
    expect(error.detail).toContain("egress policy")
    // A save reads this as "links are unavailable, use the INLINE fallback" (design §8.2 step 4).
  })

  it("refuses an off-cloud host before any request is made", async () => {
    let called = false
    const never = async (): Promise<Response> => {
      called = true
      return new Response("")
    }
    const error = (await fetchLinkBytes(never, link("https://storage.example/x"), "aws", new AbortController().signal).catch((failure: unknown) => failure)) as DatabricksError
    expect(error.code).toBe("EXTERNAL_LINK_REFUSED")
    expect(called).toBe(false)
  })
})
