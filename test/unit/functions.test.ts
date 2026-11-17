// The function allowlist (design §5.2), every invocation position (review R2-M1), the keyword forms (round 3, LOW 2),
// and the system.builtin qualification and the SQL path rule (round 3, LOW 3).
import { describe, expect, it } from "vitest"
import * as generated from "../../src/sql/generated/SqlBaseParser.js"
import { BUILTIN_NAMES } from "../../src/domain/builtins.generated.js"
import { AI_PREFIX, ALLOWLIST, decideFunction, EXCLUSIONS, KEYWORD_FORMS, NILADIC_FIXED, pathIsSafe, TABLE_ALLOWLIST } from "../../src/domain/functions.js"
import { analyzeRead } from "../../src/sql/analyze.js"
import { foldName } from "../../src/sql/parse.js"

const read = (sql: string) => analyzeRead(sql)
const code = (sql: string) => {
  const result = read(sql)
  return result.ok ? "OK" : result.refusal.code
}
const sent = (sql: string) => {
  const result = read(sql)
  if (!result.ok) throw new Error(`${sql}: ${result.refusal.code} ${result.refusal.detail}`)
  return result.rewritten
}
const pathNames = (sql: string) => {
  const result = read(sql)
  if (!result.ok) throw new Error(`${sql}: ${result.refusal.code}`)
  return result.pathSensitive.filter((item) => item.kind !== "table").map((item) => item.name)
}

describe("the allowlist", () => {
  it("holds no excluded name and no ai_* function, and is the reference minus exactly those", () => {
    for (const exclusion of EXCLUSIONS) for (const name of exclusion.names) expect(ALLOWLIST.has(name), name).toBe(false)
    expect([...ALLOWLIST].filter((name) => name.startsWith(AI_PREFIX))).toEqual([])
    const removed = BUILTIN_NAMES.filter((name) => !ALLOWLIST.has(name))
    const named = new Set(EXCLUSIONS.flatMap((exclusion) => exclusion.names))
    expect(removed.filter((name) => !named.has(name) && !name.startsWith(AI_PREFIX))).toEqual([])
    expect(ALLOWLIST.size).toBeGreaterThan(600)
  })

  it("names the design's exclusions with their codes", () => {
    expect(decideFunction(["secret"], "scalar")).toMatchObject({ code: "SECRET_FUNCTION_REFUSED" })
    expect(decideFunction(["list_secrets"], "table")).toMatchObject({ code: "SECRET_FUNCTION_REFUSED" })
    expect(decideFunction(["reflect"], "scalar")).toMatchObject({ code: "FUNCTION_REFUSED" })
    for (const name of ["http_request", "remote_query", "read_kafka", "read_files", "cloud_files_state", "vector_search", "ai_query"]) expect(decideFunction([name], "scalar"), name).toMatchObject({ code: "NEEDS_PLAN", category: "write" })
    expect(decideFunction(["system", "ai", "python_exec"], "scalar")).toMatchObject({ code: "NEEDS_PLAN", category: "run" })
  })

  it("treats builtin.x as a user function but applies the exclusions to it, system.builtin.x as the built-in, and refuses session.* (LOW 1)", () => {
    expect(decideFunction(["builtin", "upper"], "scalar").kind).toBe("unknown")
    expect(decideFunction(["builtin", "secret"], "scalar")).toMatchObject({ code: "SECRET_FUNCTION_REFUSED" })
    expect(decideFunction(["builtin", "read_kafka"], "table")).toMatchObject({ code: "NEEDS_PLAN", category: "write" })
    expect(decideFunction(["builtin", "ai_query"], "scalar")).toMatchObject({ code: "NEEDS_PLAN" })
    expect(decideFunction(["system", "builtin", "upper"], "scalar")).toEqual({ kind: "builtin", name: "upper" })
    expect(decideFunction(["system", "builtin", "secret"], "scalar")).toMatchObject({ code: "SECRET_FUNCTION_REFUSED" })
    expect(decideFunction(["session", "f"], "scalar")).toMatchObject({ code: "FUNCTION_REFUSED" })
    expect(decideFunction(["system", "session", "f"], "scalar")).toMatchObject({ code: "FUNCTION_REFUSED" })
    expect(code("select session.f(a) from main.s.t")).toBe("FUNCTION_REFUSED")
    expect(code("select builtin.secret('s', 'k')")).toBe("SECRET_FUNCTION_REFUSED")
  })

  it("allows only table and generator built-ins in a table position", () => {
    expect([...TABLE_ALLOWLIST].sort()).toEqual(expect.arrayContaining(["explode", "inline", "posexplode", "range", "stack"]))
    expect(decideFunction(["upper"], "table").kind).toBe("unknown")
  })
})

