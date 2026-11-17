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

  it("a view with no recorded dependencies is read from its body alone, and refuses when a body name cannot be reconciled", async () => {
    // Nothing to record, nothing to hide: the body is the whole union, and `SELECT 1 AS a` reads nothing.
    const empty = await code("select * from main.s.v", { ...tables({ "main.s.v": { ...managed("main.s.v"), tableType: "VIEW", viewDefinition: "SELECT 1 AS a" } }) })
    expect(empty.code).toBe("OK")
    expect(empty.prepared?.warnings).toEqual([])
    // A body name neither the record nor the view's own schema can pin is a plan, not a warning (review delta check).
    const unreconciled = await code("select * from main.s.v", { ...tables({ "main.s.v": { ...managed("main.s.v"), tableType: "VIEW", viewDefinition: "SELECT * FROM salaries" } }) })
    expect(unreconciled.code).toBe("NEEDS_PLAN")
  })

  it("refuses a view whose body is not returned: the recorded list alone never allows a read", async () => {
    const result = await code("select * from main.s.v", { ...tables({ "main.s.v": { ...managed("main.s.v"), tableType: "VIEW", viewDependencies: [] } }) })
    expect(result.code).toBe("NEEDS_PLAN")
    const withDeps = await code("select * from main.s.v", {
      ...tables({ "main.s.v": { ...managed("main.s.v"), tableType: "VIEW", viewDependencies: [{ kind: "table", name: "main.s.t" }] }, "main.s.t": managed("main.s.t") }),
    })
    expect(withDeps.code).toBe("NEEDS_PLAN")
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
        { alias: "work", mode: "interactive", host: "https://fake-workspace.cloud.databricks.com", cloud: "aws", features: [], warehouse: "wh-small", enforcement: "identity" },
        { alias: "home", mode: "interactive", host: "https://fake-workspace.cloud.databricks.com", cloud: "aws", features: [], warehouse: "wh-small", enforcement: "identity" },
      ]),
    })
    await prepareRead(h.deps, request("select * from main.s.t", { account: "work" }), SIGNAL)
    await prepareRead(h.deps, request("select * from main.s.t", { account: "home" }), SIGNAL)
    expect(h.databricks.calls.filter((entry) => entry.method === "getTable").map((entry) => entry.args[0])).toEqual(["work", "home"])
  })
})

describe("M1: a function's names resolve in the function's own context", () => {
  it("refuses a SQL wrapper whose body calls a name Unity Catalog records as a Python UDF", async () => {
    // The review's probe: `upper(x)` in the body, recorded as depending on `workspace.default.upper`, a Python UDF. The
    // plugin must never let a SQL wrapper launder a Python UDF into a read.
    const result = await code("select workspace.default.wrap(a) from main.s.t", {
      ...tables({ "main.s.t": managed("main.s.t") }),
      ...functions({
        "workspace.default.wrap": sqlFunction("workspace.default.wrap", "upper(a)", { routineDependencies: [{ kind: "function", name: "workspace.default.upper" }] }),
        "workspace.default.upper": { fullName: "workspace.default.upper", routineBody: "EXTERNAL", externalLanguage: "PYTHON", isTableFunction: false },
      }),
    })
    expect(result.code).toBe("NEEDS_PLAN")
    expect(result.h.databricks.calls.filter((entry) => entry.method === "submit")).toEqual([])
  })

  it("fences the table a function's recorded dependencies name, even when the body only says `salaries`", async () => {
    const result = await code(
      "select main.public.wrap(a) from main.public.orders",
      {
        ...tables({ "main.public.orders": managed("main.public.orders"), "main.hr.salaries": managed("main.hr.salaries") }),
        ...functions({ "main.public.wrap": sqlFunction("main.public.wrap", "salaries", { routineDependencies: [{ kind: "table", name: "main.hr.salaries" }] }) }),
      },
      { accounts: { work: { warehouse: "wh-small", fence: { deny: ["*.hr.*"] } } } },
    )
    // `salaries` alone is never resolved (the caller's schema is not where the function was created); the recorded
    // dependency is, and the fence refuses it.
    expect(result.code).toBe("FENCED")
  })

  it("needs the path captured at CREATE FUNCTION when the body resolves a name, and refuses when it is absent", async () => {
    const body = { ...tables({ "main.s.t": managed("main.s.t") }), ...functions({ "main.s.wrap": sqlFunction("main.s.wrap", "upper(a)") }) }
    expect((await code("select main.s.wrap(a) from main.s.t", body)).code).toBe("NEEDS_PLAN")
    const safe = await code("select main.s.wrap(a) from main.s.t", {
      ...tables({ "main.s.t": managed("main.s.t") }),
      ...functions({ "main.s.wrap": sqlFunction("main.s.wrap", "upper(a)", { sqlPath: "system.session,system.builtin,system.ai,main.s" }) }),
    })
    expect(safe.code).toBe("OK")
    const unsafe = await code("select main.s.wrap(a) from main.s.t", {
      ...tables({ "main.s.t": managed("main.s.t") }),
      ...functions({ "main.s.wrap": sqlFunction("main.s.wrap", "upper(a)", { sqlPath: "main.s,system.builtin" }) }),
    })
    expect(unsafe.code).toBe("NEEDS_PLAN")
  })

  it("lets a body of constants and parameters through without a path: nothing in it resolves by name", async () => {
    const result = await code("select main.s.plusone(a) from main.s.t", {
      ...tables({ "main.s.t": managed("main.s.t") }),
      ...functions({ "main.s.plusone": sqlFunction("main.s.plusone", "a + 1") }),
    })
    expect(result.code).toBe("OK")
  })
})

