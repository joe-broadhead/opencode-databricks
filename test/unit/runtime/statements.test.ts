// §15.1 "retries": the statement submit is never resent (§9) — its answer is recovered from Query History; §15.1's
// query tags; §15.3 Stop: a signal cancels the statement the call started; the asynchronous poll; L5's cache identity;
// L8's cancel at the wait.
import { describe, expect, it, vi } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import type { AuthPort, StatementAnswer, StatementRequest } from "../../../src/ports.js"
import { type DatabricksClientOptions, createDatabricksClient } from "../../../src/process/client.js"
import { historyStatus, pollUntilDone, queryTagList, serverWaitSeconds, statementBody, toStatementAnswer } from "../../../src/process/statements.js"
import { inspect } from "node:util"
import { DUMMY_TOKEN } from "../../fake/ports.js"
import { fakeAuth, recordedSleeps, until, workspace } from "./support.js"

/** The read path's wrapped text (src/sql/analyze.ts's `wrap`), as every read and save sends it. */
const STATEMENT = "SELECT * FROM (\nSELECT 1 AS one\n) AS oc_q"

const request = (over: Partial<StatementRequest> = {}): StatementRequest => ({
  account: "work",
  operation: "sql.statements.query",
  statement: STATEMENT,
  warehouseId: "wh-small",
  catalog: "main",
  schema: "sales",
  disposition: "INLINE",
  format: "JSON_ARRAY",
  waitTimeout: 50,
  onWaitTimeout: "CANCEL",
  queryTags: { oc_tool: "query", oc_session: "sess-example", oc_call: "call-example" },
  ...over,
})

const oneRow: StatementAnswer = {
  statementId: "",
  state: "SUCCEEDED",
  manifest: { columns: [{ name: "one", typeName: "INT", typeText: "INT", position: 0 }], totalRowCount: 1, totalChunkCount: 1 },
  rows: [["1"]],
}

const clientFor = (auth: AuthPort, options: Omit<DatabricksClientOptions, "auth"> = {}) => createDatabricksClient({ auth, retryBaseMs: 1, ...options })

const posted = (requests: readonly { path: string; method: string; body?: unknown }[]) => requests.filter((entry) => entry.method === "POST" && entry.path === "/api/2.0/sql/statements")

describe("§15.1 retries: an ambiguous submit is recovered, never resent", () => {
  it("sends one POST when the answer never arrives, and joins the statement history recorded", async () => {
    const { fake, auth } = await workspace({ statements: new Map([[STATEMENT, oneRow]]) })
    try {
      fake.behave({ dropSubmitAnswer: true })
      const client = clientFor(auth)
      const answer = await client.submit(request(), new AbortController().signal)
      expect(posted(fake.requests)).toHaveLength(1)
      expect(answer.state).toBe("SUCCEEDED")
      expect(answer.ambiguous).toBe(true)
      expect(answer.rows).toEqual([["1"]])
      // The recovery matched the request's oc_call tag in Query History.
      const history = fake.state.history.find((entry) => entry.queryId === answer.statementId)
      expect(history?.queryTags?.oc_call).toBe("call-example")
    } finally {
      await fake.close()
    }
  })

  it("answers UNAVAILABLE with databricks_history when there is nothing to join", async () => {
    const authorisation = fakeAuth({ alias: "work", mode: "interactive", host: "https://workspace.example", cloud: "aws", features: [], enforcement: "identity" })
    const calls: string[] = []
    const client = clientFor(authorisation, {
      fetch: async (input) => {
        const url = new URL(input)
        calls.push(`${url.pathname}${url.search}`)
        if (url.pathname === "/api/2.0/sql/statements") throw new TypeError("fetch failed")
        return new Response(JSON.stringify({ res: [] }), { status: 200, headers: { "content-type": "application/json" } })
      },
    })
    const error = (await client.submit(request(), new AbortController().signal).catch((failure: unknown) => failure)) as DatabricksError
    expect(error.code).toBe("UNAVAILABLE")
    expect(error.detail).toContain("may have run")
    expect(error.nextStep).toContain("databricks_history")
    // One submit and one history read: the submit was not sent again.
    expect(calls.filter((path) => path.startsWith("/api/2.0/sql/statements"))).toHaveLength(1)
    expect(calls.some((path) => path.startsWith("/api/2.0/sql/history/queries"))).toBe(true)
  })

  it("also matches the exact wrapped text, because query tags are Public Preview", async () => {
    const authorisation = fakeAuth({ alias: "work", mode: "interactive", host: "https://workspace.example", cloud: "aws", features: [], enforcement: "identity" })
    const client = clientFor(authorisation, {
      fetch: async (input) => {
        const url = new URL(input)
        if (url.pathname === "/api/2.0/sql/statements") throw new TypeError("fetch failed")
        if (url.pathname === "/api/2.0/sql/history/queries") {
          return new Response(JSON.stringify({ res: [{ query_id: "stmt-from-text", status: "FINISHED", warehouse_id: "wh-small", query_text: STATEMENT, query_start_time_ms: Date.now() }] }), { status: 200 })
        }
        if (url.pathname === "/api/2.0/sql/statements/stmt-from-text") {
          return new Response(JSON.stringify({ statement_id: "stmt-from-text", status: { state: "SUCCEEDED" }, manifest: { schema: { columns: [] } }, result: { data_array: [] } }), { status: 200 })
        }
        return new Response("{}", { status: 200 })
      },
    })
    const answer = await client.submit(request(), new AbortController().signal)
    expect(answer.statementId).toBe("stmt-from-text")
    expect(answer.ambiguous).toBe(true)
  })
})

