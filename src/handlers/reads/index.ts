/**
 * The eight read tools of package C (design §16): `databricks_catalog`, `_table`, `_warehouses`, `_explain`, `_query`,
 * `_statement`, `_history` and `_profile`. `src/registry.ts` wires them into `HANDLERS`; the tools RPC (`src/tools-rpc.ts`)
 * exposes them to scripts from the same handlers, so the model's tool and the script's method cannot drift.
 *
 * Every one of them asserts its own dotted action first (`assertTool`), and every read goes through
 * `prepareRead` (`src/provider/guards/read.ts`) before a statement is sent. `_catalog`, `_warehouses`, `_statement` and
 * `_history` send no statement at all: they are free control-plane reads.
 */
import type { Handlers } from "../types.js"
import catalog from "./catalog.js"
import explain from "./explain.js"
import history from "./history.js"
import profile from "./profile.js"
import query from "./query.js"
import statement from "./statement.js"
import table from "./table.js"
import warehouses from "./warehouses.js"

export const READ_HANDLERS = { catalog, table, warehouses, explain, query, statement, history, profile } as const satisfies Partial<Handlers>

export { catalog, explain, history, profile, query, statement, table, warehouses }
