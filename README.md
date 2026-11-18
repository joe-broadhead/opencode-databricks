# Databricks for OpenCode

Connects OpenCode to [Databricks](https://www.databricks.com): Unity Catalog, SQL warehouses, queries, jobs and saved
results, through Databricks' own REST APIs, with every change planned first and every warehouse start visible. No MCP
server is wrapped and no SDK is installed: the plugin calls the documented REST APIs with `fetch` [6][15][24][27][29].

Unofficial; not affiliated with Databricks. The icon is the family's own tile, not Databricks' mark. Databricks is a
trademark of Databricks, Inc.; this unofficial plugin is not endorsed by them.

> **Status.** v0.1.0: 23 tools, three sources, two skills, status, `/databricks-cleanup` and the TUI dialog. The live
> check (design §15.4) has not run, so the Known limits below list what is measured and what is not.

## Requirements

- OpenCode `>=2.2.3 <2.4.0`, tested on 2.2.3, 2.2.4, 2.2.5, 2.2.6, 2.2.7 and 2.3.0. Outside that range the plugin does
  not load, unless you set [`allowUntestedHost`](docs/configuration.md#options).
- macOS or Linux.
- A Databricks workspace on AWS, Azure or GCP, and an OAuth app connection your account admin creates once
  ([Sign in](docs/configuration.md#sign-in)) [11][12]. You need `Can use` on a SQL warehouse, and `USE CATALOG`,
  `USE SCHEMA` and `SELECT` on the data you read [13][38].

## Install

```sh
opencode plugin add github:joe-broadhead/opencode-databricks#v0.1.0
```

Run `opencode reload`, or restart OpenCode. Then run `/databricks-status` in a session.

## What the agent may do

> At Allowed, the agent can change or delete anything your Databricks identity can, after a plan it makes itself.
> For a hard limit, sign in with a read-only role.

The plugin narrows reads as far as it can: a read runs as exactly one query wrapped in `SELECT * FROM (…)`, calls only
an allowlist of built-in functions (each qualified as `system.builtin.<name>`; a function name or a keyword with any
non-ASCII character, and a function named by one or two parts, are refused), and never starts a warehouse unless the
call says `start: true` and the start policy allows it. Those checks are the plugin's own and best-effort; the only
read-only Databricks enforces is your identity's privileges, such as a role with only `SELECT` [13]. A role is
recommended, and `/databricks-doctor` checks what it really allows; a role inherits the grants of the workspace's
`users` group and the account's `account users` group, and workspace users can create objects in the workspace
catalog's `default` schema [13][38]. [Safety](docs/safety.md) says what each layer stops.

The `access` option generates the default rules: `all` (the default) runs every tool without asking; `ask-changes`
asks before each change and each warehouse start; `read-only` denies changes, and reads may still start a small
serverless warehouse that bills until it auto-stops.

## Cost

Queries run on a SQL warehouse your workspace bills by the hour while it runs, and an idle warehouse keeps billing
until it auto-stops [16]. Starting a stopped one bills until it auto-stops, and a query against a stopped warehouse
starts it [18]. A saved-query source (`databricks.saved`) reads only on a warehouse that is already running, which then
stays up until it auto-stops. Unity Catalog reads are free. AI functions and jobs bill separately [21][33].
[Costs](docs/costs.md) has the numbers and their sources.

## Clean up

`databricks_status` lists the statements this plugin started that are still running, and the running warehouses this
plugin started (at most ten, the biggest $ per hour first) with their estimated $ per hour and idle time, each with one
call. `/databricks-cleanup`, typed by you,
reports the same and then stops or cancels what it lists. At Allowed, typing the command is the confirmation and stops
every listed warehouse and cancels every listed read; at Ask before changes each action asks first; at Read only it
reports and takes no action. Your own deny rules still win, action by action, at every level. Nothing in this plugin ever
deletes a table, file, job, warehouse or result. Automation cancels this plugin's own orphaned reads when a session is
deleted or archived, at every access level, because a read has no effects. Stopping a warehouse automatically is not in
v0.1.0, and a stop is only offered for a warehouse the plugin's own start record names (a start in the last 24 hours).
[Costs](docs/costs.md#cleanup) has the details.

## Known limits

- **Privileges are the only server-enforced read-only.** The wrapper, the function allowlist, the dependency checks and
  the fence are the plugin's own, over its own parse of Spark's grammar, and best-effort: Databricks' parser is closed
  and a warehouse channel may differ. Sign in with a role for a hard limit; see [Auth](docs/auth.md#enforcement).
- **A role is weaker than "read-only" sounds.** Roles inherit the grants of `users` and `account users`, and workspace
  users can create objects in the workspace catalog's `default` schema [13][38]. `/databricks-doctor` checks the role's
  own grants and those two inherited groups, on every catalog it can see and on the workspace catalog's `default` schema;
  its claim is exactly: "SQL writes refused on what doctor checked; secret scopes and serving endpoints not checked; job
  runs use each job's Run as identity". Under `all-apis` secret scopes and serving endpoints are reachable, so they block
  the claim. The claim covers only what the doctor checked; schema- and table-level grants outside the `default` schema
  are not part of it.
- **Non-ASCII names are refused.** A function or generator name, or a keyword, with any non-ASCII character is
  `SQL_INVALID`: the plugin cannot prove Databricks reads the name it checked. A user function named by one or two
  parts is `FUNCTION_NAME_PARTIAL`; write `catalog.schema.function`.
- **The dependency set is the union of Unity Catalog's record and the parsed body.** A view's `view_dependencies` and
  its body are both walked; a view whose definition or dependencies Unity Catalog does not return is `NEEDS_PLAN`, not a
  warning [27]. A Python or Scala function, a user-defined table function, a body that is not returned or does not parse,
  and a name the two sources cannot pin all need a plan [28][42].
- **Write `current_date`, not `current_date()`.** The pinned grammar refuses the parenthesised form
  (`SQL_UNSUPPORTED`); the bare keyword is allowed and needs no SQL path. The same holds for `current_timestamp` and
  `current_user`.
- **The parser is Spark's, not Databricks'.** The plugin parses SQL with Apache Spark's grammar at v4.3.0 [41]. Reads
  refuse syntax the grammar lacks (`SQL_UNSUPPORTED`); plans take the statement's own category where the grammar parses
  it, and `run`, the strictest category, where it does not. In practice: `VACUUM`, `OPTIMIZE`, `RESTORE`, `COPY INTO`,
  `REORG` and `FSCK` plan as `run`; `CREATE STREAMING TABLE … AS SELECT` plans as `write`; `CREATE OR REFRESH STREAMING
  TABLE` plans as `run`; `GRANT` plans as `share`.
- **These forms follow the path.** `EXTRACT`, `TRIM(… FROM …)`, `POSITION(… IN …)`, `SUBSTRING(… FROM …)`, `BETWEEN`,
  `FIRST`/`LAST`/`ANY_VALUE(… IGNORE NULLS)` and `LATERAL VIEW` generators cannot be qualified, and neither can
  `count(*)` or a table named by one or two parts, so a read that uses one needs the workspace's default SQL path
  (`PATH_NOT_DEFAULT`). Write `count(1)` and three-part table names to avoid it.
- **A start bills.** There is no per-query cap and no per-user spending stop for SQL warehouses [22]; server-side limits
  are warehouse settings an admin owns. Budgets are opt-in estimates in DBU-hours from list prices, not bills. A
  statement's backstop is `STATEMENT_TIMEOUT`, two days by default [20].
- **Stopping needs Can manage.** Other users' statements are visible only with Can monitor or above, and `Can use`
  includes starting a warehouse [16]. For a person with only Can use, the cleanup report is advisory, and a stop may be
  refused (`STOP_NOT_PERMITTED`).
- **Single-use refresh tokens can sign one of two processes out.** With `enable_single_use_refresh_tokens` (Beta, an
  admin's choice), each refresh invalidates the old refresh token. The plugin serializes refreshes within one process and
  re-reads OpenCode's credential store after a failed read, but two OpenCode processes renewing the same sign-in at the
  same instant can still sign one out (`AUTH_REQUIRED`); sign in again. A cross-process lock is the host's to provide
  [12]. [Auth](docs/auth.md#known-limits) has the details.
- **Headless modes are refused in every engine Jelly runs.** `pat`, `m2m` and `cli` answer `HEADLESS_REFUSED` there
  unless `allowHeadlessInHost` is set: the environment and the CLI are the host's. The detection fails open when Jelly's
  engine handoff never arrived; the environment is then almost empty, so only `cli` could find a binary.
- **Masks and filters run functions you cannot see.** Column masks and row filters set by your admins run their own
  functions on every read; Databricks enforces them, and the plugin cannot see them. A mask may wrap a Python
  function [27]. The plugin shows each column's mask and the table's row filter by name.
- **Status lists statements, not job runs.** Its running list is this plugin's own statements from Query History; job
  runs are `databricks_jobs`' and the runs source's.
- **Results and history are bounded by Databricks.** A statement's results are kept 12 hours [6]. Query History returns
  at most 1,000 rows a page, 30 days a call, and a source cursor older than 30 days is `CURSOR_EXPIRED` [24]. Job runs
  are kept 60 days [29]. `query_id` and the Statement API's `statement_id` are the same UUID by assumption until live
  check L8 confirms it, which is what the ambiguous-submit recovery relies on.
- **Query tags are Public Preview** [24]. The plugin's recovery after an ambiguous submit matches its `oc_call` tag, and
  falls back to the exact wrapped text for a record with no tag.
- **Spend reconciliation is incomplete for 12 hours.** `system.billing.usage` records are "typically available within
  12 hours", and `usage_date` is a UTC date [25]. `include: ["spend"]` says so, and its figure is not a bill.
- **A cleanup stop is offered only for this plugin's own starts.** The ledger's start record (a start in the last 24
  hours) is the evidence. A warehouse started elsewhere is listed by `/databricks-cleanup` with no stop action; use
  `databricks_stop` if you mean to stop it, and your identity needs Can manage [16].
- **Some cell renderings are unverified.** A zone-less `TIMESTAMP` is shown zone-less, in the session's zone, never
  labelled UTC; `BINARY`, `INTERVAL` and `VARIANT` renderings come from hand-written fixtures until live check L8
  records Databricks' own. [Safety](docs/safety.md#known-limits) repeats these.
- **Automation runs only while OpenCode runs.** It cancels this plugin's own orphaned reads at every access level and
  stops no warehouse in v0.1.0. A read whose session ended while OpenCode was not running is left to
  `STATEMENT_TIMEOUT`. The context hook speaks only from a snapshot at most five minutes old.
- **Actions can email people.** A change (`GRANT`, `ALTER … OWNER`, a job run) reaches the people Databricks notifies;
  the plugin cannot see or stop those notifications.

## Troubleshooting

Every error has the form `CODE: What happened. Next step: What to do.`

<!-- errors:start -->
| Code | State | What happened | Next step |
|---|---|---|---|
| `ADMIN_DISABLED` | refused | Admin plans are turned off by this plugin's admin.enabled option. | Set admin.enabled to true, or make the change in Databricks. |
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
| `SESSION_STATEMENT_REFUSED` | refused | SET, SET PATH, RESET, USE, DECLARE, temporary objects and other session statements are refused: the API keeps no session, and a changed path could redirect a function name. | Pass catalog, schema and params on the call instead; for SET TAG, write ALTER … SET TAGS, which plans as run. |
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
- [Safety](docs/safety.md): the read path, the allowlist, dependencies, plans, and where read-only is enforced.
- [Costs](docs/costs.md): warehouse billing, starts, the ledger, budgets and cleanup.
- [Scripting](docs/scripting.md): the tools RPC.
- [In Jelly](docs/jelly.md): the declaration, the relay and the settings.
- [Auth](docs/auth.md): modes, the role and the doctor.
- [Errors](docs/errors.md): every code.
- Contributors: [Architecture](docs/architecture.md), [Ownership](docs/ownership.md), [The parser](docs/parser.md).

## Sources

Databricks facts above are cited to Databricks' documentation, fetched 17 November 2026:

- [6] Statement Execution API — https://docs.databricks.com/api/statement-execution/v1/statement-execution
- [9] OAuth U2M — https://docs.databricks.com/aws/en/dev-tools/auth/oauth-u2m
- [11] Partner and custom OAuth apps — https://docs.databricks.com/aws/en/integrations/enable-disable-oauth
- [12] Custom OAuth App Integration API — https://docs.databricks.com/api/account/customappintegration/create
- [13] RBAC — https://docs.databricks.com/aws/en/security/auth/rbac
- [15] Warehouse object — https://docs.databricks.com/api/warehouses/v1/warehouse/object.md
- [16] Create a SQL warehouse — https://docs.databricks.com/aws/en/compute/sql-warehouse/create
- [18] SQL warehouses — https://docs.databricks.com/aws/en/compute/sql-warehouse/
- [20] STATEMENT_TIMEOUT — https://docs.databricks.com/aws/en/sql/language-manual/parameters/statement_timeout
- [21] Pricing — https://www.databricks.com/product/pricing/databricks-sql
- [22] Budgets — https://docs.databricks.com/aws/en/admin/account-settings/budgets
- [24] Query History API — https://docs.databricks.com/api/query-history/v1/list-queries.md
- [25] System tables — https://docs.databricks.com/aws/en/admin/system-tables
- [27] Unity Catalog tables — https://docs.databricks.com/api/uc-tables/v1/get-table.md
- [28] Unity Catalog functions — https://docs.databricks.com/api/uc-functions/v1/function/object.md
- [29] Jobs runs — https://docs.databricks.com/api/jobs/v2/list-runs.md
- [33] Functions with effects — https://docs.databricks.com/aws/en/sql/language-manual/functions/secret
- [38] Manage privileges — https://docs.databricks.com/aws/en/data-governance/unity-catalog/manage-privileges/
- [41] Spark's SQL grammar — https://github.com/apache/spark/blob/master/sql/api/src/main/antlr4/org/apache/spark/sql/catalyst/parser/SqlBaseLexer.g4
- [42] Unity Catalog Python UDTFs — https://docs.databricks.com/aws/en/udf/udtf-unity-catalog

## License

MIT. The bundle includes third-party code under its own licences, listed in `NOTICE`, including the SQL parser
generated from Apache Spark's grammar (Apache License 2.0).
