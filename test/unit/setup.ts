// Runs in every unit-test worker before its tests (vitest.config.ts `setupFiles`), outside any test's time limit.
//
// The generated SQL parser deserializes its grammar tables and builds its first DFA states on the first parse in a
// process: about 0.3 s here, several seconds on a loaded macOS Intel runner, against about 10 ms for every later
// parse. Without this, that one-time cost was billed to whichever test parsed first in each file, so the result
// depended on test order and runner speed (run 44199168471: `query.test.ts` and `table-statement-history.test.ts`
// timed out at 5 s on macOS Intel and passed on the next push). Paying it here makes every test's time its own work.
import { classifyPlan } from "../../src/domain/statements.js"
import { analyzeRead } from "../../src/sql/analyze.js"

// The common shapes, so the parser's prediction tables (shared by every parse in the process) are built here too.
for (const sql of [
  "SELECT * FROM `main`.`sales`.`orders_v` LIMIT 5",
  "SELECT id, name, year(d) AS y FROM main.s.t WHERE a > 1 AND b IN (1, 2) ORDER BY id DESC",
  "WITH q AS (SELECT a FROM main.s.t LATERAL VIEW explode(arr) v AS e) SELECT upper(a), count(*) FROM q WHERE a BETWEEN 1 AND 2 GROUP BY a",
  "SELECT CAST(a AS INT), CASE WHEN a THEN 1 ELSE 2 END, row_number() OVER (PARTITION BY a ORDER BY b), :p FROM main.s.t t JOIN main.s.u u ON t.id = u.id",
  "SELECT count(*), approx_count_distinct(a), min(a), max(a), percentile_approx(a, array(0.5)) FROM (SELECT a FROM main.s.t) AS q",
]) analyzeRead(sql)
for (const sql of ["MERGE INTO main.s.t USING main.s.u ON t.id = u.id WHEN MATCHED THEN DELETE", "INSERT INTO main.s.t SELECT 1", "DROP TABLE main.s.t", "VACUUM main.s.t"]) classifyPlan(sql)