/** A workspace that answers only the recovery's calls, with the history rows a test names. */
function recoveringWorkspace(rows: unknown[], options: { readonly me?: unknown; readonly joined?: unknown } = {}) {
  const calls: string[] = []
  const fetchImpl = async (input: string): Promise<Response> => {
    const url = new URL(input)
    calls.push(`${url.pathname}${url.search}`)
    if (url.pathname === "/api/2.0/sql/statements") throw new TypeError("fetch failed")
    if (url.pathname === "/api/2.0/preview/scim/v2/Me") {
      return new Response(JSON.stringify(options.me ?? { id: "1000000000000001", userName: "user@example.com" }), { status: 200 })
    }
    if (url.pathname === "/api/2.0/sql/history/queries") return new Response(JSON.stringify({ res: rows }), { status: 200 })
    if (url.pathname.startsWith("/api/2.0/sql/statements/") && !url.pathname.endsWith("/cancel")) {
      if (options.joined === undefined) return new Response("{}", { status: 404 })
      return new Response(JSON.stringify(options.joined), { status: 200 })
    }
    if (url.pathname.endsWith("/cancel")) return new Response("{}", { status: 200 })
    return new Response("{}", { status: 200 })
  }
  const client = createDatabricksClient({ auth: fakeAuth({ alias: "work", mode: "interactive", host: "https://workspace.example", cloud: "aws", features: [], enforcement: "identity" }), fetch: fetchImpl, retryBaseMs: 1 })
  return { client, calls }
}

const joinedStatement = {
  statement_id: "stmt-joined",
  status: { state: "SUCCEEDED" },
  manifest: { schema: { column_count: 1, columns: [{ name: "one", position: 0, type_name: "INT", type_text: "INT" }] }, total_chunk_count: 1, total_row_count: 1 },
  result: { chunk_index: 0, data_array: [["1"]], row_count: 1 },
}

