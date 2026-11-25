/**
 * The plugin's ports, as one object every handler receives. The contract's register owns the doors, the account and the
 * permission gate; this object is what the plugin's own provider, read path and accounting need.
 */
import type { Access } from "../constants.js"
import type { Options } from "../options.js"
import type { AuthPort, Clock, DatabricksPort, LedgerPort, ReadGuardPort } from "../ports.js"

export interface Deps {
  readonly options: Options
  readonly access: Access
  readonly auth: AuthPort
  readonly databricks: DatabricksPort
  /** The shared read path: SQL analysis, catalog checks and the warehouse policy. */
  readonly reads: ReadGuardPort
  readonly ledger: LedgerPort
  readonly clock: Clock
}
