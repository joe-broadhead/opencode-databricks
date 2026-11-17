# Architecture

The plugin will call Databricks' REST APIs with `fetch`. This version is the family scaffold.

| File | Role |
|---|---|
| `src/index.ts`, `src/plugin.ts` | `Plugin.define` with the id `databricks.databricks`: default rules, the namespace, status, the tools RPC, skills. |
| `src/domain/errors.ts` | Every code, in the family form, and the docs rows. |
| `src/permissions.ts`, `src/options.ts` | The `access` rules block and every option. |
| `src/rpc.ts`, `src/status.ts`, `src/tui/index.tsx` | `/databricks-status`, the status RPC and the `/databricks` dialog. |
| `src/tools-rpc.ts` | `databricks.databricks.tools`, with no method yet. |
