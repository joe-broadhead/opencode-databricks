/**
 * Design §5.1 with `PATH_RULE` (`src/domain/functions.ts`), package C's must-prove "the SQL path" part:
 *
 * - a read whose names resolve along the session path (`count(*)`, `BETWEEN`, `EXTRACT`, a `LATERAL VIEW` generator, an
 *   unqualified table, a function body's keyword form) asks the warehouse for `current_path()` first, exactly once per
 *   account and warehouse in five minutes;
 * - the probe is the read path's own wrapped text, with `wait_timeout: 50` and `on_wait_timeout: CANCEL`;
 * - a path that keeps `system.builtin` before every user schema lets the read through; anything else is
 *   `PATH_NOT_DEFAULT`, naming the path;
 * - `current_date`, `current_timestamp` and `current_user` resolve before the path, so they need no probe;
 * - no answer, a failed probe or a non-string answer is `UNAVAILABLE`: the plugin cannot prove the path, so the read is
 *   not sent.
 */
import { describe, expect, it } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import { PATH_PROBE, PATH_TTL_MS, sessionToken } from "../../../src/guards/path.js"
import { prepareRead } from "../../../src/guards/read.js"
import type { ReadRequest, StatementAnswer } from "../../../src/ports.js"
import { analyzeRead } from "../../../src/sql/analyze.js"
import { harness, requestsSent, runningWarehouse, tableOf } from "../reads/harness.js"

const SIGNAL = new AbortController().signal
const request = (sql: string, extra: Partial<ReadRequest> = {}): ReadRequest => ({ account: "work", sql, tool: "query", sessionID: "ses_test", messageID: "msg_test", callID: "call_1", ...extra })

const PATH_SQL = "system.session,system.builtin,system.ai,main.default"
/** The probe's statement: what `analyzeRead` makes of `PATH_PROBE`, checked once. */
const PROBE_SENT = (() => {
  const probe = analyzeRead(PATH_PROBE)
  if (!probe.ok) throw new Error("the probe must parse")
  return probe.sent
})()

const answer = (path: string): StatementAnswer => ({
  statementId: "st-path",
  state: "SUCCEEDED",
  manifest: { columns: [{ name: "current_path()", typeName: "STRING", typeText: "STRING", position: 0 }], totalRowCount: 1 },
  rows: [[path]],
})

const answers = (path: string, submit: () => unknown = () => answer(path)) => ({ getTable: () => Promise.resolve(tableOf({ fullName: "main.s.t" })), submit })

async function code(sql: string, answersHere: Record<string, unknown> = answers(PATH_SQL)) {
  const h = harness({ answers: answersHere as never })
  try {
    const prepared = await prepareRead(h.deps, request(sql), SIGNAL)
    return { code: "OK", prepared, h }
  } catch (error) {
    if (error instanceof DatabricksError) return { code: error.code, error, h }
    throw error
  }
}

describe("the probe", () => {
  it("is the read path's wrapped text for current_path, qualified and backquoted as the lexer needs", () => {
    const probe = analyzeRead(PATH_PROBE)
    expect(probe.ok).toBe(true)
    expect(probe.ok && probe.sent).toBe("SELECT * FROM (\nSELECT system.builtin.`current_path`()\n) AS oc_q")
  })

  it("labels the session by a hash, never by its id", () => {
    expect(sessionToken("ses_test")).toMatch(/^[0-9a-f]{8}$/)
    expect(sessionToken("ses_test")).not.toContain("ses_test")
  })
})

describe("when the path is checked", () => {
  it.each([
    ["count(*)", "select count(*) from main.s.t"],
    ["BETWEEN", "select a from main.s.t where a between 1 and 2"],
    ["EXTRACT", "select extract(year from d) from main.s.t"],
    ["TRIM(BOTH … FROM …)", "select trim(both 'x' from s) from main.s.t"],
    ["a LATERAL VIEW generator", "select * from main.s.t lateral view explode(arr) v as c"],
  ])("%s asks current_path() once, before the statement", async (_what, sql) => {
    const result = await code(sql, { ...answers(PATH_SQL), getTable: () => Promise.resolve(tableOf({ fullName: "main.s.t" })) })
    expect(result.code).toBe("OK")
    const sent = requestsSent(result.h.databricks)
    expect(sent[0]?.statement).toBe(PROBE_SENT)
    expect(sent[0]).toMatchObject({ waitTimeout: 50, onWaitTimeout: "CANCEL", rowLimit: 1, disposition: "INLINE", format: "JSON_ARRAY" })
    expect((sent[0]?.queryTags as Record<string, string>).oc_tool).toBe("path-check")
  })

  it.each([
    ["a qualified table and a qualified call", "select upper(a) from main.s.t"],
    ["current_date, current_timestamp and current_user", "select current_date, current_timestamp, current_user from main.s.t"],
  ])("does not probe for %s", async (_what, sql) => {
    const result = await code(sql)
    expect(result.code).toBe("OK")
    expect(requestsSent(result.h.databricks)).toEqual([])
  })
})

