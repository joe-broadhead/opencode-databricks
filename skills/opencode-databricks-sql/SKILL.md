---
name: opencode-databricks-sql
description: The Databricks SQL dialect as the databricks_* read path accepts it - three-level names, :name parameters, built-in functions qualified by the plugin, keyword forms and the SQL path, and what needs a plan.
---
If Databricks' tools are absent, run `/connect` and choose Databricks, or on Jelly call jelly_connection_request.

# Databricks SQL for the read path

- Name tables fully: `catalog.schema.table`, with backquotes for unusual names. An unqualified name follows the
  workspace's SQL path.
- Pass values as `:name` markers with `params`. `IDENTIFIER(:p)` is refused: it chooses a name at run time.
- Built-in calls such as `upper(x)` are sent as `system.builtin.upper(x)`, so no function of the same name in a schema
  can stand in for them. You may write `system.builtin.<name>(…)` yourself.
- Keyword forms (`EXTRACT(YEAR FROM d)`, `TRIM(BOTH 'x' FROM s)`, `POSITION('a' IN s)`, `SUBSTRING(s FROM 2 FOR 3)`,
  `x BETWEEN a AND b`) need the default SQL path; if a read answers `PATH_NOT_DEFAULT`, use the call form
  (`date_part('YEAR', d)`, `btrim(s, 'x')`, `position('a', s)`, `substring(s, 2, 3)`, `x >= a AND x <= b`).
- `LATERAL VIEW explode(arr)` and `FROM range(10)` are allowed; `read_files`, `read_kafka`, `http_request`,
  `remote_query`, `ai_*` and user-defined table functions need a plan; `secret` is refused.
- `TABLE(f(…))` in `FROM`, `VACUUM`, `OPTIMIZE` and other Databricks-only syntax are not in the pinned Spark grammar:
  reads refuse them (`SQL_UNSUPPORTED`) and plans treat them as `run`.