describe("M1: the recovery joins only this call's statement", () => {
  it("never joins a same-text record that carries another call's oc_call", async () => {
    const { client, calls } = recoveringWorkspace([
      { query_id: "other-statement", status: "FINISHED", warehouse_id: "wh-small", user_id: 1000000000000001, query_start_time_ms: Date.now() - 1_000, query_text: STATEMENT, query_tags: [{ key: "oc_call", value: "someone-elses" }] },
    ], { joined: joinedStatement })
    const error = (await client.submit(request(), new AbortController().signal).catch((failure: unknown) => failure)) as DatabricksError
    expect(error.code).toBe("UNAVAILABLE")
    expect(calls.filter((path) => path.startsWith("/api/2.0/sql/statements/"))).toEqual([])
    expect(calls.some((path) => path.endsWith("/cancel"))).toBe(false)
  })

  it("never joins a same-text record that started before this submit", async () => {
    const { client } = recoveringWorkspace([
      { query_id: "earlier-statement", status: "FINISHED", warehouse_id: "wh-small", user_id: 1000000000000001, query_start_time_ms: Date.now() - 60_000, query_text: STATEMENT },
    ], { joined: joinedStatement })
    const error = (await client.submit(request(), new AbortController().signal).catch((failure: unknown) => failure)) as DatabricksError
    expect(error.code).toBe("UNAVAILABLE")
  })

  it("never joins a tagless same-text record that names another identity", async () => {
    const { client } = recoveringWorkspace([
      { query_id: "colleagues-statement", status: "FINISHED", warehouse_id: "wh-small", user_id: 999, query_start_time_ms: Date.now() - 1_000, query_text: STATEMENT },
    ], { joined: joinedStatement })
    const error = (await client.submit(request(), new AbortController().signal).catch((failure: unknown) => failure)) as DatabricksError
    expect(error.code).toBe("UNAVAILABLE")
  })

  it("still joins a tagless same-text record of this identity, as the design's fallback says", async () => {
    const { client } = recoveringWorkspace([
      { query_id: "stmt-joined", status: "FINISHED", warehouse_id: "wh-small", user_id: 1000000000000001, query_start_time_ms: Date.now() - 1_000, query_text: STATEMENT },
    ], { joined: joinedStatement })
    const answer = await client.submit(request(), new AbortController().signal)
    expect(answer.statementId).toBe("stmt-joined")
    expect(answer.ambiguous).toBe(true)
  })

  it("a stop before anything was sent recovers and cancels nothing", async () => {
    const { client, calls } = recoveringWorkspace([])
    const controller = new AbortController()
    controller.abort()
    const error = (await client.submit(request(), controller.signal).catch((failure: unknown) => failure)) as DatabricksError
    expect(error.code).toBe("CANCELLED")
    expect(calls).toEqual([])
  })
})

describe("§15.1 query tags: the plugin's tag, the call's, and the API's 20", () => {
  it("sends the design's body, with oc_plugin and the call's own tags", async () => {
    const { fake, auth } = await workspace({ statements: new Map([[STATEMENT, oneRow]]) })
    try {
      const client = clientFor(auth)
      await client.submit(request({ rowLimit: 50, byteLimit: 1024 }), new AbortController().signal)
      const body = posted(fake.requests)[0]?.body as Record<string, unknown>
      expect(body).toMatchObject({
        statement: STATEMENT,
        warehouse_id: "wh-small",
        catalog: "main",
        schema: "sales",
        row_limit: 50,
        byte_limit: 1024,
        disposition: "INLINE",
        format: "JSON_ARRAY",
        wait_timeout: "50s",
        on_wait_timeout: "CANCEL",
      })
      expect(body.query_tags).toContainEqual({ key: "oc_plugin", value: "databricks" })
      expect(body.query_tags).toContainEqual({ key: "oc_call", value: "call-example" })
      expect(body.query_tags).toContainEqual({ key: "oc_session", value: "sess-example" })
    } finally {
      await fake.close()
    }
  })

  it("drops a caller's tag the API would reject, and never an @@ key (F8)", () => {
    const sent = queryTagList({
      "bad:key": "v",
      "bad,key": "v",
      "bad-key": "v",
      "bad/key": "v",
      "bad=key": "v",
      "bad.key": "v",
      "@@reserved": "v",
      overlong: "x".repeat(129),
      fine: "ok",
      "key with space": "ok",
    })
    expect(sent.map((tag) => tag.key).sort()).toEqual(["fine", "key with space", "oc_plugin"])
    expect(sent).toContainEqual({ key: "oc_plugin", value: "databricks" })
    expect(sent).toContainEqual({ key: "fine", value: "ok" })
  })

  it("keeps the plugin's tag against a caller's attempt, and caps the list at 20", () => {
    const tags = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`tag${index}`, `${index}`]))
    const body = statementBody(request({ queryTags: { ...tags, oc_plugin: "something-else" } }))
    const sent = body.query_tags as { key: string; value?: string }[]
    expect(sent).toHaveLength(20)
    expect(sent.filter((tag) => tag.key === "oc_plugin")).toEqual([{ key: "oc_plugin", value: "databricks" }])
  })

  it("keeps the server's wait in its own range: 0, or 5–50 s, never 1–4", () => {
    expect(statementBody(request({ waitTimeout: 0 })).wait_timeout).toBe("0s")
    // The API takes 0 or 5–50 only; a caller's 1–4 is rounded up to the shortest synchronous wait (M3).
    expect(statementBody(request({ waitTimeout: 1 })).wait_timeout).toBe("5s")
    expect(statementBody(request({ waitTimeout: 4 })).wait_timeout).toBe("5s")
    expect(statementBody(request({ waitTimeout: 5 })).wait_timeout).toBe("5s")
    expect(statementBody(request({ waitTimeout: 50 })).wait_timeout).toBe("50s")
    expect(statementBody(request({ waitTimeout: 600 })).wait_timeout).toBe("50s")
    expect(serverWaitSeconds(3)).toBe(5)
    expect(serverWaitSeconds(-1)).toBe(0)
  })

  it("passes named parameters as the API takes them", () => {
    const body = statementBody(request({ parameters: [{ name: "day", value: "2026-11-17", type: "DATE" }, { name: "name", value: null }] }))
    // A null parameter is sent without `value`: the API reads that as NULL (the contract's Param note).
    expect(body.parameters).toEqual([{ name: "day", value: "2026-11-17", type: "DATE" }, { name: "name" }])
  })
})

