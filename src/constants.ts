// The plugin's fixed facts: its ids, the host range and the tested hosts. No imports at all: scripts/check.mjs loads
// this file with Node's type stripping, so it may hold only erasable TypeScript.

/** The plugin's id: its status RPC, and the prefix of its tools RPC (`databricks.databricks.tools`). */
export const PLUGIN_ID = "databricks.databricks"
/** The namespace: engine tools are `databricks_<tool>`, permission actions `databricks.<tool>`. */
export const NAMESPACE = "databricks"
/** The name `/connect`, status and the docs show. */
export const DISPLAY_NAME = "Databricks"
/** The integration of one account is `databricks-<alias>` (design §3.2). */
export const INTEGRATION_PREFIX = "databricks-"

/** What the generated default rules allow. `all` is the default (OD-29); the other two restrict the plugin. */
export const ACCESS_VALUES = ["all", "ask-changes", "read-only"] as const
export type Access = (typeof ACCESS_VALUES)[number]

/** The OpenCode versions the plugin starts on. Equals `opencode.host` in package.json. */
export const SUPPORTED_HOST = ">=2.2.3 <2.4.0"
/** The OpenCode releases every check runs on: the one list. Status calls only these "tested". */
export const TESTED_HOSTS: readonly string[] = ["2.2.3", "2.2.4", "2.2.5", "2.2.6", "2.2.7", "2.3.0", "2.3.1", "2.3.2"]
