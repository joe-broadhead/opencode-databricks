// The read path's local rules (design §5.1 step 1) and the wrapper: exact text, refused constructs, and properties.
import { describe, expect, it } from "vitest"
import { analyzeRead, stripTrailingSemicolon, wrap } from "../../src/sql/analyze.js"

const code = (sql: string) => {
  const result = analyzeRead(sql)
  return result.ok ? "OK" : result.refusal.code
}

describe("the wrapper", () => {
  it("is exactly SELECT * FROM (\\n<sql>\\n) AS oc_q, one trailing ; removed", () => {
    const result = analyzeRead("SELECT a FROM main.s.t ORDER BY a;  \n")
    expect(result.ok && result.sent).toBe("SELECT * FROM (\nSELECT a FROM main.s.t ORDER BY a\n) AS oc_q")
    expect(stripTrailingSemicolon("select 1 ; ")).toBe("select 1 ")
  })

  it("dry property: whatever passes is sent as wrap(rewritten), and rewritten differs only by qualification", () => {
    for (const sql of ["select upper(a), count(*) from main.s.t", "select * from main.s.t lateral view explode(arr) v as c", "with q as (select 1 a) select * from q", "select :p as x", "select a from main.s.t where a between 1 and 2"]) {
      const result = analyzeRead(sql)
      if (!result.ok) throw new Error(`${sql}: ${result.refusal.code}`)
      expect(result.sent).toBe(wrap(result.rewritten))
      expect(result.rewritten.replace(/system\.builtin\.(`?)(\w+)\1/g, "$2")).toBe(result.sql)
    }
  })
})

describe("refused constructs", () => {
  it.each([
    ["a second statement", "select 1; select 2", "STATEMENT_NOT_READ"],
    ["a semicolon in a string", "select ';'", "STATEMENT_NOT_READ"],
    ["a semicolon in a comment", "select 1 -- ;\n", "STATEMENT_NOT_READ"],
    ["a nested comment opener", "select 1 /* a /* b */ */", "STATEMENT_NOT_READ"],
    ["an unbalanced nested comment opener", "select 1 /* a /* b */", "SQL_INVALID"],
    ["a trailing ; inside a comment", "select 1 --;", "STATEMENT_NOT_READ"],
    ["a line-continued -- comment (the review's bypass)", "select 1 -- x\\\n, secret('scope', 'key')", "STATEMENT_NOT_READ"],
    ["a -- comment ending in a backslash at the end", "select 1 -- x\\", "STATEMENT_NOT_READ"],
    ["a backslash before CRLF", "select 1 -- x\\\r\n", "STATEMENT_NOT_READ"],
    ["U+0085 in a -- comment (LOW 3)", "select 1 -- a\u0085, 2", "STATEMENT_NOT_READ"],
    ["a vertical tab in a -- comment", "select 1 -- a\u000b, 2", "STATEMENT_NOT_READ"],
    ["a form feed in a -- comment", "select 1 -- a\u000c, 2", "STATEMENT_NOT_READ"],
    ["U+2028", "select 1 ", "STATEMENT_NOT_READ"],
    ["U+2029", "select ' '", "STATEMENT_NOT_READ"],
    ["IDENTIFIER(", "select * from identifier(:t)", "IDENTIFIER_REFUSED"],
    ["IDENTIFIER as a function name", "select identifier('upper')('a')", "IDENTIFIER_REFUSED"],
    ["IDENTIFIER with a comment before (", "select * from IDENTIFIER /*x*/ ('t')", "IDENTIFIER_REFUSED"],
    ["a positional ?", "select ?", "SQL_INVALID"],
    ["an unclosed comment", "select 1 /* open", "SQL_INVALID"],
    ["a script transform", "SELECT TRANSFORM(a) USING 'cat' FROM t", "FUNCTION_REFUSED"],
    ["MAP … USING", "MAP a USING 'cat' AS b FROM t", "FUNCTION_REFUSED"],
    ["SET PATH", "SET PATH = main.evil, system.builtin", "SESSION_STATEMENT_REFUSED"],
    ["SET a config", "SET spark.sql.ansi.enabled = false", "SESSION_STATEMENT_REFUSED"],
    ["SET VAR", "SET VAR x = 1", "SESSION_STATEMENT_REFUSED"],
    ["RESET", "RESET", "SESSION_STATEMENT_REFUSED"],
    ["USE", "USE main.evil", "SESSION_STATEMENT_REFUSED"],
    ["DECLARE", "DECLARE x INT", "SESSION_STATEMENT_REFUSED"],
    ["a temporary view", "CREATE TEMPORARY VIEW v USING parquet OPTIONS (path 'x')", "SESSION_STATEMENT_REFUSED"],
    ["DML", "insert into main.s.t select 1", "STATEMENT_NOT_READ"],
    ["EXECUTE IMMEDIATE", "EXECUTE IMMEDIATE 'drop table t'", "STATEMENT_NOT_READ"],
    ["CALL", "CALL main.s.p()", "STATEMENT_NOT_READ"],
    ["EXPLAIN", "EXPLAIN select 1", "STATEMENT_NOT_READ"],
    ["SHOW", "SHOW TABLES", "STATEMENT_NOT_READ"],
    ["a script", "BEGIN SELECT 1; END", "STATEMENT_NOT_READ"],
    ["Databricks-only syntax", "SELECT * FROM TABLE(range(3))", "SQL_UNSUPPORTED"],
    ["text Spark cannot parse", "selec 1", "SQL_UNSUPPORTED"],
  ])("%s → %s", (_what, sql, expected) => {
    expect(code(sql)).toBe(expected)
  })

  it("TABLE(f(…)) in FROM names the form to write instead", () => {
    const result = analyzeRead("SELECT * FROM TABLE(range(3))")
    expect(!result.ok && result.refusal).toMatchObject({ code: "SQL_UNSUPPORTED", next: "Write FROM f(…) instead." })
  })

  it("marks <format>.`path` reads as path reads, relative paths included (LOW 4)", () => {
    for (const sql of ["select * from json.`file.json`", "select * from delta.`/tmp/x`", "select * from binaryFile.`dir`"]) {
      const result = analyzeRead(sql)
      expect(result.ok && result.tables.map((table) => table.pathRead), sql).toEqual([true])
    }
    const named = analyzeRead("select * from main.json.t")
    expect(named.ok && named.tables.map((table) => table.pathRead)).toEqual([false])
  })

  it("over 1 MiB is refused", () => {
    expect(code(`select '${"x".repeat(1024 * 1024)}'`)).toBe("INPUT_INVALID")
  })
})

describe("property: no refused construct ever reaches the network", () => {
  // A small deterministic generator: random queries with one hazard spliced in at a random place.
  let seed = 7
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!
  const SAFE = ["select a from main.s.t", "select upper(b), 1 from main.s.u where c > 2", "select count(*) from main.s.t group by a", "select * from main.s.t limit 5"]
  const HAZARDS = [";", ";select 1", "/* /* */", "-- c\\\n", " ", " ", "identifier('t')", "IDENTIFIER (", "?", "transform(a) using 'cat'"]
  it("for 2,000 inputs, a hazard is never in `sent`", () => {
    for (let index = 0; index < 2000; index++) {
      const base = pick(SAFE)
      const hazard = pick(HAZARDS)
      const at = Math.floor(random() * (base.length + 1))
      const sql = base.slice(0, at) + hazard + base.slice(at)
      const result = analyzeRead(sql)
      if (!result.ok) continue
      for (const bad of [";", "/* /*", "\\\n", " ", " "]) expect(result.sent.includes(bad), JSON.stringify(sql)).toBe(false)
      expect(/\bidentifier\s*(\/\*.*?\*\/\s*)*\(/i.test(result.sent), JSON.stringify(sql)).toBe(false)
      expect(/using\s+'/i.test(result.sent), JSON.stringify(sql)).toBe(false)
    }
  })
})
