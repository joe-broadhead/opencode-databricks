# Scripting

Unofficial plugin. Not affiliated with Databricks.

Scripts call the plugin's read tools with no model through the tools RPC, `databricks.databricks.tools`, the source
contract's shared transport:

```sh
opencode api post /api/rpc/databricks.databricks.tools/catalog --data '{ "input": { "sessionID": "<session>", "input": {} } }'
```

A script runs as a session and the agent it names; the rule for the method's action (`databricks.<tool>`) is resolved
before the method runs, and only `allow` runs. The methods are the 14 read tools (`status`, `catalog`, `table`,
`warehouses`, `explain`, `query`, `statement`, `history`, `profile`, `jobs`, `workspace`, `plan`, `events_list`,
`saved_read`), plus `probe` and `saved_list`. The export and change tools are never methods.

Codes the transport itself returns: `SESSION_UNKNOWN`, `SESSION_AGENT_REQUIRED`, `PERMISSION_DENIED`, `CANCELLED` and
`RESOURCE_UNRESOLVED`. The plugin's own codes are in [Errors](errors.md).