describe("F5: a link's URL is never in what a result serialises", () => {
  it("keeps the URL readable but non-enumerable", () => {
    const answer = toStatementAnswer({
      statement_id: "stmt-secret",
      status: { state: "SUCCEEDED" },
      manifest: { schema: { column_count: 0, columns: [] }, total_chunk_count: 1 },
      result: { external_links: [{ external_link: "https://b.s3.amazonaws.com/x?X-Amz-Signature=supersecret", expiration: "2026-11-17T09:45:00Z", chunk_index: 0 }], chunk_index: 0 },
    })
    const link = answer.links?.[0]!
    expect(link.url).toContain("X-Amz-Signature")
    expect(JSON.stringify(answer)).not.toContain("supersecret")
    expect(JSON.stringify(link)).not.toContain("supersecret")
    expect(inspect(answer)).not.toContain("supersecret")
    expect(inspect(link)).not.toContain("b.s3.amazonaws.com")
    expect(link.chunkIndex).toBe(0)
  })
})

describe("§15.3 Stop: the signal cancels the statement this call started", () => {
  it("says so when the cancel was not confirmed (F10)", async () => {
    const source = {
      async getStatement(): Promise<StatementAnswer> {
        return { statementId: "stmt-unconfirmed", state: "RUNNING" }
      },
      async cancelStatement(): Promise<void> {
        throw new Error("Databricks refused the cancel")
      },
    }
    const stopped = new DatabricksError("CANCELLED")
    const error = (await pollUntilDone(source, {
      account: "work",
      statementId: "stmt-unconfirmed",
      untilMs: Date.now() + 60_000,
      signal: new AbortController().signal,
      sleep: async () => {
        throw stopped
      },
    }).catch((failure: unknown) => failure)) as DatabricksError
    expect(error.code).toBe("CANCELLED")
    expect(error.detail).toContain("did not confirm")
    expect(error.nextStep).toContain("databricks_cancel")
  })

  it("cancels a statement the poll was watching", async () => {
    const { fake, auth } = await workspace({ statements: new Map([[STATEMENT, { ...oneRow, state: "PENDING" }]]) })
    try {
      const client = clientFor(auth)
      const submitted = await client.submit(request({ onWaitTimeout: "CONTINUE" }), new AbortController().signal)
      expect(submitted.state).toBe("PENDING")
      const controller = new AbortController()
      const polling = pollUntilDone(client, {
        account: "work",
        statementId: submitted.statementId,
        untilMs: Date.now() + 60_000,
        signal: controller.signal,
        // The first wait is the moment a person presses Stop.
        sleep: async () => {
          controller.abort()
        },
      })
      const error = (await polling.catch((failure: unknown) => failure)) as DatabricksError
      expect(error.code).toBe("CANCELLED")
      expect(fake.cancelled).toContain(submitted.statementId)
      expect(fake.requests.some((entry) => entry.path === `/api/2.0/sql/statements/${submitted.statementId}/cancel`)).toBe(true)
    } finally {
      await fake.close()
    }
  })

  it("cancels what an aborted submit had already started, after finding it in Query History", async () => {
    const { fake, auth } = await workspace({ statements: new Map([[STATEMENT, oneRow]]) })
    try {
      fake.behave({ latencyMs: 60 })
      const client = clientFor(auth)
      const controller = new AbortController()
      const submitting = client.submit(request(), controller.signal)
      await until("the fake has the submit", () => posted(fake.requests).length === 1)
      controller.abort()
      const error = (await submitting.catch((failure: unknown) => failure)) as DatabricksError
      expect(error.code).toBe("CANCELLED")
      expect(posted(fake.requests)).toHaveLength(1)
      await until("the statement is cancelled", () => fake.cancelled.length === 1)
      expect(fake.requests.some((entry) => entry.method === "POST" && entry.path.endsWith("/cancel"))).toBe(true)
    } finally {
      await fake.close()
    }
  })
})