describe("the system qualifiers, folded as Spark compares them (review of #1, round 2, LOW 1)", () => {
  it("folds ſ, ı, Kelvin K and İ as Java's equalsIgnoreCase does", () => {
    expect(foldName("ſystem")).toBe("system")
    expect(foldName("buıltin")).toBe("builtin")
    expect(foldName("\u212Aafka")).toBe("kafka")
    expect(foldName("\u0130D")).toBe("id")
    expect(foldName("SYSTEM")).toBe("system")
    expect(foldName("straße")).toBe("straße")
  })

  it("decides the reviewer's probes as system.builtin.secret and system.ai.python_exec", () => {
    expect(code("select ſystem.builtin.secret('s', 'k')")).toBe("SECRET_FUNCTION_REFUSED")
    expect(code("select system.buıltin.secret('s', 'k')")).toBe("SECRET_FUNCTION_REFUSED")
    expect(code("select ſystem.ai.python_exec('x')")).toBe("NEEDS_PLAN")
    expect(code("select ſecret('s', 'k')")).toBe("SECRET_FUNCTION_REFUSED")
    expect(code("select * from read_\u212Aafka(bootstrapServers => 'h')")).toBe("NEEDS_PLAN")
  })

  it("never hands package C a user function whose name only reads as another under Java's case rules", () => {
    const result = read("select caſ.sch.f(1)")
    expect(!result.ok && result.refusal.code).toBe("SQL_INVALID")
    const plain = read("select cat.sch.f(1)")
    expect(plain.ok && plain.userFunctions.map((call) => call.confusable)).toEqual([false])
  })
})

describe("system.* names that are not allowlisted built-ins (review of #1, round 2, LOW 2)", () => {
  it("are NEEDS_PLAN (run) on the read path, never user functions for package C", () => {
    for (const sql of ["select system.builtin.newfn(1)", "select system.information_schema.f(1)", "select * from system.builtin.upper('a')", "select system.f(1)", "select SYSTEM.BUILTIN.NEWFN(1)"]) {
      const result = read(sql)
      expect(!result.ok && result.refusal, sql).toMatchObject({ code: "NEEDS_PLAN", category: "run" })
    }
    expect(decideFunction(["system", "builtin", "newfn"], "scalar")).toMatchObject({ kind: "refused", code: "NEEDS_PLAN" })
    expect(decideFunction(["system", "builtin", "upper"], "scalar")).toEqual({ kind: "builtin", name: "upper" })
  })

  it("leave every user function package C receives outside the system catalog", () => {
    for (const sql of ["select cat.sch.f(1)", "select upper(a), main.s.g(b) from main.s.t"]) {
      const result = read(sql)
      if (!result.ok) throw new Error(sql)
      for (const call of result.userFunctions) expect(call.parts[0], sql).not.toBe("system")
    }
  })
})

