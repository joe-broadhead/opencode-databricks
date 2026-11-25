---
name: databricks-sql
description: The Databricks SQL dialect as the databricks_* read path accepts it - three-level names, :name parameters, built-in functions qualified by the plugin, keyword forms and the SQL path, QUALIFY, time travel, system tables, and what needs a plan.
---
If Databricks' tools are absent, run `/connect` and choose Databricks.

# Databricks SQL for the read path

## Names

- Name tables fully: `catalog.schema.table`, with backticks for unusual names. An unqualified name follows the
  workspace's SQL path, which an admin can change; the read path also has to check it, so a one- or two-part table name
  is path-sensitive.
- Column names may hold non-ASCII characters and be backquoted; a **function or generator name, or a keyword, may not**:
  a non-ASCII name is `SQL_INVALID`, because the plugin cannot prove Databricks resolves the name it checked.
- Call your own functions by their full name, `catalog.schema.function(…)`; a shorter name answers
  `FUNCTION_NAME_PARTIAL`.
- Built-in calls such as `upper(x)` are sent as `system.builtin.upper(x)`, so a function of the same name in a schema
  cannot stand in for them. You may write `system.builtin.<name>(…)` yourself.

## Parameters

- Pass values as `:name` markers with `params: [{ name: "zip", value: "10001", type: "STRING" }]`. The type defaults
  from the value (`BIGINT` for a safe integer, `DOUBLE` otherwise, `STRING`, `BOOLEAN`); `null` is SQL NULL.
- Positional `?` is refused: the Statement Execution API does not accept it.
- `IDENTIFIER(:p)` is refused: it chooses a table or function name at run time, which defeats the fence and the
  allowlist. The same holds for `identifier('upper')('a')`.

## Keyword forms and the SQL path

These forms cannot be qualified, so a read that uses one needs the workspace's default SQL path (`PATH_NOT_DEFAULT`
otherwise). The call form needs no path:

| Keyword form | Call form |
|---|---|
| `EXTRACT(YEAR FROM d)` | `date_part('YEAR', d)` |
| `TRIM(BOTH 'x' FROM s)` | `btrim(s, 'x')` |
| `POSITION('a' IN s)` | `position('a', s)` |
| `SUBSTRING(s FROM 2 FOR 3)` | `substring(s, 2, 3)` |
| `x BETWEEN a AND b` | `x >= a AND x <= b` |
| `FIRST(v IGNORE NULLS)` (and `LAST`, `ANY_VALUE`) | `first_value(v, true)` |
| `count(*)` | `count(1)` |
| a table named by one or two parts | `catalog.schema.table` |
| `LATERAL VIEW explode(arr) v AS c` | `SELECT explode(arr) AS c FROM …` (one generator) |

`current_date`, `current_timestamp` and `current_user` are not path-sensitive. Write them **without parentheses**: the
pinned grammar refuses `current_date()` (`SQL_UNSUPPORTED`).

## Allowed and not

- **Allowed generators:** `explode`, `inline`, `posexplode`, `stack`, `range` — in `SELECT`, in `FROM range(…)` and in
  `LATERAL VIEW` (written unqualified). `TABLE(range(3))` is refused: write `FROM range(3)`.
- **Needs a plan:** `read_files`, `read_kafka`, `read_kinesis`, `read_pubsub`, `read_pulsar`, `cloud_files_state`,
  `http_request`, `remote_query`, every `ai_*` function, `vector_search`, any user-defined table function, and any
  Python or Scala function.
- **Refused:** `secret`, `try_secret`, `list_secrets`, `reflect`, `java_method`, `try_reflect`, `TRANSFORM … USING`.
- **Not in the pinned Spark grammar:** `VACUUM`, `OPTIMIZE`, `ZORDER`, `RESTORE`, `COPY INTO`, `REORG` and `FSCK`.
  Reads refuse them (`SQL_UNSUPPORTED`); plans treat them as `run`, the strictest category. Use the SQL editor for Delta
  maintenance, or plan them deliberately.
