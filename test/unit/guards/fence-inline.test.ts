/**
 * Design §5.6 and §5.7, package C's must-prove "fence and inline rules":
 *
 * - `accounts.<a>.fence.deny` refuses a resolved table (`FENCED`, naming the table and the person's pattern), `allow`
 *   refuses a table it does not match, and deny wins over allow;
 * - a table a **view** selects from is fenced too, because the fence sees every table the read resolved;
 * - a path read (`delta.<path>`) cannot be checked, so a set fence refuses it (`FENCE_UNVERIFIABLE`) and no fence leaves
 *   it alone (design §5.4);
 * - `inline.deny` withholds inline rows by **source table** (`INLINE_WITHHELD`), and the `databricks_save` route is
 *   untouched — it returns a file, not cells;
 * - `inlinePii: "save-only"` withholds every inline result; `inline.piiTags` cannot be evaluated by this version's port,
 *   so it fails closed (`DEPENDENCIES_UNKNOWN`);
 * - `databricks_explain` returns no cells, so no inline rule applies to it;
 * - every refusal happens before a statement is sent, and before a warehouse is started.
 */
import { describe, expect, it } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import { prepareRead } from "../../../src/guards/read.js"
import { firstMatch, matchesAny, patternMatches, quoted, safeText } from "../../../src/guards/pattern.js"
import type { ReadRequest, TableInfo } from "../../../src/ports.js"
import { harness, statementsSent, tableOf } from "../reads/harness.js"

const SIGNAL = new AbortController().signal
const request = (sql: string, extra: Partial<ReadRequest> = {}): ReadRequest => ({ account: "work", sql, tool: "query", sessionID: "ses_test", messageID: "msg_test", callID: "call_1", ...extra })

const answersFor = (names: readonly string[], overrides: Record<string, Partial<TableInfo>> = {}) => ({
  getTable: (_account: unknown, fullName: unknown) => {
    const name = String(fullName)
    if (!names.includes(name) && !Object.hasOwn(overrides, name)) return Promise.reject(new DatabricksError("NOT_FOUND"))
    return Promise.resolve(tableOf({ fullName: name, ...(overrides[name] ?? {}) }))
  },
})

async function code(sql: string, options: Record<string, unknown>, answers: Record<string, unknown> = {}, extra: Partial<ReadRequest> = {}) {
  const h = harness({ options, answers: answers as never })
  try {
    const prepared = await prepareRead(h.deps, request(sql, extra), SIGNAL)
    return { code: "OK", prepared, h }
  } catch (error) {
    if (error instanceof DatabricksError) return { code: error.code, error, h }
    throw error
  }
}

describe("patterns", () => {
  it("match the whole dotted name, case-insensitively, with * standing for any run of characters", () => {
    expect(patternMatches("*.hr.*", "main.hr.orders")).toBe(true)
    expect(patternMatches("*.hr.*", "MAIN.HR.SALARIES")).toBe(true)
    expect(patternMatches("*.hr.*", "main.hrx.orders")).toBe(false)
    expect(patternMatches("main.sales.*", "main.sales.orders")).toBe(true)
    expect(patternMatches("main.sales", "main.sales.orders")).toBe(false)
    expect(patternMatches("main.s.*.orders", "main.s.x.orders")).toBe(true)
    expect(matchesAny(undefined, "main.s.t")).toBe(false)
    expect(firstMatch(["a.*", "*.hr.*"], "main.hr.t")).toBe("*.hr.*")
  })

  it("make Databricks text safe for the plugin's own words: no control characters, 120 characters at most", () => {
    expect(safeText("a\nb\tc")).toBe("a b c")
    expect(safeText("x".repeat(200))).toHaveLength(121)
    expect(quoted("a`b")).toBe("`a``b`")
  })
})