describe("every invocation position (R2-M1)", () => {
  it.each([
    ["SELECT * FROM read_files('s3://bucket/x')", "NEEDS_PLAN"],
    ["SELECT * FROM read_kafka(bootstrapServers => 'h:9092')", "NEEDS_PLAN"],
    ["SELECT * FROM cat.sch.py_udtf(1)", "NEEDS_PLAN"],
    ["SELECT * FROM main.s.t LATERAL VIEW cat.sch.py_udtf(c) v", "NEEDS_PLAN"],
    ["SELECT * FROM cat.sch.sql_udtf(TABLE(main.s.t))", "NEEDS_PLAN"],
    ["SELECT * FROM STREAM read_kafka(bootstrapServers => 'h')", "NEEDS_PLAN"],
    ["SELECT TRANSFORM(a) USING 'cat' FROM main.s.t", "FUNCTION_REFUSED"],
    ["SELECT * FROM range(10)", "OK"],
    ["SELECT * FROM main.s.t LATERAL VIEW explode(arr) v AS c", "OK"],
    ["SELECT explode(arr) FROM main.s.t", "OK"],
    ["SELECT * FROM main.s.t PIVOT (sum(a) FOR b IN (1, 2))", "OK"],
    ["SELECT * FROM main.s.t PIVOT (cat.sch.agg(a) FOR b IN (1, 2))", "OK"],
    ["SELECT * FROM main.s.t PIVOT (myagg(a) FOR b IN (1, 2))", "FUNCTION_NAME_PARTIAL"],
    ["SELECT row_number() OVER (ORDER BY a) FROM main.s.t", "OK"],
    ["SELECT transform(arr, x -> secret('s', 'k')) FROM main.s.t", "SECRET_FUNCTION_REFUSED"],
    ["SELECT /*+ REPARTITION(secret('s','k')) */ a FROM main.s.t", "SECRET_FUNCTION_REFUSED"],
    ["SELECT * FROM VALUES (http_request(conn => 'c')) AS v(a)", "NEEDS_PLAN"],
    ["SELECT * FROM main.s.t TABLESAMPLE (BUCKET 1 OUT OF 2 ON rand())", "FUNCTION_REFUSED"],
    ["SELECT count(*) FILTER (WHERE secret('s','k') = 'x') FROM main.s.t", "SECRET_FUNCTION_REFUSED"],
    ["SELECT * FROM main.s.t |> EXTEND secret('s','k') AS x", "SECRET_FUNCTION_REFUSED"],
  ])("%s → %s", (sql, expected) => {
    expect(code(sql)).toBe(expected)
  })

  it("finds a call through whitespace, comments and backquotes", () => {
    for (const sql of ["select system . ai . python_exec('x')", "select `system`.`ai`.`python_exec`('x')", "select system/*x*/.ai.python_exec('x')", "select SECRET ('s','k')", "select `secret`('s','k')"]) {
      expect(["NEEDS_PLAN", "SECRET_FUNCTION_REFUSED"], sql).toContain(code(sql))
    }
  })

  it("reports a scalar user function named in full for package C to check, sent as written", () => {
    const result = read("select cat.sch.myfn(a) from main.s.t")
    expect(result.ok && result.userFunctions.map((call) => call.parts.join("."))).toEqual(["cat.sch.myfn"])
    expect(result.ok && result.rewritten).toBe("select cat.sch.myfn(a) from main.s.t")
  })

  it("refuses a user function named by one or two parts, which Databricks resolves along PATH (review #1, M2)", () => {
    // The decoy: workspace.default.python_exec is a harmless SQL function anyone can create, but a one-part
    // python_exec(…) resolves to system.ai.python_exec first on the default path. It must never be sent one-part.
    const decoy = read("select python_exec('print(1)')")
    expect(decoy.ok).toBe(false)
    expect(!decoy.ok && decoy.refusal).toMatchObject({ code: "FUNCTION_NAME_PARTIAL", next: "Write the function's full name, catalog.schema.function." })
    expect(code("select default.python_exec('print(1)')")).toBe("FUNCTION_NAME_PARTIAL")
    expect(code("select myfn(a) from main.s.t")).toBe("FUNCTION_NAME_PARTIAL")
    expect(code("select sch.myfn(a) from main.s.t")).toBe("FUNCTION_NAME_PARTIAL")
    // Named in full, the decoy is a user function package C checks; system.ai's is refused outright.
    const full = read("select workspace.default.python_exec('print(1)')")
    expect(full.ok && full.userFunctions.map((call) => call.parts)).toEqual([["workspace", "default", "python_exec"]])
    expect(code("select system.ai.python_exec('print(1)')")).toBe("NEEDS_PLAN")
    // No call the analysis passes is sent with fewer than three parts unless it is an allowlisted built-in.
    for (const sql of ["select upper(a), cat.sch.f(b) from main.s.t", "select count(*) from main.s.t lateral view explode(arr) v as c"]) {
      const result = read(sql)
      if (!result.ok) throw new Error(sql)
      for (const call of result.invocations) expect(call.decision.kind === "builtin" || call.parts.length === 3, call.parts.join(".")).toBe(true)
    }
  })
})

