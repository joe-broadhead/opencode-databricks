// §15.1 "Results": chunk paging. An INLINE answer's rows are split by `manifest.total_chunk_count`; an
// EXTERNAL_LINKS answer's links are chained by `next_chunk_index`. Both are the Statement Execution API's own fields
// (`GET …/result/chunks/{chunk_index}`), and both end where the API says they end.
import { describe, expect, it } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import type { ChunkAnswer, StatementAnswer } from "../../../src/ports.js"
import { collectChunks, resultChunks } from "../../../src/process/chunks.js"
import { createDatabricksClient } from "../../../src/process/client.js"
import { linkStream } from "../../../src/process/links.js"
import { fakeAuth, routedLinks, streamText, workspace } from "./support.js"

const COLUMN = { name: "n", typeName: "INT", typeText: "INT", position: 0 }
const STATEMENT = "SELECT * FROM (\nSELECT 1 AS n\n) AS oc_q"

const inline = (rows: string[][], totalChunkCount: number): StatementAnswer => ({
  statementId: "stmt-chunks",
  state: "SUCCEEDED",
  manifest: { columns: [COLUMN], totalRowCount: rows.length, totalChunkCount },
  rows,
})

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

const submit = (disposition: "INLINE" | "EXTERNAL_LINKS", format: "JSON_ARRAY" | "ARROW_STREAM") => ({
  account: "work",
  operation: "sql.statements.query" as const,
  statement: STATEMENT,
  warehouseId: "wh-small",
  disposition,
  format,
  waitTimeout: 50,
  onWaitTimeout: "CANCEL" as const,
  queryTags: { oc_call: "call-chunks" },
})