describe("M2: a view's tables and functions come from its recorded dependencies", () => {
  it("reads a view whose body uses an unqualified name, completing it from the view's own schema", async () => {
    // The review's probe 1: `main.hr.v` selects `salaries`, recorded as depending on `main.hr.salaries`, read by a call
    // whose own schema is `public`. The body's name must not be completed from the caller's.
    const result = await code(
      "select * from main.hr.v",
      {
        ...tables({
          "main.hr.v": { ...managed("main.hr.v"), tableType: "VIEW", viewDefinition: "SELECT * FROM salaries", viewDependencies: [{ kind: "table", name: "main.hr.salaries" }] },
          "main.hr.salaries": managed("main.hr.salaries"),
          "main.public.salaries": managed("main.public.salaries"),
        }),
      },
      { accounts: { work: { warehouse: "wh-small", catalog: "main", schema: "public" } } },
    )
    expect(result.code).toBe("OK")
    expect(result.prepared?.tables).toEqual(["main.hr.v", "main.hr.salaries"])
  })

  it("reads a body's name in the view's own context when nothing is recorded, not the caller's", async () => {
    // No recorded dependency: `salaries` means what it meant where the view lives, `main.hr`, never the caller's `public`.
    const result = await code(
      "select * from main.hr.v",
      {
        ...tables({
          "main.hr.v": { ...managed("main.hr.v"), tableType: "VIEW", viewDefinition: "SELECT * FROM salaries" },
          "main.hr.salaries": managed("main.hr.salaries"),
          "main.public.salaries": managed("main.public.salaries"),
        }),
      },
      { accounts: { work: { warehouse: "wh-small", catalog: "main", schema: "public" } } },
    )
    expect(result.code).toBe("OK")
    expect(result.prepared?.tables).toEqual(["main.hr.v", "main.hr.salaries"])
  })

  it("accepts a view that calls an unqualified Unity Catalog function its dependencies name in full", async () => {
    const result = await code("select * from main.s.v", {
      ...tables({
        "main.s.v": { ...managed("main.s.v"), tableType: "VIEW", viewDefinition: "SELECT year_of(d) AS y FROM main.s.t", viewDependencies: [{ kind: "table", name: "main.s.t" }, { kind: "function", name: "main.s.year_of" }] },
        "main.s.t": managed("main.s.t"),
      }),
      ...functions({ "main.s.year_of": sqlFunction("main.s.year_of", "year(d)", { sqlPath: "system.session,system.builtin,system.ai,main.s" }) }),
    })
    expect(result.code).toBe("OK")
    expect(result.prepared?.tables).toEqual(["main.s.v", "main.s.t"])
  })

  it("still refuses a body that calls an excluded built-in, whatever its dependencies say", async () => {
    const result = await code("select * from main.s.v", {
      ...tables({
        "main.s.v": { ...managed("main.s.v"), tableType: "VIEW", viewDefinition: "SELECT http_request(conn => 'c') AS r", viewDependencies: [] },
      }),
    })
    expect(result.code).toBe("NEEDS_PLAN")
  })
})