describe("keyword forms (LOW 2): each grammar form that can invoke a function is allowlisted by name or refused", () => {
  it.each([
    ["CAST(a AS INT)", []],
    ["TRY_CAST(a AS INT)", []],
    ["a::INT", []],
    ["EXTRACT(YEAR FROM d)", ["extract"]],
    ["TRIM(BOTH 'x' FROM s)", ["trim"]],
    ["TRIM(LEADING FROM s)", ["trim"]],
    ["POSITION('a' IN s)", ["position"]],
    ["SUBSTRING(s FROM 2 FOR 3)", ["substring"]],
    ["SUBSTR(s, 2, 3)", []],
    ["OVERLAY(s PLACING 'x' FROM 2)", ["overlay"]],
    ["TIMESTAMPADD(HOUR, 1, ts)", ["timestampadd"]],
    ["TIMESTAMPDIFF(HOUR, ts, ts)", ["timestampdiff"]],
    ["FIRST(a IGNORE NULLS)", ["first"]],
    ["LAST(a IGNORE NULLS)", ["last"]],
    ["ANY_VALUE(a IGNORE NULLS)", ["any_value"]],
    ["a BETWEEN 1 AND 2", ["between"]],
    ["current_date", []],
    ["current_timestamp", []],
    ["current_user", []],
    ["user", ["user"]],
    ["session_user", ["session_user"]],
    ["current_path", ["current_path"]],
    ["STRUCT(a, b)", []],
    ["CASE WHEN a THEN 1 END", []],
    ["CASE a WHEN 1 THEN 2 END", []],
    ["s COLLATE UTF8_LCASE", []],
    ["v:a.b", []],
  ])("%s → path-sensitive names %j", (expression, names) => {
    expect(pathNames(`select ${expression} from main.s.t`)).toEqual(names)
  })

  it("every primaryExpression, relationPrimary, sampleMethod and predicate alternative of the generated parser is classified", () => {
    const parentOf = (name: string) => Object.getPrototypeOf((generated as Record<string, unknown>)[name] as object)?.name as string | undefined
    const alternatives = (parent: string) => Object.keys(generated).filter((name) => name.endsWith("Context") && parentOf(name) === parent)
    // Nodes that call nothing by name themselves; their children are walked.
    const NO_INVOCATION = new Set([
      "ConstantDefaultContext", "StarContext", "RowConstructorContext", "SubqueryExpressionContext", "ColumnReferenceContext", "ParenthesizedExpressionContext",
      "SubscriptContext", "DereferenceContext",
      "AliasedQueryContext", "AliasedRelationContext", "InlineTableDefault2Context", "UnnestTableContext", "JsonTableRelationContext", "TableNameContext", "ChangelogTableNameContext", "StreamRelationContext",
      "SampleByPercentileContext", "SampleByRowsContext", "SampleByBytesContext",
    ])
    // Nodes the walker handles as invocations (src/sql/analyze.ts).
    const INVOCATION = new Set(["FunctionCallContext", "TableValuedFunctionContext"])
    const unclassified = [...alternatives("PrimaryExpressionContext"), ...alternatives("RelationPrimaryContext"), ...alternatives("SampleMethodContext")].filter(
      (name) => !NO_INVOCATION.has(name) && !INVOCATION.has(name) && !Object.hasOwn(KEYWORD_FORMS, name),
    )
    expect(unclassified).toEqual([])
    expect(alternatives("PrimaryExpressionContext").length).toBe(28)
  })

  it("no keyword form builds an excluded function", () => {
    for (const form of Object.values(KEYWORD_FORMS)) {
      for (const name of "names" in form ? form.names : []) expect(decideFunction([name], "scalar").kind === "refused", name).toBe(false)
    }
    for (const name of NILADIC_FIXED) expect(ALLOWLIST.has(name), name).toBe(true)
  })
})

