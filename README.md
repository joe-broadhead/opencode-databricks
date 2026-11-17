# Databricks for OpenCode

Connects OpenCode to [Databricks](https://www.databricks.com): Unity Catalog, SQL warehouses, queries, jobs and saved
results, through Databricks' own REST APIs, with every change planned first and every warehouse start visible.

Unofficial; not affiliated with Databricks. The icon is the family's own tile, not Databricks' mark.

Databricks is a trademark of Databricks, Inc.; this unofficial plugin is not endorsed by them.

> **Not yet released.** This is v0.0.1 before its first release: the contract (23 tools, their schemas, the errors,
> the permission actions), the SQL parser generated from Spark's grammar, the function allowlist, the statement table,
> the plan store and the spend ledger are in place. `databricks_plan` classifies SQL; every other tool answers
> `NOT_IMPLEMENTED` until it is built. Nothing calls Databricks yet.

## Requirements

- OpenCode `>=2.2.3 <2.4.0`, tested on 2.2.3, 2.2.4, 2.2.5, 2.2.6, 2.2.7 and 2.3.0. Outside that range the plugin does
  not load, unless you set [`allowUntestedHost`](docs/configuration.md#options).
- macOS or Linux.
- A Databricks workspace on AWS, Azure or GCP, and an OAuth app connection your account admin creates once
  ([Sign in](docs/configuration.md#sign-in)). You need `Can use` on a SQL warehouse, and `USE CATALOG`, `USE SCHEMA`
  and `SELECT` on the data you read.

## Install

```sh
opencode plugin add github:joe-broadhead/opencode-databricks#v0.0.1
```

Run `opencode reload`, or restart OpenCode. Then run `/databricks-status` in a session.

## What the agent may do

> At Allowed, the agent can change or delete anything your Databricks identity can, after a plan it makes itself.
> For a hard limit, sign in with a read-only role.

The plugin narrows reads as far as it can: a read runs as exactly one query wrapped in `SELECT * FROM (…)`, calls only
an allowlist of built-in functions (each qualified as `system.builtin.<name>`), and never starts a warehouse unless the
call says `start: true`. Those checks are the plugin's own and best-effort; the only read-only Databricks enforces is
your identity's privileges, such as a role with only `SELECT`. [Safety](docs/safety.md) says what each layer stops.

The `access` option generates the default rules: `all` (the default) runs every tool without asking; `ask-changes`
asks before each change and each warehouse start; `read-only` denies changes, and reads may still start a small
serverless warehouse that bills until it auto-stops.

## Cost

Queries run on a SQL warehouse your workspace bills by the hour while it runs. Starting a stopped one bills until it
auto-stops. Unity Catalog reads are free. AI functions and jobs bill separately. [Costs](docs/costs.md) has the
numbers and their sources.

## Known limits

- **Masks and filters run functions you cannot see.**
  Column masks and row filters set by your admins run their own functions on every read; Databricks enforces them, and the plugin cannot see them.
  A mask may wrap a Python function. The plugin shows each column's mask and the table's row filter by name.
- **The parser is Spark's, not Databricks'.** The plugin parses SQL with Apache Spark's grammar at v4.3.0. Databricks'
  own syntax that Spark lacks (`VACUUM`, `OPTIMIZE`, `COPY INTO`, `GRANT … ON`, `TABLE(f(…))` in `FROM`) is refused in
  reads and plans as `run`, the strictest category.
- **Keyword forms follow the path.** `EXTRACT`, `TRIM(… FROM …)`, `POSITION(… IN …)`, `SUBSTRING(… FROM …)` and similar
  forms cannot be qualified, so a read that uses one needs the workspace's default SQL path (`PATH_NOT_DEFAULT`).
- **Nothing is built yet** beyond `databricks_plan` for SQL (see the note above).

## Troubleshooting

Every error has the form `CODE: What happened. Next step: What to do.`

<!-- errors:start -->
| Code | State | What happened | Next step |
|---|---|---|---|
| `ADMIN_REASON_REQUIRED` | refused | An admin plan needs a reason. | Plan again with reason. |
| `AUTH_CLIENT_INVALID` | refused | Databricks refused the OAuth client, its scopes or its redirect URL. | Check the client ID; for invalid_scope choose the other scope set on the form; app changes can take 30 minutes. |
| `AUTH_REQUIRED` | refused | No usable Databricks credential: none stored, a refresh failed, or the configured role differs from the one bound at sign-in. | Run /connect and choose Databricks, or run opencode auth login databricks-<alias>. |
| `AUTH_SCOPE_MISSING` | refused | The sign-in lacks the API scope this call needs, so Databricks was not called. | Add the feature and sign in again, or ask the admin to allow the scope on the app connection. |
| `BUDGET_REACHED` | refused | An opt-in budget with action refuse is spent. | Wait for the reset, or raise the budget option. |
| `CANCELLED` | failed | The call was stopped, and the statement it started was cancelled. | Call the tool again if you still need the result. |
| `CATEGORY_MISMATCH` | refused | A read was sent to plan, or a plan was committed with another category's tool. | Use the tool the message names. |
| `CLASSIFICATION_DRIFT` | failed | Query History's statement type differed from the plan or the read, and it was recorded. | Report it; databricks_history shows the statement. |
| `DEPENDENCIES_UNKNOWN` | refused | A view's dependencies cannot be resolved while a fence, an inline rule or strictDependencies applies. | Name tables fully and avoid views without recorded dependencies. |
| `EXTERNAL_LINK_REFUSED` | refused | A result link was not https on the cloud's storage host. | Report it; databricks_save falls back only when links are unavailable. |
| `FENCED` | refused | A resolved table is outside the fence, or a permission rule denied it. | Query allowed catalogs only, or change the fence option. |
| `FENCE_UNVERIFIABLE` | refused | A path-based read cannot be checked against the fence. | Read the table by its Unity Catalog name. |
| `FUNCTION_NAME_PARTIAL` | refused | A read calls a function that is not an allowlisted built-in by a one- or two-part name, which Databricks resolves along the SQL path, not where the plugin checks it. | Write the function's full name, catalog.schema.function. |
| `FUNCTION_REFUSED` | refused | reflect, java_method, try_reflect, a script transform or a bucket sample on a function is refused. | Do it another way; these run code outside SQL. |
| `HEADLESS_REFUSED` | refused | A headless mode (pat, m2m or cli) was configured in a hosted engine. | Sign in interactively, or set allowHeadlessInHost. |
| `HOST_INVALID` | refused | The workspace URL is not https, or not a Databricks host. | Enter the workspace URL from the browser, or set allowCustomHost for a private link. |
| `HOST_UNTESTED` | refused | This OpenCode version is outside the tested range. | Use a tested OpenCode release, or set the option allowUntestedHost. |
| `IDENTIFIER_REFUSED` | refused | A read used IDENTIFIER(…), a name chosen at run time. | Write the table or function name literally, and pass values in params. |
| `INLINE_WITHHELD` | refused | This account's inline rules keep these rows out of the conversation. | Run it with databricks_save({ sql }) to write them to a file. |
| `INPUT_INVALID` | refused | The input does not fit the tool's schema. | Check the input against the tool's schema, then call it again. |
| `NEEDS_PLAN` | refused | A read calls a function that is not on the built-in allowlist, a user-defined table function, an external function, or a function whose body cannot be read. | Plan it with databricks_plan({ sql }). |
| `NOT_FOUND` | refused | The catalog, schema, table, function, statement, job or run was not found or is not visible. | Call databricks_catalog with filter to find the name. |
| `NOT_IMPLEMENTED` | refused | This tool is declared but not built in this version. | Use the Databricks SQL editor for now, or update the plugin. |
| `OPTIONS_INVALID` | refused | A plugin option is invalid or unknown. | Fix the plugin's options in opencode.json; the message names the option. |
| `PATH_NOT_DEFAULT` | refused | The workspace's SQL path does not put system.builtin before every user schema, so a keyword-form built-in could resolve to a user function. | Ask an admin to restore the default path, or write the function call form, which the plugin qualifies as system.builtin. |
| `PERMISSION_DENIED` | refused | Unity Catalog or an access control list refused the call. | Ask for the privilege the message names. |
| `PLAN_ALREADY_USED` | refused | That plan was already committed; a plan runs once. | Plan the change again with databricks_plan. |
| `PLAN_CALLER_MISMATCH` | refused | The plan belongs to another session, agent or account. | Plan the change again in this session. |
| `PLAN_CHANGED` | refused | At commit, the category, the targets or the warehouse policy changed. | Plan the change again with databricks_plan. |
| `PLAN_EXPIRED` | refused | The plan is older than planTtlSeconds. | Plan the change again with databricks_plan. |
| `PLAN_NOT_FOUND` | refused | No plan has that id. | Plan the change again with databricks_plan. |
| `RATE_LIMITED` | failed | Databricks answered 429 or REQUEST_LIMIT_EXCEEDED after retries. | Make the same call after retryAfterSec. |
| `RESULTS_EXPIRED` | refused | The statement's results are gone (kept 12 hours) or its links expired beyond re-reading. | Run it again; the result cache may serve it. |
| `RULES_NOT_ADDED` | failed | The default permission rules could not be added to the agents. | Restart OpenCode. |
| `RUN_SIZE_REFUSED` | refused | The warehouse is larger than maxRunSize, so an agent may not run on it. | Use a smaller warehouse, or raise maxRunSize. |
| `RUN_TIMEOUT` | failed | Databricks cancelled the read at its wait, or the plugin did at maxRunSeconds. | Narrow the query, or pass a longer wait (above 50 seconds the limit is the plugin's). |
| `SAVE_EXISTS` | refused | A file already exists at the save path. | Pass overwrite: true, or choose another path. |
| `SAVE_LIMIT` | refused | The result is larger than maxSaveRows or maxSaveBytes; the partial file was removed. | Filter or aggregate the query, or raise the limit. |
| `SAVE_PATH_REFUSED` | refused | The save path is outside the project and allowedRoots. | Save under resultsDir, or add the folder to allowedRoots. |
| `SECRET_FUNCTION_REFUSED` | refused | secret, try_secret and list_secrets are refused. | Do not read secrets through the agent. |
| `SESSION_STATEMENT_REFUSED` | refused | SET, SET PATH, RESET, USE, DECLARE, temporary objects and other session statements are refused: the API keeps no session, and a changed path could redirect a function name. | Pass catalog, schema and params on the call instead. |
| `SKILLS_INVALID` | refused | A packaged skill is missing or malformed. | Reinstall the plugin. |
| `SQL_INVALID` | refused | The plugin's parser or Databricks rejected the SQL. | Fix it; databricks_table lists columns, and databricks_explain checks a read. |
| `SQL_UNSUPPORTED` | refused | The pinned Spark grammar cannot parse this text, so it fails closed. | Rewrite it in standard Spark SQL, or plan it with databricks_plan, where it is category run. |
| `START_REFUSED` | refused | The start policy refuses this warehouse: not serverless, too large, or its auto-stop is too long or off. | Use another warehouse; maxStartSize and maxStartAutoStopMinutes are your options to raise. |
| `STATEMENT_FAILED` | failed | The warehouse ran the statement and it failed. | Fix it as providerError says, or check it with databricks_statement. |
| `STATEMENT_NOT_READ` | refused | A read tool got text that is not one query, has a semicolon, or has a refused construct. | Plan it with databricks_plan({ sql }). |
| `STATEMENT_UNKNOWN` | refused | This version does not classify that statement form. | Run it in the Databricks SQL editor, or update the plugin. |
| `STATUS_UNAVAILABLE` | failed | Status could not be computed right now. | Try again in a few seconds; if it persists, restart OpenCode. |
| `STOP_NOT_PERMITTED` | refused | Stopping needs Can manage, or other users' statements are not visible without Can monitor. | Ask the warehouse's owner to stop it. |
| `UNAVAILABLE` | failed | Databricks or the network failed, or an ambiguous submit was not found in history. | Make the same call later; after an ambiguous submit, check databricks_history first. |
| `WAREHOUSE_FORBIDDEN` | refused | The identity has no Can use permission on the warehouse. | Ask the warehouse's owner for Can use. |
| `WAREHOUSE_REQUIRED` | refused | No SQL warehouse was given or configured. | Call databricks_warehouses({}), then pass warehouse. |
| `WAREHOUSE_STOPPED` | refused | The warehouse is stopped and the call did not ask to start it. | Use a running warehouse, or pass start: true. |
<!-- errors:end -->

## Docs

- [Configuration](docs/configuration.md): options, sign-in, the default rules.
- [Safety](docs/safety.md): the read path, the allowlist, plans, and where read-only is enforced.
- [Costs](docs/costs.md): warehouse billing, starts, the ledger and budgets.
- [Scripting](docs/scripting.md): the tools RPC.
- [In Jelly](docs/jelly.md): the declaration.
- [Errors](docs/errors.md): every code.
- Contributors: [Architecture](docs/architecture.md), [Ownership](docs/ownership.md), [The parser](docs/parser.md).

## License

MIT. The bundle includes third-party code under its own licences, listed in `NOTICE`, including the SQL parser
generated from Apache Spark's grammar (Apache License 2.0).
