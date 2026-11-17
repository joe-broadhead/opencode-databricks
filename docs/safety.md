# Safety

Unofficial plugin. Not affiliated with Databricks.

> At Allowed, the agent can change or delete anything your Databricks identity can, after a plan it makes itself.
> For a hard limit, sign in with a read-only role.

## Where read-only is enforced

| Layer | Who sets it | What it stops | Enforced by |
|---|---|---|---|
| Your identity's privileges: a role with only read grants, or a principal with only `SELECT` | An admin creates the role; you choose it at sign-in | Writes the identity has no privilege for | **Databricks** |
| The app connection's scopes | Your account admin | Whole API families (jobs, workspace, files) | **Databricks** |
| The `SELECT * FROM (…)` wrapper with no `;` | The plugin, always | Any statement that is not one query | Databricks' parser, over text the plugin builds |
| The function allowlist and dependency checks | The plugin | Secrets, sending data out, separately billed functions | The plugin, on its own parse: best-effort |
| `fence` | You | Tables outside the fence | The plugin: advisory |
| `access` and OpenCode rules | You | The commit tools, warehouse starts, tables your rules deny | OpenCode's permission system |

Column masks and row filters set by your admins run their own functions on every read; Databricks enforces them, and
the plugin cannot see them. A mask may call a Python function. They never widen what you can read, and the plugin
shows each mask and row filter by name, but it cannot check the functions behind them.

## The read path

A read (`databricks_query`, `_profile`, `_explain`, `_save`, table samples and the saved source) is decided before
anything is sent:

1. **Local rules**, on the plugin's own parse of Apache Spark's grammar (v4.3.0): at most 1 MiB; no `;` except one at
   the end; no nested `/*`, no `--` comment ending in a backslash, no U+2028 or U+2029; exactly one query; no
   `IDENTIFIER(…)`; no positional `?`; no `TRANSFORM … USING`; no session statement (`SET`, `SET PATH`, `USE`,
   `DECLARE`, temporary objects).
2. **Functions.** Every call — in `SELECT`, in `FROM`, in `LATERAL VIEW` — is an allowlisted built-in, or a Unity
   Catalog SQL function whose body passes the same checks. Everything else needs a plan. `secret`, `try_secret` and
   `list_secrets` are refused everywhere; `reflect` and `java_method` too.
3. **Qualified built-ins.** Each allowlisted call is sent as `system.builtin.<name>`. Databricks resolves a
   three-part name exactly, so a function of the same name in your schema, or a changed SQL path, cannot stand in for
   it. Keyword forms (`EXTRACT`, `TRIM(BOTH … FROM …)`, `POSITION(… IN …)`, `SUBSTRING(… FROM …)`, `BETWEEN`,
   `FIRST(… IGNORE NULLS)`) cannot be qualified, so a read using one runs only while the workspace's SQL path keeps
   `system.builtin` before every user schema (`PATH_NOT_DEFAULT` otherwise). `current_date`, `current_timestamp`
   and `current_user` resolve before the path, as Databricks documents.
4. **The wrapper.** The statement sent is exactly `SELECT * FROM (\n<sql>\n) AS oc_q`. With `wait` at most 50
   seconds, Databricks itself cancels it at the wait.

These checks are the plugin's, over its own parse, and best-effort: the grammar is open-source Spark's, and Databricks'
own parser is closed. Your privileges are the guarantee.

## Changes

`databricks_plan` classifies a change by the statement table (`src/domain/statements.ts`), stores a single-use plan
for 300 seconds, and returns a preview. It sends no statement: never `EXPLAIN`, because Spark ran statements during
`EXPLAIN` until SPARK-59689 and SPARK-61554. `EXECUTE IMMEDIATE`, `CALL` or `IDENTIFIER` anywhere make a plan `run`;
text the grammar cannot parse is `run` too. Each category commits only through its own tool.