describe("§9 the asynchronous statement: CONTINUE, then a poll at most once a second", () => {
  it("sees PENDING, then RUNNING, then SUCCEEDED with its rows", async () => {
    const { fake, auth } = await workspace({ statements: new Map([[STATEMENT, { ...oneRow, state: "PENDING" }]]) })
    try {
      const client = clientFor(auth)
      const submitted = await client.submit(request({ onWaitTimeout: "CONTINUE" }), new AbortController().signal)
      expect(submitted.state).toBe("PENDING")
      const sleeps = recordedSleeps()
      const answer = await pollUntilDone(client, {
        account: "work",
        statementId: submitted.statementId,
        untilMs: Date.now() + 60_000,
        signal: new AbortController().signal,
        sleep: sleeps.sleep,
      })
      expect(answer.state).toBe("SUCCEEDED")
      expect(answer.rows).toEqual([["1"]])
      expect(sleeps.waits.every((wait) => wait === 1000)).toBe(true)
      expect(fake.cancelled).toEqual([])
    } finally {
      await fake.close()
    }
  })

  it("answers RUNNING with a next when the call's budget runs out, and cancels nothing", async () => {
    const { fake, auth } = await workspace({ statements: new Map([[STATEMENT, { ...oneRow, state: "PENDING" }]]) })
    try {
      const client = clientFor(auth)
      const submitted = await client.submit(request({ onWaitTimeout: "CONTINUE" }), new AbortController().signal)
      let now = Date.now()
      const answer = await pollUntilDone(client, {
        account: "work",
        statementId: submitted.statementId,
        untilMs: now + 500,
        signal: new AbortController().signal,
        now: () => now,
        sleep: async () => {
          now += 1000
        },
      })
      expect(answer.state).toBe("RUNNING")
      expect(fake.cancelled).toEqual([])
    } finally {
      await fake.close()
    }
  })
})

describe("L8: the stopped warehouse, the cancel at the wait, and a stop that is refused", () => {
  it("a submit against a stopped warehouse starts it, and the state proves the TOCTOU", async () => {
    const { fake, auth } = await workspace()
    try {
      fake.behave({ autoStartOnSubmit: true })
      const before = fake.state.warehouses.get("wh-stopped")
      expect(before?.state).toBe("STOPPED")
      const client = clientFor(auth)
      await client.submit(request({ warehouseId: "wh-stopped" }), new AbortController().signal)
      expect(fake.state.warehouses.get("wh-stopped")?.state).toBe("RUNNING")
    } finally {
      await fake.close()
    }
  })

  it("CANCEL at the wait answers CANCELED, once, and nothing else is sent", async () => {
    const { fake, auth } = await workspace({ statements: new Map([[STATEMENT, { ...oneRow, state: "RUNNING" }]]) })
    try {
      const client = clientFor(auth)
      const answer = await client.submit(request({ onWaitTimeout: "CANCEL" }), new AbortController().signal)
      expect(answer.state).toBe("CANCELED")
      expect(posted(fake.requests)).toHaveLength(1)
    } finally {
      await fake.close()
    }
  })

  it("refuses a stop without Can manage as STOP_NOT_PERMITTED, with Databricks' text untrusted", async () => {
    const auth = fakeAuth({ alias: "work", mode: "interactive", host: "https://workspace.example", cloud: "aws", features: [], enforcement: "identity" })
    const client = clientFor(auth, {
      fetch: async () => new Response(JSON.stringify({ error_code: "PERMISSION_DENIED", message: "You need CAN MANAGE on the warehouse." }), { status: 403 }),
    })
    const error = (await client.stopWarehouse("work", "wh-small", new AbortController().signal).catch((failure: unknown) => failure)) as DatabricksError
    expect(error.code).toBe("STOP_NOT_PERMITTED")
    expect(error.providerError?.message).toContain("CAN MANAGE")
    expect(error.detail).not.toContain("CAN MANAGE")
  })
})

