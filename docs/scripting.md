# Scripting

Unofficial plugin. Not affiliated with Databricks.

Scripts call the plugin's read tools with no model through the tools RPC, `databricks.databricks.tools`, the source
contract's shared transport:

```sh
opencode api post /api/rpc/databricks.databricks.tools/status --data '{ "input": { "sessionID": "<session>", "input": {} } }'
```

A script runs as a session and the agent it names; the rule for the method's action (`databricks.<tool>`) is resolved
before the method runs, and only `allow` runs. The methods are the 14 read tools (`status`, `catalog`, `table`,
`warehouses`, `explain`, `query`, `statement`, `history`, `profile`, `jobs`, `workspace`, `plan`, `events_list`,
`saved_read`), plus `probe` and `saved_list`. The export and change tools — including `databricks_stop` and
`databricks_cancel` — are never methods, and neither is `/databricks-cleanup`: a script can report, and a person stops
or cancels.

`status` returns the same shape as the tool (`accounts`, `running`, `spend`, `automation`, `cleanup`); every warehouse
and Query History call it makes is free. `include: ["spend"]` is the exception: it runs one reconciliation statement
through the read path, on a warehouse that is already running, and it is charged like any read.

Codes the transport itself returns: `SESSION_UNKNOWN`, `SESSION_AGENT_REQUIRED`, `PERMISSION_DENIED`, `CANCELLED` and
`RESOURCE_UNRESOLVED`. The plugin's own codes are in [Errors](errors.md).
