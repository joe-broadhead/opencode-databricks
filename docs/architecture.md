# Architecture

The plugin calls Databricks' REST APIs with `fetch` (Statement Execution, Unity Catalog, Warehouses, Query History,
Queries, Jobs, Workspace, Files, SCIM `Me`). It wraps no MCP server. Day 0 holds the contract and the decisions that
need no network; [Ownership](ownership.md) says who builds the rest.

| File | Role |
|---|---|
| `src/index.ts`, `src/plugin.ts` | `Plugin.define` with the id `databricks.databricks`: default rules, the 23 tools, status, the tools RPC, skills. |
| `src/domain/actions.ts` | The tool table: names, classes, dotted actions, permission-only entries, operations, scopes. |
| `src/domain/contract.ts` | Every tool's input and output schema (zod). |
| `src/domain/errors.ts` | Every code, in the family form, and the docs rows. |
| `src/domain/functions.ts` | The built-in allowlist, its exclusions, the keyword forms and the SQL path rule. |
| `src/domain/statements.ts` | The statement table: each statement form to a plan category or a refusal. |
| `src/domain/plans.ts` | Single-use plans and commit routing. |
| `src/domain/cost.ts`, `src/ledger.ts` | DBU table, charge formulas, the local spend ledger. |
| `src/sql/parse.ts`, `src/sql/generated/` | The parser generated from Spark's grammar ([The parser](parser.md)). |
| `src/sql/analyze.ts` | The read path's local rules, the walk over every invocation node, the `system.builtin` qualification. |
| `src/ports.ts` | The ports: Databricks REST, auth, ledger, plans, permissions, clock. |
| `src/registry.ts`, `src/tool-spec.ts` | One handler per tool; the model's tool and the script's method from one spec. |
| `src/permissions.ts`, `src/options.ts` | The `access` rules block and every option. |
| `src/rpc.ts`, `src/status.ts`, `src/tui/index.tsx` | `/databricks-status`, the status RPC and the `/databricks` dialog. |
| `src/tools-rpc.ts` | `databricks.databricks.tools`: the read tools, `probe` and `saved_list` for scripts and sources. |

Every tool returns `{ state, …, error?, message?, next?, warnings? }`; Databricks' text is only ever in
`providerError`, marked untrusted.