- **In the grammar, but not the strictest category:** `CREATE STREAMING TABLE … AS SELECT` plans as `write`,
  `CREATE OR REFRESH STREAMING TABLE` as `run`, and `GRANT` as `share`. Show the preview either way.
- **No path at all:** `DESCRIBE HISTORY` is refused by a read (`STATEMENT_NOT_READ`) and by `databricks_plan`
  (`CATEGORY_MISMATCH`); use the SQL editor in this version.

## Ten worked examples

All are reads: they pass the read path, and a test runs each one against the fake workspace. They use a `samples`
catalog with a `nyctaxi` schema.

1. Ten rows:

```sql
SELECT * FROM samples.nyctaxi.trips LIMIT 10
```

2. Aggregate instead of pulling rows:

```sql
SELECT pickup_zip, count(*) AS trips FROM samples.nyctaxi.trips GROUP BY pickup_zip ORDER BY trips DESC LIMIT 10
```

3. A date part, in its call form:

```sql
SELECT date_part('YEAR', tpep_pickup_datetime) AS year, count(*) AS trips FROM samples.nyctaxi.trips GROUP BY date_part('YEAR', tpep_pickup_datetime) ORDER BY year
```

4. Approximate distinct counts, for a cheap cardinality:

```sql
SELECT pickup_zip, approx_count_distinct(dropoff_zip) AS zips FROM samples.nyctaxi.trips GROUP BY pickup_zip
```

5. A sample, not the whole table:

```sql
SELECT * FROM samples.nyctaxi.trips TABLESAMPLE (10 PERCENT)
```

6. Time travel, pinned to a version:

```sql
SELECT * FROM samples.nyctaxi.trips VERSION AS OF 1 LIMIT 5
```

7. A parameter, with `params`:

```sql
SELECT * FROM samples.nyctaxi.trips WHERE pickup_zip = :zip LIMIT 5
```

8. An alias for a join-shaped query:

```sql
SELECT t.pickup_zip, t.trip_distance FROM samples.nyctaxi.trips AS t WHERE t.trip_distance > 10 LIMIT 5
```

9. `QUALIFY` for a top row per group:

```sql
SELECT pickup_zip, fare_amount FROM samples.nyctaxi.trips QUALIFY row_number() OVER (PARTITION BY pickup_zip ORDER BY fare_amount DESC) = 1
```

10. A generator in `SELECT`:

```sql
SELECT explode(array(1, 2, 3)) AS n
```

## Profiles instead of rows

`databricks_profile({ table, columns: ["fare_amount", "trip_distance"] })` returns rows, nulls,
`approx_count_distinct`, min, max, `percentile_approx` and `approx_top_k(5)` per column. Prefer it to a large
`SELECT *`; add `samplePercent`.

## System tables and information schema

`system.access.table_lineage` (one year retained) needs a grant on `system`; `system.billing.usage` and
`system.billing.list_prices` need a grant too, and the reconciliation in `databricks_status({ include: ["spend"] })`
uses `usage` for the default warehouse today. Query History as a table lives in `system.query.history` (365 days).
`information_schema` is per catalog: `samples.information_schema.tables`, `.columns`, `.table_privileges`.

```sql
SELECT table_name FROM samples.information_schema.tables LIMIT 5
```

The plugin's Query History tool (`databricks_history`) is free and needs the `query-history` scope, not a warehouse.

## Delta and caching

- `DESCRIBE HISTORY`, `VACUUM` and `OPTIMIZE` are statements, not queries: plan them (`run`/`delete`), or use the SQL
  editor.
- An identical read within 24 hours can be served from the result cache, and `databricks_save` after
  `databricks_query` often is.
- `LIMIT` still scans: filter on partition columns (`databricks_table` lists them), and aggregate in SQL before pulling
  rows.
