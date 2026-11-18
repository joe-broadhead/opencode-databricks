// The snapshot source (design §11.3), its bind-time `saved_list`, and `probe` (design §11.4): the changed-SQL refusal,
// the stopped warehouse, the table's caps, the sha256 the bind shows, and the probe's owner and account.
import { createHash } from "node:crypto"
import { describe, expect, test } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import { probe } from "../../../src/sources/probe.js"
import { savedList, savedRead } from "../../../src/sources/saved.js"
import { depsFor, call } from "./harness.js"
import { fakeRest, ME } from "./fake-rest.js"

const QUERY = { id: "be6df0a0-c317-44df-9659-b4f206c5d027", name: "Revenue by region", queryText: "SELECT * FROM main.sales.orders", warehouseId: "wh-small", owner: "sam.rivera@example.com" }
const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const open = { assert: async () => undefined } as never

describe("databricks.saved", () => {
  test("reads the query's table, at most 8 columns and 100 rows, with the registry's columns and rows", async () => {
    const snapshot = await savedRead(depsFor(fakeRest({ saved: [QUERY] }), open), { account: "work", query: QUERY.id, sha: sha(QUERY.queryText) }, call("s1"))
    expect(snapshot.data.columns).toEqual([{ key: "region", label: "region" }, { key: "revenue", label: "revenue" }])
    expect(snapshot.data.rows).toEqual([
      { region: "North", revenue: "120.50" },
      { region: "South", revenue: "98.25" },
    ])
    expect(snapshot.trust).toBe("untrusted")
  })

  test("refuses a query whose SQL changed since it was chosen", async () => {
    const deps = depsFor(fakeRest({ saved: [QUERY] }), open)
    await expect(savedRead(deps, { account: "work", query: QUERY.id, sha: sha("SELECT 1") }, call())).rejects.toMatchObject({ code: "INPUT_INVALID" })
    await expect(savedRead(deps, { account: "work", query: QUERY.id, sha: sha("SELECT 1") }, call())).rejects.toThrow(/changed since you chose it/u)
  })

  test("never starts a warehouse: a stopped one is UNAVAILABLE, before any statement", async () => {
    const rest = fakeRest({ saved: [QUERY] })
    rest.answers.getWarehouse = () => ({ id: "wh-small", name: "small", state: "STOPPED", warehouseType: "PRO", serverless: true, clusterSize: "Small", autoStopMins: 10, minNumClusters: 1, maxNumClusters: 1 })
    const deps = depsFor(rest, open)
    await expect(savedRead(deps, { account: "work", query: QUERY.id, sha: sha(QUERY.queryText) }, call())).rejects.toMatchObject({ code: "UNAVAILABLE" })
    expect(rest.calls.some((entry) => entry.method === "submit")).toBe(false)
  })

  test("more than 8 columns or 100 rows is TOO_LARGE, never a silent cut", async () => {
    const rest = fakeRest({ saved: [QUERY] })
    rest.answers.submit = () => ({
      statementId: "st-big",
      state: "SUCCEEDED",
      manifest: { columns: Array.from({ length: 9 }, (_, index) => ({ name: `c${index}`, typeName: "STRING", typeText: "STRING", position: index })), totalRowCount: 1 },
      rows: [Array.from({ length: 9 }, () => "x")],
    })
    await expect(savedRead(depsFor(rest, open), { account: "work", query: QUERY.id, sha: sha(QUERY.queryText) }, call())).rejects.toMatchObject({ code: "TOO_LARGE" })
    rest.answers.submit = () => ({
      statementId: "st-big",
      state: "SUCCEEDED",
      manifest: { columns: [{ name: "c", typeName: "STRING", typeText: "STRING", position: 0 }], totalRowCount: 101 },
      rows: [["x"]],
    })
    await expect(savedRead(depsFor(rest, open), { account: "work", query: QUERY.id, sha: sha(QUERY.queryText) }, call())).rejects.toMatchObject({ code: "TOO_LARGE" })
  })

  test("saved_list offers the query with its SQL and sha256, under the bind session's grants", async () => {
    const deps = depsFor(fakeRest({ saved: [QUERY] }), open)
    const list = await savedList(deps, { account: "work" }, call())
    expect(list.options).toEqual([expect.objectContaining({ id: QUERY.id, label: QUERY.name, sql: QUERY.queryText, sha: sha(QUERY.queryText), warehouse: "wh-small" })])
  })
})

describe("probe", () => {
  test("names the signed-in owner with a scheme-qualified id and reads no content", async () => {
    const result = await probe(depsFor(fakeRest(), open), { source: "databricks.queries", account: "work" }, call())
    expect(result).toEqual({ source: "queries", account: "work", owner: { id: `mailto:${ME.userName}`, label: ME.displayName }, trust: "untrusted" })
    expect(result).not.toHaveProperty("events")
    expect(result.owner).not.toHaveProperty("verified")
  })

  test("refuses an account the plugin is not signed in to", async () => {
    await expect(probe(depsFor(fakeRest(), open), { source: "queries", account: "elsewhere" }, call())).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" })
  })

  test("a missing account is the family's error result, not a silent first account", async () => {
    const result = (await probe(depsFor(fakeRest(), open), {}, call())) as unknown as { state: string; error: string }
    expect(result.state).toBe("refused")
    expect(result.error).toBe("INPUT_INVALID")
  })

  test("an unknown source and an extra field are INPUT_INVALID", async () => {
    await expect(probe(depsFor(fakeRest(), open), { source: "databricks.likes", account: "work" }, call())).rejects.toMatchObject({ code: "SOURCE_UNKNOWN" })
    await expect(probe(depsFor(fakeRest(), open), { source: "queries", account: "work", scope: {} }, call())).rejects.toMatchObject({ code: "INPUT_INVALID" })
    await expect(probe(depsFor(fakeRest(), open), { source: "queries", account: "work" }, call())).resolves.toBeDefined()
    expect(new DatabricksError("NOT_FOUND").code).toBe("NOT_FOUND")
  })
})