describe("the port's waitForStatement: the asynchronous read behind one call", () => {
  it("polls to SUCCEEDED and answers the rows", async () => {
    const { fake, auth } = await workspace({ statements: new Map([[STATEMENT, { ...oneRow, state: "PENDING" }]]) })
    try {
      const client = clientFor(auth)
      const submitted = await client.submit(request({ onWaitTimeout: "CONTINUE" }), new AbortController().signal)
      const answer = await client.waitForStatement("work", submitted.statementId, { untilMs: Date.now() + 10_000 }, new AbortController().signal)
      expect(answer.state).toBe("SUCCEEDED")
      expect(answer.rows).toEqual([["1"]])
      expect(fake.cancelled).toEqual([])
    } finally {
      await fake.close()
    }
  })

  it("answers a terminal statement without polling, and cancels on a stop", async () => {
    const { fake, auth } = await workspace({ statements: new Map([[STATEMENT, oneRow]]) })
    try {
      const client = clientFor(auth)
      const submitted = await client.submit(request({ onWaitTimeout: "CONTINUE" }), new AbortController().signal)
      expect((await client.waitForStatement("work", submitted.statementId, { untilMs: Date.now() + 10_000 }, new AbortController().signal)).state).toBe("SUCCEEDED")
      // A second wait on a PENDING statement, stopped: the port cancels what it started (design §9).
      const pending = await workspace({ statements: new Map([[STATEMENT, { ...oneRow, state: "PENDING" }]]) })
      try {
        const second = clientFor(pending.auth)
        const started = await second.submit(request({ onWaitTimeout: "CONTINUE" }), new AbortController().signal)
        const controller = new AbortController()
        controller.abort()
        const error = (await second.waitForStatement("work", started.statementId, { untilMs: Date.now() + 10_000 }, controller.signal).catch((failure: unknown) => failure)) as DatabricksError
        expect(error.code).toBe("CANCELLED")
        expect(pending.fake.cancelled).toContain(started.statementId)
      } finally {
        await pending.fake.close()
      }
    } finally {
      await fake.close()
    }
  })
})

describe("M4: Query History's states, as the API documents them", () => {
  it("reads the compiling and started states as running, and never invents finished", () => {
    expect(historyStatus("QUEUED", true)).toBe("QUEUED")
    expect(historyStatus("STARTED", false)).toBe("RUNNING")
    expect(historyStatus("COMPILING", false)).toBe("RUNNING")
    expect(historyStatus("COMPILED", false)).toBe("RUNNING")
    expect(historyStatus("RUNNING", false)).toBe("RUNNING")
    expect(historyStatus("CANCELED", true)).toBe("CANCELED")
    expect(historyStatus("FAILED", true)).toBe("FAILED")
    expect(historyStatus("FINISHED", true)).toBe("FINISHED")
    // FINISHED without is_final is not final; an unknown value is treated as running, the safe reading for cleanup.
    expect(historyStatus("FINISHED", false)).toBe("RUNNING")
    expect(historyStatus("SOMETHING_NEW", true)).toBe("RUNNING")
    expect(historyStatus(undefined, undefined)).toBe("RUNNING")
  })
})

describe("L5: one result-cache identity, with and without row_limit", () => {
  it("sends the same statement, parameters, warehouse, catalog and schema for a read and its save", async () => {
    const { fake, auth } = await workspace({ statements: new Map([[STATEMENT, oneRow]]) })
    try {
      const client = clientFor(auth)
      const signal = new AbortController().signal
      await client.submit(request({ rowLimit: 50 }), signal)
      await client.submit(request({ operation: "sql.statements.query", disposition: "EXTERNAL_LINKS", format: "ARROW_STREAM", byteLimit: 268_435_456 }), signal)
      const [read, save] = posted(fake.requests).map((entry) => entry.body as Record<string, unknown>)
      for (const key of ["statement", "warehouse_id", "catalog", "schema"]) expect(save?.[key], key).toEqual(read?.[key])
      expect(read?.row_limit).toBe(50)
      expect(save?.row_limit).toBeUndefined()
      expect(save?.disposition).toBe("EXTERNAL_LINKS")
      expect(save?.format).toBe("ARROW_STREAM")
      // The fake's result cache (the warehouse's, on a real workspace) served the second run unchanged.
      const page = await client.history("work", { includeMetrics: true }, signal)
      expect(page.items[0]?.resultFromCache).toBe(true)
      expect(page.items[0]?.queryText).toBe(STATEMENT)
      // Without include_metrics the API returns no metrics at all, and the client invents none (M5).
      const bare = await client.history("work", {}, signal)
      expect(bare.items[0]?.resultFromCache).toBeUndefined()
    } finally {
      await fake.close()
    }
  })
})

