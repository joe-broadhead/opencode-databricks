# Costs

Unofficial plugin. Not affiliated with Databricks. Figures are list prices fetched on 17 November 2026; your account's
`system.billing.list_prices` is the authority.

- **The meter is the warehouse, not the query.** A SQL warehouse bills DBUs per hour while it runs, and keeps billing
  while idle until it auto-stops. A query against a stopped warehouse starts it.
- **No silent start.** No call starts a stopped warehouse unless it passes `start: true`, the warehouse is serverless,
  at most `maxStartSize` (`Small`), and auto-stops within `maxStartAutoStopMinutes` (15). The start asserts its own
  action, `databricks.start`.
- **Serverless DBU per hour by size:** 2X-Small 4, X-Small 6, Small 12, Medium 24, Large 40, X-Large 80, 2X-Large 144,
  3X-Large 272, 4X-Large 528. List price about $0.70 per DBU on AWS.
- **Example:** a Small serverless warehouse is about $8.40 an hour; started for one 2-second query with a 10-minute
  auto-stop, it costs about $1.40.
- **Separately billed:** AI functions, Model Serving, and materialized views and streaming tables (pipeline rates).

## The ledger and budgets

The plugin keeps a local estimate in `$XDG_STATE_HOME/opencode-databricks/spend.jsonl`, shared by every OpenCode
process: each start it caused at `auto_stop × DBU/h`, and each statement at `max(duration, min(auto_stop, time since
its previous statement on that warehouse)) × DBU/h × clusters`. It is an estimate, labelled as one. Budgets are
opt-in: `budget: { daily: { starts, dbuHours }, session: { … }, action: "warn" | "refuse" }`; with `refuse`, a start or
statement past the limit is `BUDGET_REACHED`.
