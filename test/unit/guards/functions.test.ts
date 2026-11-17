/**
 * Design §15.1, the must-prove item for package C — **functions and dependencies** (design §5.4):
 *
 * - a view over a view that calls `http_request` → `NEEDS_PLAN`;
 * - a SQL UDF whose body calls `ai_query` → `NEEDS_PLAN`;
 * - a Python (or Scala) UDF, with and without a connection dependency → `NEEDS_PLAN` both times (live check L6);
 * - a SQL UDF whose body Unity Catalog does not return → `NEEDS_PLAN`;
 * - a view with no `view_dependencies` → the `DEPENDENCIES_UNKNOWN` warning, and a refusal under a fence or
 *   `strictDependencies`;
 * - a dependency chain deeper than `dependencyDepth` → `NEEDS_PLAN`;
 * - a function Unity Catalog does not return, and a `system.*` name that is not an allowlisted built-in, →
 *   `NEEDS_PLAN` (the fail-closed answer review `databricks-1.md`'s LOW 2 asks for);
 * - a view that depends on a connection or a credential → `NEEDS_PLAN`;
 * - a SQL UDF whose body passes → allowed, sent exactly as the caller wrote it;
 * - resolution cached for 5 minutes (design §5.4).
 */
import { describe, expect, it } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import { prepareRead } from "../../../src/guards/read.js"
import type { FunctionInfo, ReadRequest, TableInfo } from "../../../src/ports.js"
import { answerOf, harness, tableOf } from "../reads/harness.js"

const SIGNAL = new AbortController().signal
const request = (sql: string, extra: Partial<ReadRequest> = {}): ReadRequest => ({ account: "work", sql, tool: "query", sessionID: "ses_test", messageID: "msg_test", callID: "call_1", ...extra })

const managed = (fullName: string): TableInfo => tableOf({ fullName })

/** A `tables.get` answer from a map: a missing name answers NOT_FOUND, as Unity Catalog does. */
const tables = (map: Record<string, TableInfo>) => ({
  getTable: (_account: unknown, fullName: unknown) => {
    const found = map[String(fullName)]
    return found ? Promise.resolve(found) : Promise.reject(new DatabricksError("NOT_FOUND"))
  },
})

/** A `functions.get` answer from a map. */
const functions = (map: Record<string, FunctionInfo>) => ({
  getFunction: (_account: unknown, fullName: unknown) => {
    const found = map[String(fullName)]
    return found ? Promise.resolve(found) : Promise.reject(new DatabricksError("NOT_FOUND"))
  },
})

const sqlFunction = (fullName: string, definition: string, overrides: Partial<FunctionInfo> = {}): FunctionInfo => ({ fullName, routineBody: "SQL", routineDefinition: definition, isTableFunction: false, ...overrides })

async function code(sql: string, answers: Record<string, unknown>, options: Record<string, unknown> = {}) {
  const h = harness({ answers: { getWarehouse: () => running(), ...answers } as never, ...(Object.keys(options).length ? { options } : {}) })
  try {
    const prepared = await prepareRead(h.deps, request(sql), SIGNAL)
    return { code: "OK", prepared, h }
  } catch (error) {
    if (error instanceof DatabricksError) {
      // A path-sensitive read may reach the current_path probe. These tests answer it with the default path.
      return { code: error.code, error, h }
    }
    throw error
  }
}

const running = () => ({ id: "wh-small", name: "bi-small", state: "RUNNING", warehouseType: "PRO", serverless: true, clusterSize: "Small", autoStopMins: 10, minNumClusters: 1, maxNumClusters: 1 })