describe("Query History's order, newest first, when two statements share a millisecond", () => {
  // macOS CI (run 44204769617): the read and its save were recorded in the same millisecond, the fake sorted by start
  // time alone, and the tie kept the older record first, so L5 saw the uncached run. A frozen clock makes the tie
  // certain, so this fails without the fake's tie-break, on any machine.
  it("lists the statement recorded last first", async () => {
    const frozen = Date.now()
    const now = vi.spyOn(Date, "now").mockReturnValue(frozen)
    const { fake, auth } = await workspace({ statements: new Map([[STATEMENT, oneRow]]) })
    try {
      const client = clientFor(auth)
      const signal = new AbortController().signal
      const first = await client.submit(request({ rowLimit: 50 }), signal)
      const second = await client.submit(request({ rowLimit: 50 }), signal)
      const page = await client.history("work", { includeMetrics: true }, signal)
      expect(page.items.map((item) => item.queryStartTimeMs)).toEqual([frozen, frozen])
      expect(page.items.map((item) => item.queryId)).toEqual([second.statementId, first.statementId])
      expect(page.items.map((item) => item.resultFromCache)).toEqual([true, false])
    } finally {
      now.mockRestore()
      await fake.close()
    }
  })
})

describe("the submit's own errors", () => {
  it("maps an invalid parameter to INPUT_INVALID, not SQL_INVALID (M3)", async () => {
    const auth = fakeAuth({ alias: "work", mode: "interactive", host: "https://workspace.example", cloud: "aws", features: [], enforcement: "identity" })
    const client = clientFor(auth, {
      fetch: async () => new Response(JSON.stringify({ error_code: "INVALID_PARAMETER_VALUE", message: "wait_timeout must be 0 or between 5 and 50." }), { status: 400 }),
    })
    const error = (await client.submit(request(), new AbortController().signal).catch((failure: unknown) => failure)) as DatabricksError
    expect(error.code).toBe("INPUT_INVALID")
    expect(error.providerError?.errorCode).toBe("INVALID_PARAMETER_VALUE")
  })

  it("maps a rejected statement to SQL_INVALID and keeps the parse error untrusted", async () => {
    const auth = fakeAuth({ alias: "work", mode: "interactive", host: "https://workspace.example", cloud: "aws", features: [], enforcement: "identity" })
    const client = clientFor(auth, {
      fetch: async () => new Response(JSON.stringify({ error_code: "BAD_REQUEST", message: "[PARSE_SYNTAX_ERROR] Syntax error at or near 'SELEC'." }), { status: 400 }),
    })
    const error = (await client.submit(request(), new AbortController().signal).catch((failure: unknown) => failure)) as DatabricksError
    expect(error.code).toBe("SQL_INVALID")
    expect(error.providerError).toEqual({ errorCode: "BAD_REQUEST", message: "[PARSE_SYNTAX_ERROR] Syntax error at or near 'SELEC'.", trust: "untrusted" })
    expect(error.detail).not.toContain("PARSE_SYNTAX_ERROR")
  })

  it("keeps the token out of every provider error", async () => {
    const auth = fakeAuth({ alias: "work", mode: "interactive", host: "https://workspace.example", cloud: "aws", features: [], enforcement: "identity" })
    const client = clientFor(auth, {
      fetch: async () => new Response(JSON.stringify({ error_code: "BAD_REQUEST", message: `the token ${DUMMY_TOKEN} is wrong` }), { status: 400 }),
    })
    const error = (await client.submit(request(), new AbortController().signal).catch((failure: unknown) => failure)) as DatabricksError
    expect(JSON.stringify(error.providerError)).not.toContain(DUMMY_TOKEN)
  })
})
