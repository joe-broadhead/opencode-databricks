# Safety

Unofficial plugin. Not affiliated with Databricks.

> At Allowed, the agent can change or delete anything your Databricks identity can, after a plan it makes itself.
> For a hard limit, sign in with a read-only role.

## Where read-only is enforced

| Layer | Who sets it | What it stops | Enforced by |
|---|---|---|---|
| Your identity's privileges: a role with only read grants, or a principal with only `SELECT` | An admin creates the role; you choose it at sign-in | Writes the identity has no privilege for, on tables and through secret scopes (`READ`), connections (`USE CONNECTION`) and serving endpoints (`CAN QUERY`) | **Databricks** [13] |
| The app connection's scopes | Your account admin | Whole API families (jobs, workspace, files) | **Databricks** [12] |
| The `SELECT * FROM (…)` wrapper with no `;` | The plugin, always | Any statement that is not one query | Databricks' parser, over text the plugin builds |
| The function allowlist and dependency checks | The plugin | Secrets, sending data out, separately billed functions | The plugin, on its own parse: best-effort |
| `fence` | You | Tables outside the fence | The plugin: advisory |
| `access` and OpenCode rules | You | The commit tools, warehouse starts, tables your rules deny | OpenCode's permission system |

Column masks and row filters set by your admins run their own functions on every read; Databricks enforces them, and
the plugin cannot see them. A mask may call a Python function [27]. They never widen what you can read, and the plugin
shows each mask and row filter by name, but it cannot check the functions behind them.

## The read path

A read (`databricks_query`, `_profile`, `_explain`, `_save`, table samples and the saved source) is decided before
anything is sent:

1. **Local rules**, on the plugin's own parse of Apache Spark's grammar (v4.3.0) [41]: at most 1 MiB; no `;` except one
   at the end (inside strings and comments too: write a literal semicolon as `chr(59)`); no nested `/*`, no `--` comment
   ending in a backslash, no U+2028 or U+2029; exactly one query; no `IDENTIFIER(…)` [39]; no positional `?`; no
   `TRANSFORM … USING`; no session statement (`SET`, `SET PATH`, `USE`, `DECLARE`, temporary objects).
2. **Functions.** Every call — in `SELECT`, in `FROM`, in `LATERAL VIEW` — is an allowlisted built-in, or a Unity
   Catalog SQL function named in full (`catalog.schema.function`) whose body passes the same checks. A function that is
   not a built-in, named by one or two parts, is refused (`FUNCTION_NAME_PARTIAL`): Databricks would look it up along
   the SQL path, where `system.builtin` and `system.ai` come first, not where the plugin checked it. **Any function,
   generator or keyword written with a non-ASCII character is `SQL_INVALID`**: the plugin will not guess that Databricks
   reads the name it checked. Everything else needs a plan. `secret`, `try_secret` and `list_secrets` are refused
   everywhere; `reflect`, `java_method`, `try_reflect` and script transforms too [33][40].
3. **Dependencies.** Every table reference is resolved with Unity Catalog's `tables.get` [27], and each view's
   **dependencies are the union of what Unity Catalog records (`view_dependencies`) and what its body parses to**:
   both are walked, and a name neither can pin is `NEEDS_PLAN`. A view whose definition or dependencies Unity Catalog
   does not return is `NEEDS_PLAN`, not a warning. A view that depends on a connection or a credential needs a plan.
   A function's body must be returned, parse, and hold no connection or credential; Python and Scala functions, and
   every user-defined table function, need a plan [28][42]. Path reads (`delta.\`…\``) cannot be resolved before the run
   and are refused while a fence or an inline rule applies (`FENCE_UNVERIFIABLE`).
4. **Qualified built-ins.** Each allowlisted call is sent as `system.builtin.<name>`, except a `LATERAL VIEW`
   generator, which Spark accepts with at most two name parts: it is sent as written and needs the default path.
   Databricks resolves a three-part name exactly, so a function of the same name in your schema, or a changed SQL path,
   cannot stand in for it. These forms cannot be qualified, so a read using one runs only while the workspace's SQL path
   keeps `system.builtin` before every user schema (`PATH_NOT_DEFAULT` otherwise): the keyword forms `EXTRACT`,
   `TRIM(BOTH … FROM …)`, `POSITION(… IN …)`, `SUBSTRING(… FROM …)`, `BETWEEN` and `FIRST`/`LAST`/`ANY_VALUE(… IGNORE
   NULLS)`; a `LATERAL VIEW` generator; `count(*)` (write `count(1)`); and a table named by one or two parts. The three
   current-value functions `current_date`, `current_timestamp` and `current_user` are not path-sensitive [43].
5. **The wrapper.** The statement sent is exactly `SELECT * FROM (\n<sql>\n) AS oc_q`. With `wait` at most 50
   seconds, Databricks itself cancels it at the wait [6].

These checks are the plugin's, over its own parse, and best-effort: the grammar is open-source Spark's, and Databricks'
own parser is closed. Your privileges are the guarantee.

## Changes