describe("the delta check: the dependency set is the union, never the recorded list alone", () => {
  it("refuses a function with empty routine_dependencies whose body calls python_exec", async () => {
    // The review's probe: an empty recorded list must not hide the body's Python call.
    const result = await code("select main.s.sneaky(a) from main.s.t", {
      ...tables({ "main.s.t": managed("main.s.t") }),
      ...functions({ "main.s.sneaky": sqlFunction("main.s.sneaky", "python_exec(a)", { sqlPath: "system.session,system.builtin,system.ai,main.s" }) }),
    })
    expect(result.code).toBe("NEEDS_PLAN")
    expect(result.error?.detail).toContain("python_exec")
  })

  it("refuses a function whose recorded list omits a Python function its body calls in full", async () => {
    const result = await code("select main.s.sneaky(a) from main.s.t", {
      ...tables({ "main.s.t": managed("main.s.t") }),
      ...functions({
        "main.s.sneaky": sqlFunction("main.s.sneaky", "main.s.py_udf(a)", { sqlPath: "system.session,system.builtin,system.ai,main.s" }),
        "main.s.py_udf": { fullName: "main.s.py_udf", routineBody: "EXTERNAL", externalLanguage: "PYTHON", isTableFunction: false },
      }),
    })
    expect(result.code).toBe("NEEDS_PLAN")
  })

  it.each([
    ["in full", "SELECT main.s.py_udf(a) AS r FROM main.s.t"],
    ["unqualified", "SELECT py_udf(a) AS r FROM main.s.t"],
  ])("refuses a view hiding a Python call %s with no recorded dependencies", async (_what, definition) => {
    const result = await code("select * from main.s.v", {
      ...tables({ "main.s.v": { ...managed("main.s.v"), tableType: "VIEW", viewDefinition: definition }, "main.s.t": managed("main.s.t") }),
      ...functions({ "main.s.py_udf": { fullName: "main.s.py_udf", routineBody: "EXTERNAL", externalLanguage: "PYTHON", isTableFunction: false } }),
    })
    expect(result.code).toBe("NEEDS_PLAN")
  })

  it("fences a table a view hides from its recorded dependencies", async () => {
    // The record names `main.s.t`; the body also reads `main.hr.salaries`. The union sees both, and the fence refuses.
    const result = await code(
      "select * from main.s.v",
      {
        ...tables({
          "main.s.v": { ...managed("main.s.v"), tableType: "VIEW", viewDefinition: "SELECT a FROM main.s.t UNION ALL SELECT a FROM main.hr.salaries", viewDependencies: [{ kind: "table", name: "main.s.t" }] },
          "main.s.t": managed("main.s.t"),
          "main.hr.salaries": managed("main.hr.salaries"),
        }),
      },
      { accounts: { work: { warehouse: "wh-small", fence: { deny: ["*.hr.*"] } } } },
    )
    expect(result.code).toBe("FENCED")
    expect(result.error?.detail).toContain("main.hr.salaries")
  })

  it("adds the body's tables to the asserted and fenced set, not just the recorded ones", async () => {
    const result = await code("select * from main.s.v", {
      ...tables({
        "main.s.v": { ...managed("main.s.v"), tableType: "VIEW", viewDefinition: "SELECT a FROM main.s.t UNION ALL SELECT a FROM main.s.other", viewDependencies: [{ kind: "table", name: "main.s.t" }] },
        "main.s.t": managed("main.s.t"),
        "main.s.other": managed("main.s.other"),
      }),
    })
    expect(result.code).toBe("OK")
    expect(result.prepared?.tables).toEqual(["main.s.v", "main.s.t", "main.s.other"])
  })
})