describe("the verdict", () => {
  it("lets a default path through, and refuses one that puts a user schema first", async () => {
    expect((await code("select count(*) from main.s.t")).code).toBe("OK")
    const refused = await code("select count(*) from main.s.t", answers("main.evil,system.builtin,system.ai,main.default"))
    expect(refused.code).toBe("PATH_NOT_DEFAULT")
    expect(refused.error?.detail).toContain("main.evil")
    expect(requestsSent(refused.h.databricks)).toHaveLength(1)
    expect(refused.h.databricks.calls.filter((entry) => entry.method === "submit")[0]).toBeDefined()
  })

  it.each([
    ["a path without system.builtin", "system.session,system.ai,main.default"],
    ["a user schema before system.builtin", "main.other,system.builtin"],
    ["an empty path", ""],
  ])("refuses %s", async (_what, path) => {
    expect((await code("select count(*) from main.s.t", answers(path))).code).toBe("PATH_NOT_DEFAULT")
  })

  it("allows system.session before system.builtin: a statement sent alone has no temporary functions", async () => {
    expect((await code("select count(*) from main.s.t", answers("system.session,system.builtin,system.ai"))).code).toBe("OK")
  })

  it("fails closed when the probe fails or answers something that is not a path", async () => {
    const failed = await code("select count(*) from main.s.t", { getTable: () => Promise.resolve(tableOf({ fullName: "main.s.t" })), submit: () => Promise.reject(new DatabricksError("RATE_LIMITED")) })
    expect(failed.code).toBe("UNAVAILABLE")
    const notString = await code("select count(*) from main.s.t", answers(PATH_SQL, () => ({ statementId: "st", state: "SUCCEEDED", manifest: { columns: [] }, rows: [[null]] })))
    expect(notString.code).toBe("UNAVAILABLE")
    const cancelled = await code("select count(*) from main.s.t", answers(PATH_SQL, () => ({ statementId: "st", state: "CANCELED", manifest: { columns: [] } })))
    expect(cancelled.code).toBe("UNAVAILABLE")
  })
})

describe("the cache (design §5.4: five minutes, per account and warehouse)", () => {
  it("asks once for two reads inside five minutes, and again after them", async () => {
    const h = harness({ answers: answers(PATH_SQL) as never })
    await prepareRead(h.deps, request("select count(*) from main.s.t"), SIGNAL)
    await prepareRead(h.deps, request("select count(*) from main.s.t"), SIGNAL)
    expect(requestsSent(h.databricks)).toHaveLength(1)
    h.clock.advance(PATH_TTL_MS + 1)
    await prepareRead(h.deps, request("select count(*) from main.s.t"), SIGNAL)
    expect(requestsSent(h.databricks)).toHaveLength(2)
  })

  it("keeps one path per warehouse", async () => {
    const h = harness({
      answers: { getTable: () => Promise.resolve(tableOf({ fullName: "main.s.t" })), submit: () => answer(PATH_SQL), getWarehouse: (_account: unknown, id: unknown) => ({ ...(runningWarehouse() as object), id: String(id) }) } as never,
    })
    await prepareRead(h.deps, request("select count(*) from main.s.t"), SIGNAL)
    await prepareRead(h.deps, request("select count(*) from main.s.t", { warehouse: "wh-other" }), SIGNAL)
    expect(requestsSent(h.databricks)).toHaveLength(2)
  })
})

describe("a function body's keyword form", () => {
  it("an unqualified table name asks for the path too, once the call says which catalog and schema complete it", async () => {
    const h = harness({
      options: { accounts: { work: { warehouse: "wh-small", catalog: "main", schema: "default" } } },
      answers: { getTable: () => Promise.resolve(tableOf({ fullName: "main.default.t" })), submit: () => answer(PATH_SQL) } as never,
    })
    const prepared = await prepareRead(h.deps, request("select * from t"), SIGNAL)
    expect(prepared.tables).toEqual(["main.default.t"])
    expect(requestsSent(h.databricks)[0]?.statement).toBe(PROBE_SENT)
  })

  it("makes the read path-sensitive, so the path is checked even when the caller's own text is not", async () => {
    const result = await code("select main.s.year_of(d) from main.s.t", {
      getTable: () => Promise.resolve(tableOf({ fullName: "main.s.t" })),
      getFunction: () => Promise.resolve({ fullName: "main.s.year_of", routineBody: "SQL", routineDefinition: "extract(year from d)", isTableFunction: false }),
      submit: () => answer(PATH_SQL),
    })
    expect(result.code).toBe("OK")
    expect(requestsSent(result.h.databricks)).toHaveLength(1)
    expect((requestsSent(result.h.databricks)[0]?.queryTags as Record<string, string>).oc_tool).toBe("path-check")
  })
})