describe("system.builtin qualification (LOW 3)", () => {
  it("qualifies every allowlisted unqualified call, backquoting keyword names", () => {
    expect(sent("select upper(a), lower(b) from main.s.t")).toBe("select system.builtin.upper(a), system.builtin.lower(b) from main.s.t")
    expect(sent("select left(s, 2), filter(arr, x -> x > 1) from main.s.t")).toBe("select system.builtin.`left`(s, 2), system.builtin.`filter`(arr, x -> x > 1) from main.s.t")
    expect(sent("select * from range(3)")).toBe("select * from system.builtin.`range`(3)")
    expect(sent("select * from main.s.t lateral view explode(arr) v as c")).toBe("select * from main.s.t lateral view explode(arr) v as c")
    expect(sent("select UPPER(a) from main.s.t")).toBe("select system.builtin.upper(a) from main.s.t")
    expect(sent("select `upper`(a) from main.s.t")).toBe("select system.builtin.upper(a) from main.s.t")
  })

  it("never sends a LATERAL VIEW generator with more than two parts, and treats it as path-sensitive (review #1, M1)", () => {
    for (const sql of [
      "select * from main.s.t lateral view explode(arr) v as c",
      "select * from main.s.t lateral view outer posexplode(arr) v as p, c",
      "select * from main.s.t lateral view inline(structs) v lateral view explode(arr) w as c",
      "select * from main.s.t lateral view stack(2, a, b) v as x",
    ]) {
      const result = read(sql)
      if (!result.ok) throw new Error(`${sql}: ${result.refusal.code}`)
      const sentCalls = analyzeRead(result.rewritten)
      if (!sentCalls.ok) throw new Error(sql)
      for (const call of sentCalls.invocations.filter((item) => item.node === "lateralView")) expect(call.parts.length, sql).toBeLessThanOrEqual(2)
      expect(result.pathSensitive.filter((item) => item.kind === "keyword-form").length, sql).toBeGreaterThan(0)
    }
    expect(pathNames("select * from main.s.t lateral view explode(arr) v as c")).toEqual(["explode"])
    expect(code("select * from main.s.t lateral view system.builtin.explode(arr) v as c")).toBe("SQL_UNSUPPORTED")
    expect(code("select * from main.s.t lateral view default.explode(arr) v as c")).toBe("NEEDS_PLAN")
  })

  it("leaves calls already qualified, user functions and count(*) as written; count(*) is path-sensitive", () => {
    expect(sent("select system.builtin.upper(a) from main.s.t")).toBe("select system.builtin.upper(a) from main.s.t")
    expect(sent("select cat.sch.f(a) from main.s.t")).toBe("select cat.sch.f(a) from main.s.t")
    expect(sent("select count(*), count(a) from main.s.t")).toBe("select count(*), system.builtin.count(a) from main.s.t")
    expect(pathNames("select count(*) from main.s.t")).toEqual(["count"])
  })

  it("counts code points, so text after a non-BMP character is rewritten in place", () => {
    expect(sent("select '😀', upper(a) from main.s.t")).toBe("select '😀', system.builtin.upper(a) from main.s.t")
  })

  it("marks unqualified tables as path-sensitive, and leaves CTE names alone", () => {
    const result = read("with q as (select 1 a) select * from q join t on true")
    expect(result.ok && result.pathSensitive).toEqual([{ kind: "table", name: "t" }])
  })

  it("accepts only a path that keeps system.builtin before every user schema", () => {
    expect(pathIsSafe("system.session,system.builtin,system.ai,main.default")).toBe(true)
    expect(pathIsSafe("system.builtin, main.default")).toBe(true)
    expect(pathIsSafe("main.evil,system.session,system.builtin")).toBe(false)
    expect(pathIsSafe("system.session,`main`.`evil`,system.builtin")).toBe(false)
    expect(pathIsSafe("main.default")).toBe(false)
  })
})
