// The plugin's fixed facts: its one name, the host range and the tested hosts. No imports: every other module may read it.

/** The plugin's id, tool namespace, RPC id and capability prefix (contract §3). */
export const PLUGIN_NAME = "databricks"
export const PLUGIN_ID = PLUGIN_NAME
export const NAMESPACE = PLUGIN_NAME
/** The name `/connect`, status and the docs show. */
export const DISPLAY_NAME = "Databricks"

/** The OpenCode versions the plugin starts on. Equals capabilities.plugin.host.opencode. */
export const SUPPORTED_HOST = ">=2.4.1 <2.5.0"
/** The OpenCode releases every check runs on. */
export const TESTED_HOSTS: readonly string[] = ["2.4.1"]

/** What the generated access rules allow. */
export const ACCESS_VALUES = ["all", "ask-changes", "read-only"] as const
export type Access = (typeof ACCESS_VALUES)[number]