describe("§15.1 results: chunk paging", () => {
  it("walks every INLINE chunk the manifest names, and asks for each once", async () => {
    const rows = [["1"], ["2"], ["3"], ["4"], ["5"]]
    const { fake, auth } = await workspace({ statements: new Map([[STATEMENT, inline(rows, 3)]]) })
    try {
      const client = createDatabricksClient({ auth })
      const answer = await client.submit(submit("INLINE", "JSON_ARRAY"), new AbortController().signal)
      const chunks = await collectChunks(client, "work", answer.statementId, answer, new AbortController().signal)
      expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual([0, 1, 2])
      expect(chunks.flatMap((chunk) => chunk.rows.map((row) => row[0]))).toEqual(["1", "2", "3", "4", "5"])
      expect(fake.requests.filter((entry) => entry.path.includes("/result/chunks/"))).toHaveLength(2)
    } finally {
      await fake.close()
    }
  })

  it("stops at the last chunk when the answer names no next one", async () => {
    const { fake, auth } = await workspace({ statements: new Map([[STATEMENT, inline([["1"]], 1)]]) })
    try {
      const client = createDatabricksClient({ auth })
      const answer = await client.submit(submit("INLINE", "JSON_ARRAY"), new AbortController().signal)
      const chunks = await collectChunks(client, "work", answer.statementId, answer, new AbortController().signal)
      expect(chunks).toHaveLength(1)
      expect(fake.requests.filter((entry) => entry.path.includes("/result/chunks/"))).toHaveLength(0)
    } finally {
      await fake.close()
    }
  })

  it("walks every EXTERNAL_LINKS chunk, following the link's own next index", async () => {
    const links = [
      { chunkIndex: 0, url: "https://oc-fake.s3.amazonaws.com/first", expiration: "", rowCount: 1, byteCount: 3, nextChunkIndex: 1 },
      { chunkIndex: 1, url: "https://oc-fake.s3.amazonaws.com/second", expiration: "", rowCount: 1, byteCount: 4 },
    ]
    const { fake, auth } = await workspace({
      statements: new Map([[STATEMENT, { statementId: "stmt-links", state: "SUCCEEDED", manifest: { columns: [COLUMN], totalChunkCount: 2 }, links }]]),
      links: new Map([
        ["first", { link: links[0]!, bytes: new TextEncoder().encode("abc") }],
        ["second", { link: links[1]!, bytes: new TextEncoder().encode("defg") }],
      ]),
    })
    try {
      const fetchImpl = routedLinks(fake)
      const client = createDatabricksClient({ auth, fetch: fetchImpl })
      const answer = await client.submit(submit("EXTERNAL_LINKS", "ARROW_STREAM"), new AbortController().signal)
      const chunks = await collectChunks(client, "work", answer.statementId, answer, new AbortController().signal)
      expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual([0, 1])
      const bodies = await Promise.all(
        chunks.map((chunk) =>
          linkStream(client, fetchImpl, { account: "work", statementId: answer.statementId, link: chunk.links[0]!, cloud: "aws", signal: new AbortController().signal }).then(streamText),
        ),
      )
      expect(bodies).toEqual(["abc", "defg"])
      // The link fetch carried no workspace token.
      const linkRequests = fake.requests.filter((entry) => entry.path.startsWith("/results/"))
      expect(linkRequests.map((entry) => entry.authorized)).toEqual([false, false])
    } finally {
      await fake.close()
    }
  })

  it("answers RESULTS_EXPIRED for a chunk the warehouse no longer has", async () => {
    const { fake, auth } = await workspace({ statements: new Map([[STATEMENT, inline([["1"]], 3)]]) })
    try {
      const client = createDatabricksClient({ auth })
      const answer = await client.submit(submit("INLINE", "JSON_ARRAY"), new AbortController().signal)
      // One row in three chunks: the fake writes chunks 0 to 2, so chunk 9 is gone.
      const error = (await client.getChunk("work", answer.statementId, 9, new AbortController().signal).catch((failure: unknown) => failure)) as DatabricksError
      expect(error.code).toBe("RESULTS_EXPIRED")
    } finally {
      await fake.close()
    }
  })

  it("walks a three-chunk INLINE result through the documented chunk body (H1)", async () => {
    // The chunk endpoint answers the *result element's* fields at the top level: no `result`, no `status`.
    const documented: Record<string, unknown> = {
      "0": { data_array: [["1"]], chunk_index: 0, row_count: 1, row_offset: 0, next_chunk_index: 1, next_chunk_internal_link: "/api/2.0/sql/statements/stmt-doc/result/chunks/1" },
      "1": { data_array: [["2"], ["3"]], chunk_index: 1, row_count: 2, row_offset: 1, next_chunk_index: 2, next_chunk_internal_link: "/api/2.0/sql/statements/stmt-doc/result/chunks/2" },
      "2": { data_array: [["4"]], chunk_index: 2, row_count: 1, row_offset: 3 },
    }
    const auth = fakeAuth({ alias: "work", mode: "interactive", host: "https://workspace.example", cloud: "aws", features: [], enforcement: "identity" })
    const client = createDatabricksClient({
      auth,
      fetch: async (input) => {
        const url = new URL(input)
        if (url.pathname === "/api/2.0/sql/statements") {
          return json({
            statement_id: "stmt-doc",
            status: { state: "SUCCEEDED" },
            manifest: { schema: { column_count: 1, columns: [{ name: "n", position: 0, type_name: "INT", type_text: "INT" }] }, total_chunk_count: 3, total_row_count: 4 },
            result: documented["0"],
          })
        }
        const chunk = /\/result\/chunks\/(\d+)$/u.exec(url.pathname)?.[1]
        if (chunk !== undefined && documented[chunk]) return json(documented[chunk])
        return new Response("{}", { status: 404 })
      },
    })
    const answer = await client.submit(submit("INLINE", "JSON_ARRAY"), new AbortController().signal)
    const chunks = await collectChunks(client, "work", answer.statementId, answer, new AbortController().signal)
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual([0, 1, 2])
    expect(chunks.flatMap((chunk) => chunk.rows.map((row) => row[0]))).toEqual(["1", "2", "3", "4"])
  })

  it("re-reads an expired link through the documented chunk body (H1, §8.2 step 3)", async () => {
    const expired = { chunkIndex: 0, url: "https://oc-fake.s3.amazonaws.com/expired", expiration: "2020-01-01T00:00:00.000Z", rowCount: 1, byteCount: 5 }
    const freshUrl = "https://oc-fake.s3.amazonaws.com/fresh"
    const freshExpiry = new Date(Date.now() + 60_000).toISOString()
    const auth = fakeAuth({ alias: "work", mode: "interactive", host: "https://workspace.example", cloud: "aws", features: [], enforcement: "identity" })
    // One fetch for both the API and the link, so nothing leaves this machine.
    const fetchImpl = async (input: string, _init?: RequestInit): Promise<Response> => {
      const url = new URL(input)
      if (url.pathname === "/api/2.0/sql/statements") {
        return json({
          statement_id: "stmt-links-doc",
          status: { state: "SUCCEEDED" },
          manifest: { schema: { column_count: 1, columns: [COLUMN] }, total_chunk_count: 1, total_row_count: 1 },
          result: { external_links: [{ external_link: expired.url, expiration: expired.expiration, chunk_index: 0, row_count: 1, byte_count: 5 }], chunk_index: 0 },
        })
      }
      if (url.pathname === "/api/2.0/sql/statements/stmt-links-doc/result/chunks/0") {
        return json({ external_links: [{ external_link: freshUrl, expiration: freshExpiry, chunk_index: 0, row_count: 1, byte_count: 5 }], chunk_index: 0, row_count: 1 })
      }
      if (url.href === freshUrl) return new Response("hello", { status: 200 })
      return new Response("{}", { status: 404 })
    }
    const client = createDatabricksClient({ auth, fetch: fetchImpl })
    const answer = await client.submit(submit("EXTERNAL_LINKS", "ARROW_STREAM"), new AbortController().signal)
    const stream = await linkStream(client, fetchImpl, { account: "work", statementId: answer.statementId, link: answer.links![0]!, cloud: "aws", signal: new AbortController().signal })
    expect(await streamText(stream)).toBe("hello")
  })

  it("fails UNAVAILABLE when a chunk is empty though the result says more exist", async () => {
    const source = {
      async getChunk(_account: string, _id: string, index: number): Promise<ChunkAnswer> {
        return { chunkIndex: index, rows: [], nextChunkIndex: index + 1 }
      },
    }
    const first: StatementAnswer = { statementId: "stmt", state: "SUCCEEDED", rows: [["0"]], nextChunkIndex: 1, manifest: { columns: [COLUMN], totalChunkCount: 3 } }
    const error = (await collectChunks(source, "work", "stmt", first, new AbortController().signal).catch((failure: unknown) => failure)) as DatabricksError
    expect(error.code).toBe("UNAVAILABLE")
    expect(error.detail).toContain("no rows and no links")
  })

  it("refuses a chunk index the answer names twice rather than looping", async () => {
    const source = {
      async getChunk(_account: string, _id: string, index: number): Promise<ChunkAnswer> {
        return { chunkIndex: index, rows: [[String(index)]], nextChunkIndex: 1 }
      },
    }
    const first: StatementAnswer = { statementId: "stmt", state: "SUCCEEDED", rows: [["0"]], nextChunkIndex: 1 }
    const error = (await collectChunks(source, "work", "stmt", first, new AbortController().signal).catch((failure: unknown) => failure)) as DatabricksError
    expect(error.code).toBe("UNAVAILABLE")
    expect(error.detail).toContain("chunk 1 twice")
  })

  it("yields the first chunk without a request, and never past total_chunk_count", async () => {
    let asked = 0
    const source = {
      async getChunk(): Promise<ChunkAnswer> {
        asked += 1
        return { chunkIndex: 1, rows: [["x"]], nextChunkIndex: 9 }
      },
    }
    const first: StatementAnswer = { statementId: "stmt", state: "SUCCEEDED", rows: [["0"]], nextChunkIndex: 1, manifest: { columns: [COLUMN], totalChunkCount: 1 } }
    const seen: number[] = []
    for await (const chunk of resultChunks(source, "work", "stmt", first, new AbortController().signal)) seen.push(chunk.chunkIndex)
    expect(seen).toEqual([0])
    expect(asked).toBe(0)
  })
})