`databricks_plan` classifies a change by the statement table (`src/domain/statements.ts`), stores a single-use plan
for 300 seconds, and returns a preview. It sends no statement: never `EXPLAIN`, because Spark ran statements during
`EXPLAIN` until SPARK-59689 and SPARK-61554 [41]. `EXECUTE IMMEDIATE`, `CALL` or `IDENTIFIER` anywhere make a plan `run`;
text the grammar cannot parse is `run` too. Where it parses, the statement keeps its own category, which is not always
the strictest: `CREATE STREAMING TABLE … AS SELECT` plans as `write`, `CREATE OR REFRESH STREAMING TABLE` as `run`, and
`GRANT` as `share`. `VACUUM`, `OPTIMIZE`, `RESTORE`, `COPY INTO`, `REORG` and `FSCK` are not in the pinned grammar and plan
as `run`. `DESCRIBE HISTORY` is refused on both paths — a read's `STATEMENT_NOT_READ` and a plan's `CATEGORY_MISMATCH` —
so this version leaves it to the SQL editor. Each category commits only through its own tool.

### What a change's targets are

Every change asserts its own dotted action first, then each target it names, under that action: a table or view as
`<account>:table:<catalog>.<schema>.<object>`, a function as `<account>:function:<c>.<s>.<f>`, a volume as
`<account>:volume:<c>.<s>.<v>`, a registered model as `<account>:model:<c>.<s>.<m>`, and a warehouse edit as
`<account>:warehouse:<id>`. A schema target is asserted as `<account>:table:<c>.<s>.*`, which a rule such as `*.hr.*`
matches; `DROP SCHEMA … CASCADE` and `DROP CATALOG … CASCADE` also list every object they would drop — tables and views,
functions, volumes and registered models — and assert each by name, so a rule that names one of them reaches it. When
such a list cannot be read, or is larger than the plugin will drop in one change, the plan is refused rather than
falling back to the schema or catalog wildcard alone. A name the plugin cannot fully qualify is refused too: Databricks
would resolve it against a default the plugin cannot see.

## Known limits

- **Best-effort, said plainly.** The wrapper is a guarantee over the text the plugin builds; everything past it — the
  allowlist, the dependencies, the fence — is a check over the plugin's own parse of an open-source grammar, and a
  Databricks channel may differ. The server-enforced guarantee is the identity's privileges [13].
- **A role inherits grants.** `users` and `account users` grants, the workspace catalog's `default` schema, and each
  job's Run as identity [13][38]. `/databricks-doctor` checks what it can and words its claim accordingly
  ([Auth](auth.md#enforcement)).
- **A view Unity Catalog will not describe needs a plan.** If `view_definition` or `view_dependencies` is not returned
  to a SELECT-only reader (live check L14), most such views answer `NEEDS_PLAN`. That is stricter than the design's
  "warning by default" and deliberate: the record alone is never enough.
- **`DESCRIBE HISTORY` has no path here.** It is a statement, not a query, so a read refuses it; the statement table
  calls it a read, so a plan refuses it too. Use the SQL editor for Delta history.
- **Some renderings are unverified.** A zone-less `TIMESTAMP` is shown zone-less, in the session's zone; the plugin
  never labels it UTC. `BINARY`, `INTERVAL` and `VARIANT` render as base64, `INTERVAL '…'` and JSON text from
  hand-written fixtures until live check L8 records Databricks' own.
- **No server-side per-query cap.** Databricks has none for the Statement API; the plugin's row, byte and time limits
  are described in [Costs](costs.md).
- **Masks are opaque.** A mask or row filter can run arbitrary functions, including Python; the plugin can name it,
  never inspect it [27].
- **Actions can notify people.** A `GRANT`, an owner change or a job run reaches the people Databricks notifies, and
  the plugin cannot see those notifications.

## Sources

- [6] Statement Execution API — https://docs.databricks.com/api/statement-execution/v1/statement-execution
- [12] Custom OAuth App Integration API — https://docs.databricks.com/api/account/customappintegration/create
- [13] RBAC — https://docs.databricks.com/aws/en/security/auth/rbac
- [27] Unity Catalog tables — https://docs.databricks.com/api/uc-tables/v1/get-table.md
- [28] Unity Catalog functions — https://docs.databricks.com/api/uc-functions/v1/function/object.md
- [33] Functions with effects — https://docs.databricks.com/aws/en/sql/language-manual/functions/secret
- [38] Manage privileges — https://docs.databricks.com/aws/en/data-governance/unity-catalog/manage-privileges/
- [39] IDENTIFIER clause — https://docs.databricks.com/aws/en/sql/language-manual/sql-ref-names-identifier-clause
- [40] read_kafka and reflect — https://docs.databricks.com/aws/en/sql/language-manual/functions/read_kafka
- [41] Spark's SQL grammar and history — https://github.com/apache/spark/blob/master/sql/api/src/main/antlr4/org/apache/spark/sql/catalyst/parser/SqlBaseLexer.g4
- [42] Unity Catalog Python UDTFs — https://docs.databricks.com/aws/en/udf/udtf-unity-catalog
- [43] current_date, current_timestamp, current_user — https://docs.databricks.com/aws/en/sql/language-manual/functions/current_date
