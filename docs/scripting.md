# Scripting

Unofficial plugin. Not affiliated with Databricks.

Scripts call the plugin's read tools with no model through the tools RPC, `databricks.databricks.tools`, the source
contract's shared transport:

```sh
opencode api post /api/rpc/databricks.databricks.tools/catalog --data '{ "input": { "sessionID": "<session>", "input": {} } }'
```

A script runs as a session and the agent it names; the rule for the method's action is resolved before the method
runs, and only `allow` runs. There is no method yet.

Codes the transport itself returns: `SESSION_UNKNOWN`, `SESSION_AGENT_REQUIRED`, `PERMISSION_DENIED`, `CANCELLED` and
`RESOURCE_UNRESOLVED`. The plugin's own codes are in [Errors](errors.md).
