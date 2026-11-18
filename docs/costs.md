# Costs

Unofficial plugin. Not affiliated with Databricks. Figures are list prices fetched on 17 November 2026; your account's
`system.billing.list_prices` is the authority [25].

- **The meter is the warehouse, not the query.** A SQL warehouse bills DBUs per hour while it runs, and keeps billing
  while idle until it auto-stops [16]. A query against a stopped warehouse starts it [18].
- **No silent start.** No call starts a stopped warehouse unless it passes `start: true`, the warehouse is serverless,
  at most `maxStartSize` (`Small`), and auto-stops within `maxStartAutoStopMinutes` (15). The start asserts its own
  action, `databricks.start`. **A start bills until the warehouse auto-stops** [16].
- **Serverless DBU per hour by size:** 2X-Small 4, X-Small 6, Small 12, Medium 24, Large 40, X-Large 80, 2X-Large 144,
  3X-Large 272, 4X-Large 528 [21]. List price about $0.70 per DBU on AWS; Pro and Classic use different instances plus
  cloud VMs, so the plugin's price for them is an estimate [21].
- **Example:** a Small serverless warehouse is about $8.40 an hour; started for one 2-second query with a 10-minute
  auto-stop, it costs about $1.40.
- **Saved-query reads:** the `databricks.saved` source runs each read only on a warehouse that is already running,
  which then stays up until it auto-stops. It never starts one.
- **Auto-stop is the admin's setting.** Serverless defaults to 10 minutes (1 through the API), Pro and Classic to 45;
  the API's default is 120, and `0` never stops [15][16]. Long auto-stops and `0` are reported as `AUTO_STOP_LONG` and
  `AUTO_STOP_OFF`.
- **The server cancels a read at its wait.** Reads with `wait` at most 50 seconds send `on_wait_timeout: CANCEL`, so
  Databricks cancels them at the wait even if the laptop closes [6]. Above 50 seconds the plugin's `maxRunSeconds`
  cancels while it runs, and `STATEMENT_TIMEOUT` (two days by default) is the backstop [20].
- **Separately billed:** AI functions, Model Serving, and materialized views and streaming tables (pipeline rates)
  [21][33]. The plugin answers `NEEDS_PLAN` for the functions it can recognise.
- **Not available server-side:** a per-query DBU or byte cap; a per-user spending stop for SQL warehouses (budgets are
  alerts, and "block usage" is for Unity Gateway and Genie only) [22]; a way to use a warehouse without being able to
  start it, since `Can use` includes starting [16].

## The ledger and budgets

The plugin keeps a local estimate in `$XDG_STATE_HOME/opencode-databricks/spend.jsonl`, shared by every OpenCode
process: each start it caused at `auto_stop × DBU/h × clusters`, and each statement at
`max(duration, min(auto_stop, time since its previous statement on that warehouse)) × DBU/h × clusters`. It is an
estimate, labelled as one. Budgets are opt-in: `budget: { daily: { starts, dbuHours }, session: { … }, action: "warn" |
"refuse" }`; with `refuse`, a start or statement past the limit is `BUDGET_REACHED`.

`databricks_status({ include: ["spend"] })` reconciles the estimate with `system.billing.usage` for the default
warehouse today, when your identity has the grants [25]. That is one statement through the read path, on a warehouse
that is already running (it never starts one), and it is charged like any read. Without grants it reports a problem
instead of a figure.

## Cleanup

What bills while nobody is looking [16][18][20][29]:

1. **Running SQL warehouses**, until auto-stop — up to 120 minutes by API default, or never with `0`.
2. **All-purpose clusters**, until autotermination. This plugin does not create them and does not list them.
3. **Job runs**, until they finish or time out; a submitted notebook run always carries a `timeout_seconds`.
4. **Statements this plugin started** that nobody is reading. They keep a warehouse up until their statement timeout.

The layers, and who acts:

| Layer | What happens | Consent |
|---|---|---|
| Server | Auto-stop and `statement_timeout`, set by admins. Status flags `AUTO_STOP_OFF` and `AUTO_STOP_LONG`. | The admin's |
| Automation, while OpenCode runs | Cancels **this plugin's own orphaned reads** when OpenCode reports a session deleted or archived. Never cancels a change statement or a job run, never stops a warehouse, never deletes anything. | Always: a read has no effects |
| Status and the skill | `databricks_status` lists running statements and every running warehouse with its estimated $/hour and idle time, each with one call (at most ten suggestions, the biggest $/hour first); the context hook says one line when a warehouse has been idle for `autoStopIdleMinutes`. | — |
| You | `/databricks-cleanup` reports the same and then stops or cancels what you confirm. At `ask-changes` each action is a permission prompt only you answer; at `read-only` it reports and does nothing. | The typed command, plus the prompt at `ask-changes` |
| Tools | `databricks_stop` and `databricks_cancel` are ordinary tools with the access rules. `databricks_stop` refuses while another user's statement is visible as running, and has no `force`. | `access` and your rules |

**Stopping needs Can manage**, and other users' statements are visible only with Can monitor or above [16]. Without
them the report counts only the statements you can see, a stop may be refused (`STOP_NOT_PERMITTED`), and the report is
advisory. **No warehouse is stopped automatically in v0.1.0**: automation keeps no record of which warehouses this
plugin started, and stopping one it did not start is not allowed. Use `/databricks-cleanup` or `databricks_stop`.

Nothing in any layer deletes a table, file, job, warehouse or result.

## Sources

- [6] Statement Execution API — https://docs.databricks.com/api/statement-execution/v1/statement-execution
- [15] Warehouse object — https://docs.databricks.com/api/warehouses/v1/warehouse/object.md
- [16] Create a SQL warehouse — https://docs.databricks.com/aws/en/compute/sql-warehouse/create
- [18] SQL warehouses — https://docs.databricks.com/aws/en/compute/sql-warehouse/
- [20] STATEMENT_TIMEOUT — https://docs.databricks.com/aws/en/sql/language-manual/parameters/statement_timeout
- [21] Pricing — https://www.databricks.com/product/pricing/databricks-sql
- [22] Budgets — https://docs.databricks.com/aws/en/admin/account-settings/budgets
- [25] System tables — https://docs.databricks.com/aws/en/admin/system-tables
- [29] Jobs runs — https://docs.databricks.com/api/jobs/v2/list-runs.md
- [33] Functions with effects — https://docs.databricks.com/aws/en/sql/language-manual/functions/secret