describe("the fence", () => {
  const deny = { accounts: { work: { warehouse: "wh-small", fence: { deny: ["*.hr.*"] } } } }

  it("refuses a resolved table that matches deny, naming the table and the pattern, before any statement", async () => {
    const result = await code("select * from main.hr.salaries", deny, answersFor(["main.hr.salaries"]))
    expect(result.code).toBe("FENCED")
    expect(result.error?.detail).toContain("main.hr.salaries")
    expect(result.error?.detail).toContain("*.hr.*")
    expect(statementsSent(result.h.databricks)).toEqual([])
  })

  it("refuses a table the allow list does not cover, and lets deny win over allow", async () => {
    const allowOnly = { accounts: { work: { warehouse: "wh-small", fence: { allow: ["main.sales.*"] } } } }
    const refused = await code("select * from main.other.t", allowOnly, answersFor(["main.other.t"]))
    expect(refused.code).toBe("FENCED")
    const both = { accounts: { work: { warehouse: "wh-small", fence: { allow: ["main.*.*"], deny: ["main.hr.*"] } } } }
    expect((await code("select * from main.hr.t", both, answersFor(["main.hr.t"]))).code).toBe("FENCED")
    expect((await code("select * from main.sales.t", both, answersFor(["main.sales.t"]))).code).toBe("OK")
  })

  it("fences a table a view selects from, even when the caller never names it", async () => {
    const result = await code(
      "select * from main.sales.view",
      deny,
      answersFor(["main.sales.view", "main.hr.people"], {
        "main.sales.view": { tableType: "VIEW", viewDefinition: "SELECT id FROM main.hr.people", viewDependencies: [{ kind: "table", name: "main.hr.people" }] },
      }),
    )
    expect(result.code).toBe("FENCED")
    expect(result.error?.detail).toContain("main.hr.people")
  })

  it("refuses a path read it cannot check (FENCE_UNVERIFIABLE), and leaves one alone without a fence", async () => {
    expect((await code("select * from delta.`/Volumes/x/y`", deny)).code).toBe("FENCE_UNVERIFIABLE")
    const open = await code("select * from delta.`/Volumes/x/y`", { accounts: { work: { warehouse: "wh-small" } } })
    expect(open.code).toBe("OK")
    expect(open.prepared?.sent).toContain("delta.`/Volumes/x/y`")
  })

  it("does not stand in for the warehouse policy: a fenced read never starts a warehouse", async () => {
    const result = await code("select * from main.hr.salaries", deny, {
      ...answersFor(["main.hr.salaries"]),
      getWarehouse: () => ({ id: "wh-small", name: "bi-small", state: "STOPPED", warehouseType: "PRO", serverless: true, clusterSize: "Small", autoStopMins: 10, minNumClusters: 1, maxNumClusters: 1 }),
    })
    expect(result.code).toBe("FENCED")
    expect(result.h.databricks.calls.map((entry) => entry.method)).not.toContain("startWarehouse")
  })
})

describe("the inline rules", () => {
  const inlineDeny = { accounts: { work: { warehouse: "wh-small", inline: { deny: ["main.hr.*"] } } } }

  it("withholds inline rows for a source table that matches inline.deny, and leaves databricks_save alone", async () => {
    const query = await code("select * from main.hr.people", inlineDeny, answersFor(["main.hr.people"]))
    expect(query.code).toBe("INLINE_WITHHELD")
    expect(query.error?.detail).toContain("inline.deny")
    expect(query.error?.nextStep).toContain("databricks_save")
    expect(statementsSent(query.h.databricks)).toEqual([])
    const save = await code("select * from main.hr.people", inlineDeny, answersFor(["main.hr.people"]), { tool: "save" })
    expect(save.code).toBe("OK")
  })

  it("withholds every inline result under inlinePii: save-only, and still allows save and explain", async () => {
    const options = { inlinePii: "save-only", accounts: { work: { warehouse: "wh-small" } } }
    const query = await code("select * from main.s.t", options, answersFor(["main.s.t"]))
    expect(query.code).toBe("INLINE_WITHHELD")
    expect(query.error?.detail).toContain("save-only")
    expect((await code("select * from main.s.t", options, answersFor(["main.s.t"]), { tool: "save" })).code).toBe("OK")
    expect((await code("select * from main.s.t", options, answersFor(["main.s.t"]), { tool: "explain" })).code).toBe("OK")
  })

  it("cannot evaluate inline.piiTags without a tag read, so it fails closed", async () => {
    const options = { accounts: { work: { warehouse: "wh-small", inline: { piiTags: ["pii", "class.*"] } } } }
    const result = await code("select * from main.s.t", options, answersFor(["main.s.t"]))
    expect(result.code).toBe("DEPENDENCIES_UNKNOWN")
    expect(result.error?.detail).toContain("tag assignments")
    expect(statementsSent(result.h.databricks)).toEqual([])
  })

  it("does not withhold anything when no inline rule is configured", async () => {
    const result = await code("select * from main.s.t", { accounts: { work: { warehouse: "wh-small" } } }, answersFor(["main.s.t"]))
    expect(result.code).toBe("OK")
    expect(result.prepared?.warnings).toEqual([])
  })
})
