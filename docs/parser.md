# The parser

The plugin decides what a statement is from its own parse of **Apache Spark's SQL grammar**, generated, never written
by hand (design §5.3).

## The pin

`grammar/spark/PIN.json` names the pin: Apache Spark **v4.3.0**, commit `98bc0212c94705434471627068f41e374ccab143`,
`sql/api/src/main/antlr4/org/apache/spark/sql/catalyst/parser/SqlBaseLexer.g4` and `SqlBaseParser.g4`, copied byte
for byte into `grammar/spark/` with their sha256. A release tag, so the differential fuzz can run that tag's own
parser from Maven Central (`spark-sql-api_2.13-4.3.0.jar`).

## Generation

`node scripts/generate-parser.mjs` regenerates `src/sql/generated/SqlBaseLexer.ts` and `SqlBaseParser.ts`:

1. it checks each grammar file's sha256 against the pin;
2. it ports the grammar's Java actions to TypeScript with `grammar/port.mjs`: each Java fragment is named with the
   number of times it must occur (the 22 predicates, the lexer's and parser's `@members`, and the parser action that
   closes `STRUCT<>` in the lexer), so a new pin with a new or changed action fails until a person ports it, and a
   scan fails on any Java left over;
3. it runs **antlr-ng** (the ANTLR tool written in TypeScript) for the antlr4ng runtime, with no listener and no
   visitor;
4. it writes a fixed header; nothing machine-specific reaches the files.

The flags are pinned to a SQL warehouse's defaults: ANSI reserved keywords on, double-quoted identifiers off,
legacy set-operation precedence off. `src/sql/parse.ts` drives the parser as Spark's `AbstractParser` does: an
upper-cased character stream (Java's `Character.toUpperCase` per code point), SLL with a bail-out first, then LL on the
same rewound token stream.

`npm run check` runs `scripts/generate-parser.mjs --check` (stage `parser`): it regenerates into a temporary folder and
fails on any byte of difference, so the committed parser is always what the pin and the port produce.
`scripts/generate-allowlist.mjs --check` does the same for the built-in function list.

## Dependencies and the package

The family's rule is "no runtime dependencies; everything bundled into `dist/`". The parser keeps it:

| Package | Role | Where it goes |
|---|---|---|
| `antlr-ng` 1.0.10 (MIT) | The generator | devDependency only, pinned exactly. Never bundled: it runs at generation and in the check. No Java is needed to build. |
| `antlr4ng` 3.0.16 (BSD-3-Clause) | The runtime the generated code imports | devDependency, pinned exactly, bundled into `dist/index.js` by esbuild. `NOTICE` carries its licence. |
| The generated `SqlBaseLexer.ts`, `SqlBaseParser.ts` | Derived from Spark's grammar (Apache License 2.0) | Committed source, bundled into `dist/index.js`. `NOTICE` carries Spark's licence and notice. |

The parser is most of the bundle. Measured with esbuild's metafile at this pin, minified: the parser 744 KB, the lexer
155 KB, the antlr4ng runtime 170 KB, zod 98 KB, the plugin's own code 80 KB. `dist/index.js` is about 1.3 MB, 280 KB
gzipped. The grammar's tables are deserialized on the first parse (about 170 ms once), not when the plugin loads.
The pack test's budget is 400 KiB packed, set with that measured; the family's other plugins with large bundles
(charts, jobs) have larger ones.

## The differential fuzz

`test/fuzz/` compares the generated TypeScript parser with Spark's own JVM parser from the pinned jar, on a corpus of
hand-written and generated inputs: comments and line continuations, nested comments, hints, every quote and escape,
raw strings, tagged dollar quotes, backquote escapes, Unicode (U+2028 and U+2029 included), keyword forms and every
function position. For each input both sides print the token stream (type, text) and the parse result (the statement
kind, and every invocation node with its name). They must be equal, or the input must be one the local rules refuse.
The `fuzz` job in `.github/workflows/ci.yml` runs it with Java 17; `npm run fuzz` runs it where Java and the jars are.

The fuzz proves the port equals **open-source Spark** at the pin. It cannot prove equality with Databricks' own parser,
which is closed: one more reason the checks past the wrapper are best-effort (see [Safety](safety.md)).