describe("views", () => {
  it("a view over a view that calls http_request is NEEDS_PLAN", async () => {
    const result = await code("select * from main.s.outer_view", {
      ...tables({
        "main.s.outer_view": { ...managed("main.s.outer_view"), tableType: "VIEW", viewDefinition: "SELECT * FROM main.s.middle_view", viewDependencies: [{ kind: "table", name: "main.s.middle_view" }] },
        "main.s.middle_view": { ...managed("main.s.middle_view"), tableType: "VIEW", viewDefinition: "SELECT * FROM main.s.inner_view", viewDependencies: [{ kind: "table", name: "main.s.inner_view" }] },
        "main.s.inner_view": { ...managed("main.s.inner_view"), tableType: "VIEW", viewDefinition: "SELECT http_request(conn => 'c', method => 'GET', path => '/') AS r", viewDependencies: [] },
      }),
    })
    expect(result.code).toBe("NEEDS_PLAN")
    expect(result.h.databricks.calls.filter((entry) => entry.method === "submit")).toEqual([])
  })

  it("a view whose dependencies are absent warns DEPENDENCIES_UNKNOWN, and is refused under a fence or strictDependencies", async () => {
    const noDependencies = { ...managed("main.s.v"), tableType: "VIEW", viewDefinition: "SELECT 1 AS a" }
    const warned = await code("select * from main.s.v", { ...tables({ "main.s.v": noDependencies }) })
    expect(warned.code).toBe("OK")
    expect(warned.prepared?.warnings.map((warning) => warning.code)).toContain("DEPENDENCIES_UNKNOWN")

    const fenced = await code("select * from main.s.v", { ...tables({ "main.s.v": noDependencies }) }, { accounts: { work: { warehouse: "wh-small", fence: { allow: ["main.s.*"] } } } })
    expect(fenced.code).toBe("DEPENDENCIES_UNKNOWN")

    const strict = await code("select * from main.s.v", { ...tables({ "main.s.v": noDependencies }) }, { strictDependencies: true })
    expect(strict.code).toBe("DEPENDENCIES_UNKNOWN")
  })

  it("a view whose body is not returned warns VIEW_BODY_UNREAD", async () => {
    const result = await code("select * from main.s.v", { ...tables({ "main.s.v": { ...managed("main.s.v"), tableType: "VIEW", viewDependencies: [] } }) })
    expect(result.code).toBe("OK")
    expect(result.prepared?.warnings.map((warning) => warning.code)).toContain("VIEW_BODY_UNREAD")
  })

  it("a view that depends on a connection or a credential is NEEDS_PLAN", async () => {
    const connection = await code("select * from main.s.v", {
      ...tables({ "main.s.v": { ...managed("main.s.v"), tableType: "VIEW", viewDefinition: "SELECT 1 AS a", viewDependencies: [{ kind: "connection", name: "pg" }] } }),
    })
    expect(connection.code).toBe("NEEDS_PLAN")
    const credential = await code("select * from main.s.v", {
      ...tables({ "main.s.v": { ...managed("main.s.v"), tableType: "VIEW", viewDefinition: "SELECT 1 AS a", viewDependencies: [{ kind: "credential", name: "cred" }] } }),
    })
    expect(credential.code).toBe("NEEDS_PLAN")
  })

  it("a view whose recorded dependency is a Python table function is NEEDS_PLAN", async () => {
    const result = await code("select * from main.s.v", {
      ...tables({ "main.s.v": { ...managed("main.s.v"), tableType: "VIEW", viewDefinition: "SELECT * FROM main.s.py_udtf(1)", viewDependencies: [{ kind: "function", name: "main.s.py_udtf" }] } }),
      ...functions({ "main.s.py_udtf": { fullName: "main.s.py_udtf", routineBody: "EXTERNAL", externalLanguage: "PYTHON", isTableFunction: true } }),
    })
    expect(result.code).toBe("NEEDS_PLAN")
  })

  it("a view chain deeper than dependencyDepth is NEEDS_PLAN", async () => {
    const chain: Record<string, TableInfo> = {}
    for (let index = 0; index < 6; index++) {
      chain[`main.s.v${index}`] = { ...managed(`main.s.v${index}`), tableType: "VIEW", viewDefinition: `SELECT * FROM main.s.v${index + 1}`, viewDependencies: [{ kind: "table", name: `main.s.v${index + 1}` }] }
    }
    chain["main.s.v6"] = managed("main.s.v6")
    const result = await code("select * from main.s.v0", { ...tables(chain) })
    expect(result.code).toBe("NEEDS_PLAN")
  })
})

