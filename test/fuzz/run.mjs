// The differential fuzz (design §5.3, §15.1; docs/parser.md): the same inputs through the plugin's generated
// TypeScript parser and Spark's own JVM parser from the pinned jar. Token streams (type, channel, text), the parse
// result, a digest of the whole parse tree's node kinds, and every invocation node must be equal, or the input must be
// one the read path's local rules refuse.
//
//   node test/fuzz/run.mjs [--cases N] [--seed S] [--jars DIR]
//
// Needs Java 17 or later (`java` and `javac` on PATH, or JAVA_HOME) and Bun. The jars are downloaded once into --jars
// (default: a cache folder under the system's temp folder) and checked against the sha256 in grammar/spark/PIN.json.
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
const here = fileURLToPath(new URL(".", import.meta.url))
const pin = JSON.parse(readFileSync(join(root, "grammar", "spark", "PIN.json"), "utf8"))
const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const total = Number(arg("cases", "3000"))
let seed = Number(arg("seed", "20261117"))
const jars = arg("jars", join(tmpdir(), "databricks-plugin-fuzz-jars"))
const java = (tool) => (process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", tool) : tool)

function fetchJar(url, sha256) {
  mkdirSync(jars, { recursive: true })
  const path = join(jars, url.split("/").at(-1))
  if (!existsSync(path)) execFileSync("curl", ["-sSfL", "-o", path, url])
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex")
  if (actual !== sha256) {
    rmSync(path, { force: true })
    throw new Error(`${url}: sha256 ${actual}, pinned ${sha256}`)
  }
  return path
}

// ── the corpus: hand-written cases, then generated ones ──────────────────
const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
const pick = (items) => items[Math.floor(random() * items.length)]
const FRAGMENTS = [
  "select", "SELECT", "from", "where", "t", "cat.sch.t", "`a``b`", "a", "b", ",", "(", ")", "1", "1.5", ".5e3", "2.D", "'s'", "'a''b'", "'\\''",
  '"x"', '"\\""', "r'\\d'", "$$q$$", "$t$q$t$", "/* c */", "/*+ h */", "/* /* n */ */", "-- c\n", "-- c\\\n", " ", " ", "é", "ß", "😀",
  "upper(a)", "count(*)", "explode(arr)", "lateral view explode(arr) v", "range(3)", "identifier('t')", "secret('s','k')", "cast(a as int)", "a::int",
  "extract(year from d)", "trim(both 'x' from s)", "position('a' in s)", "substring(s from 2)", "current_date", "x -> x", "array<int>", "map<int,array<int>>",
  ">>", ">>>", "|>", "|", "||", ":p", "?", ";", "\\", "union all", "join", "on", "group by", "order by", "limit 5", "over (order by a)", "in (1, 2)",
  "between 1 and 2", "is not null", "like 'a%'", "case when a then b end", "*", "+", "-", "=", "<=>", "!", "~", "insert into t", "drop table t", "set path =",
]
// Well-formed queries from a small grammar, so the parse trees (not only the tokens) are compared at volume.
const EXPRESSIONS = [
  "a", "t.b", "1", "1.5", "'s'", "upper(a)", "count(*)", "count(distinct a)", "sum(a) over (partition by b order by c)", "cast(a as int)", "a::bigint",
  "extract(year from d)", "trim(both 'x' from s)", "position('a' in s)", "substring(s from 2 for 3)", "current_date", "current_user", "a between 1 and 2",
  "a in (1, 2)", "a like 'x%'", "case when a > 1 then 'y' else 'n' end", "transform(arr, x -> x + 1)", "struct(a, b)", "map(1, 2)", "array(1, 2)",
  "v:a.b", "s collate utf8_lcase", "a is not null", "not a", "a + b * c", "a || b", "a >> 1", "(select max(a) from u)", "exists (select 1 from u)",
  "cat.sch.f(a)", "system.builtin.lower(a)", "filter(arr, x -> x > 0)", "first(a ignore nulls)", "timestampadd(hour, 1, ts)", "named_struct('k', a)",
]
const RELATIONS = ["t", "cat.sch.t", "`c`.`s`.`t`", "range(10)", "t lateral view explode(arr) v as e", "(select a from u) q", "t join u on t.a = u.a", "values (1, 2) as v(a, b)", "t tablesample (10 percent)", "cat.sch.f(1)", "t version as of 2"]
const structured = () => {
  const columns = Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(EXPRESSIONS)).join(", ")
  const where = random() < 0.5 ? ` where ${pick(EXPRESSIONS)}` : ""
  const tail = pick(["", " group by a", " order by a desc", " limit 5", " having count(*) > 1", " qualify row_number() over (order by a) = 1"])
  const query = `select ${columns} from ${pick(RELATIONS)}${where}${tail}`
  return random() < 0.2 ? `with q as (${query}) select * from q` : query
}
const corpus = JSON.parse(readFileSync(join(here, "corpus.json"), "utf8"))
while (corpus.length < total / 2) corpus.push(structured())
while (corpus.length < total) {
  const parts = []
  const length = 2 + Math.floor(random() * 10)
  for (let index = 0; index < length; index++) parts.push(pick(FRAGMENTS))
  corpus.push(parts.join(pick([" ", "", "\n", "\t"])))
}

// ── run both sides ───────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), "dbx-fuzz-"))
try {
  const classpath = [fetchJar(pin.jvm.sparkSqlApi, pin.jvm.sparkSqlApiSha256), fetchJar(pin.jvm.antlrRuntime, pin.jvm.antlrRuntimeSha256)].join(":")
  execFileSync(java("javac"), ["-cp", classpath, "-d", work, join(here, "Harness.java")], { stdio: "inherit" })
  const input = join(work, "cases.b64")
  writeFileSync(input, `${corpus.map((text) => Buffer.from(text, "utf8").toString("base64")).join("\n")}\n`)
  const jvm = spawnSync(java("java"), ["-cp", `${classpath}:${work}`, "Harness"], { input: readFileSync(input), maxBuffer: 1 << 30 })
  if (jvm.status !== 0) throw new Error(`the JVM harness failed: ${jvm.stderr}`)
  const ts = spawnSync("bun", [join(here, "dump.ts"), input], { cwd: root, maxBuffer: 1 << 30 })
  if (ts.status !== 0) throw new Error(`the TypeScript dump failed: ${ts.stderr}`)
  const left = jvm.stdout.toString("utf8").split("\n")
  const rows = ts.stdout.toString("utf8").split("\n")
  const right = rows.map((row) => row.slice(0, row.lastIndexOf("\t")))
  const refused = rows.map((row) => row.endsWith("\trefused"))
  let equal = 0
  let excused = 0
  const failures = []
  for (let index = 0; index < corpus.length; index++) {
    if (left[index] === right[index]) equal++
    else if (refused[index]) excused++
    else failures.push(index)
  }
  const parsed = left.slice(0, corpus.length).filter((line) => line.split("\t")[1] !== "ERROR").length
  console.log(`fuzz: ${corpus.length} inputs (${parsed} parse as statements in Spark), ${equal} equal, ${excused} differ but the read path refuses them, ${failures.length} differ.`)
  for (const index of failures.slice(0, 10)) {
    console.error(`\nDIFFERS: ${JSON.stringify(corpus[index])}\n  jvm: ${left[index]}\n  ts:  ${right[index]}`)
  }
  process.exitCode = failures.length === 0 ? 0 : 1
} finally {
  rmSync(work, { recursive: true, force: true })
}