describe("functions", () => {
  it("a SQL UDF that calls ai_query is NEEDS_PLAN", async () => {
    const result = await code("select main.s.asks(a) from main.s.t", {
      ...tables({ "main.s.t": managed("main.s.t") }),
      ...functions({ "main.s.asks": sqlFunction("main.s.asks", "ai_query('endpoint', a)") }),
    })
    expect(result.code).toBe("NEEDS_PLAN")
  })

  it.each([
    ["without a dependency", {}],
    ["with a connection dependency", { routineDependencies: [{ kind: "connection" as const, name: "pg" }] }],
  ])("a Python UDF %s is NEEDS_PLAN (live check L6)", async (_what, overrides) => {
    const result = await code("select main.s.pya(a) from main.s.t", {
      ...tables({ "main.s.t": managed("main.s.t") }),
      ...functions({ "main.s.pya": { fullName: "main.s.pya", routineBody: "EXTERNAL", externalLanguage: "PYTHON", isTableFunction: false, ...overrides } }),
    })
    expect(result.code).toBe("NEEDS_PLAN")
  })

  it("a SQL UDF whose body is not returned is NEEDS_PLAN", async () => {
    const result = await code("select main.s.nobody(a) from main.s.t", {
      ...tables({ "main.s.t": managed("main.s.t") }),
      ...functions({ "main.s.nobody": { fullName: "main.s.nobody", routineBody: "SQL", isTableFunction: false } }),
    })
    expect(result.code).toBe("NEEDS_PLAN")
  })

  it("a function Unity Catalog does not return is NEEDS_PLAN, not a bypass", async () => {
    const result = await code("select main.s.vanished(a) from main.s.t", { ...tables({ "main.s.t": managed("main.s.t") }) })
    expect(result.code).toBe("NEEDS_PLAN")
    expect(result.error?.detail).toContain("does not return the function")
  })

  it("a system.* name outside the allowlist is NEEDS_PLAN, never a Unity Catalog lookup", async () => {
    for (const sql of ["select system.builtin.newfn(1)", "select system.other.fn(1)", "select system.ai.python_exec('x')"]) {
      const result = await code(sql, {})
      expect(result.code, sql).toBe("NEEDS_PLAN")
    }
  })

  it("a SQL UDF whose body passes is allowed, and the call is sent as written", async () => {
    const result = await code("select main.s.plusone(a) from main.s.t", {
      ...tables({ "main.s.t": managed("main.s.t") }),
      ...functions({ "main.s.plusone": sqlFunction("main.s.plusone", "a + 1") }),
    })
    expect(result.code).toBe("OK")
    expect(result.prepared?.sent).toContain("main.s.plusone(a)")
  })

  it("a SQL UDF whose body holds a one-part call is NEEDS_PLAN", async () => {
    const result = await code("select main.s.partial(a) from main.s.t", {
      ...tables({ "main.s.t": managed("main.s.t") }),
      ...functions({ "main.s.partial": sqlFunction("main.s.partial", "myfn(a)") }),
    })
    expect(result.code).toBe("NEEDS_PLAN")
  })

  it("a SQL UDF whose body calls a secret function refuses the read", async () => {
    const result = await code("select main.s.peek(a) from main.s.t", {
      ...tables({ "main.s.t": managed("main.s.t") }),
      ...functions({ "main.s.peek": sqlFunction("main.s.peek", "secret('scope', 'key')") }),
    })
    expect(result.code).toBe("SECRET_FUNCTION_REFUSED")
  })

  it("resolution is cached for five minutes, per account", async () => {
    const answers = { ...tables({ "main.s.t": managed("main.s.t") }) }
    const h = harness({ answers })
    await prepareRead(h.deps, request("select * from main.s.t"), SIGNAL)
    await prepareRead(h.deps, request("select * from main.s.t"), SIGNAL)
    expect(h.databricks.calls.filter((entry) => entry.method === "getTable")).toHaveLength(1)
    h.clock.advance(5 * 60_000 + 1)
    await prepareRead(h.deps, request("select * from main.s.t"), SIGNAL)
    expect(h.databricks.calls.filter((entry) => entry.method === "getTable")).toHaveLength(2)
  })

  it("a one- or two-part table name is completed from the call's catalog and schema, and refused without them", async () => {
    const withCatalog = await code("select * from t", { ...tables({ "main.default.t": managed("main.default.t") }) }, { accounts: { work: { warehouse: "wh-small", catalog: "main", schema: "default" } } })
    expect(withCatalog.code).toBe("OK")
    expect(withCatalog.prepared?.tables).toEqual(["main.default.t"])
    const without = await code("select * from t", {})
    expect(without.code).toBe("NOT_FOUND")
  })

  it("a table Unity Catalog does not return is NOT_FOUND, and nothing is sent", async () => {
    const result = await code("select * from main.s.missing", { ...tables({}) })
    expect(result.code).toBe("NOT_FOUND")
    expect(result.h.databricks.calls.filter((entry) => entry.method === "submit")).toEqual([])
  })

  it("two accounts do not share resolution: the cache key names the account", async () => {
    const h = harness({
      answers: { ...tables({ "main.s.t": managed("main.s.t") }), getWarehouse: () => running(), submit: () => answerOf() },
      auth: new (await import("../../fake/ports.js")).FakeAuth([
        { alias: "work", mode: "interactive", host: "https://fake-workspace.cloud.databricks.com", cloud: "aws", features: [], warehouse: "wh-small" },
        { alias: "home", mode: "interactive", host: "https://fake-workspace.cloud.databricks.com", cloud: "aws", features: [], warehouse: "wh-small" },
      ]),
    })
    await prepareRead(h.deps, request("select * from main.s.t", { account: "work" }), SIGNAL)
    await prepareRead(h.deps, request("select * from main.s.t", { account: "home" }), SIGNAL)
    expect(h.databricks.calls.filter((entry) => entry.method === "getTable").map((entry) => entry.args[0])).toEqual(["work", "home"])
  })
})
