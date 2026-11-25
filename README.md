# Databricks plugin

Databricks for OpenCode: Unity Catalog, SQL warehouses, queries, jobs and saved results, through the plugin contract.
The plugin reads with your Databricks identity and never starts a warehouse unless you call `databricks.start`.

## Install

```sh
opencode plugin add github:we-the-rebel-alliance/databricks-plugin#vX.Y.Z
```

Replace `vX.Y.Z` with a published tag; the first release is `v0.0.0`. The plugin needs OpenCode 2.4.1 (the tested release). An unsupported release refuses with `HOST_UNTESTED`; set
`allowUntestedHost: true` only to try one.

## Sign in

The plugin holds the credentials, one OpenCode integration per account alias. With one account, sign in with
`/connect` and choose Databricks. With several, each alias is `databricks-<alias>`; see [docs/accounts.md](docs/accounts.md).

## Access levels

`access` is one of `all` (the default), `ask-changes` or `read-only`. Reads run at every level. Writes, deletes, shares
and exports run, ask or are refused according to the level. `databricks.start` is a write: it asks at `ask-changes` and
never runs at `read-only`.

<!-- generated:capabilities -->
### Methods

| Method | Class | Accounts | Operations |
|---|---|---|---|
| `status` | read | none | `scim.me.get`, `sql.warehouses.list`, `sql.warehouses.get`, `sql.history.queries.list` |
| `catalog` | read | optional | `unity-catalog.catalogs.list`, `unity-catalog.schemas.list`, `unity-catalog.tables.list`, `unity-catalog.functions.list`, `unity-catalog.volumes.list` |
| `table` | read | optional | `unity-catalog.tables.get`, `unity-catalog.functions.get`, `sql.warehouses.get`, `sql.statements.query` |
| `warehouses` | read | optional | `sql.warehouses.list` |
| `explain` | read | optional | `unity-catalog.tables.get`, `unity-catalog.functions.get`, `sql.warehouses.get`, `sql.statements.query` |
| `query` | read | optional | `unity-catalog.tables.get`, `unity-catalog.functions.get`, `sql.warehouses.get`, `sql.statements.query` |
| `statement` | read | optional | `sql.statements.get`, `sql.statements.cancel` |
| `history` | read | optional | `scim.me.get`, `sql.history.queries.list` |
| `profile` | read | optional | `unity-catalog.tables.get`, `unity-catalog.functions.get`, `sql.warehouses.get`, `sql.statements.query` |
| `jobs` | read | optional | `jobs.jobs.list`, `jobs.runs.list`, `jobs.runs.get`, `jobs.runs.output.get` |
| `workspace` | read | optional | `workspace.objects.list`, `workspace.objects.get`, `files.directories.list` |
| `plan_write` | read | optional | `unity-catalog.tables.get`, `unity-catalog.schemas.list`, `unity-catalog.tables.list`, `unity-catalog.functions.list`, `unity-catalog.volumes.list`, `unity-catalog.registered-models.list`, `sql.warehouses.get`, `jobs.jobs.get`, `workspace.objects.list` |
| `plan_delete` | read | optional | `unity-catalog.tables.get`, `unity-catalog.schemas.list`, `unity-catalog.tables.list`, `unity-catalog.functions.list`, `unity-catalog.volumes.list`, `unity-catalog.registered-models.list`, `sql.warehouses.get`, `jobs.jobs.get`, `workspace.objects.list` |
| `plan_share` | read | optional | `unity-catalog.tables.get`, `unity-catalog.schemas.list`, `unity-catalog.tables.list`, `unity-catalog.functions.list`, `unity-catalog.volumes.list`, `unity-catalog.registered-models.list`, `sql.warehouses.get`, `jobs.jobs.get`, `workspace.objects.list` |
| `plan_export` | read | optional | `unity-catalog.tables.get`, `unity-catalog.schemas.list`, `unity-catalog.tables.list`, `unity-catalog.functions.list`, `unity-catalog.volumes.list`, `unity-catalog.registered-models.list`, `sql.warehouses.get`, `jobs.jobs.get`, `workspace.objects.list` |
| `plan_run` | read | optional | `unity-catalog.tables.get`, `unity-catalog.schemas.list`, `unity-catalog.tables.list`, `unity-catalog.functions.list`, `unity-catalog.volumes.list`, `unity-catalog.registered-models.list`, `sql.warehouses.get`, `jobs.jobs.get`, `workspace.objects.list` |
| `plan_admin` | read | optional | `unity-catalog.tables.get`, `unity-catalog.schemas.list`, `unity-catalog.tables.list`, `unity-catalog.functions.list`, `unity-catalog.volumes.list`, `unity-catalog.registered-models.list`, `sql.warehouses.get`, `jobs.jobs.get`, `workspace.objects.list` |
| `events_list` | read | optional | `sql.history.queries.list`, `scim.me.get`, `jobs.runs.list`, `jobs.runs.get` |
| `saved_read` | read | optional | `sql.queries.get`, `sql.warehouses.get`, `sql.statements.query`, `sql.statements.get`, `scim.me.get` |
| `save` | export | optional | `unity-catalog.tables.get`, `unity-catalog.functions.get`, `sql.warehouses.get`, `sql.statements.query`, `sql.statements.get` |
| `write` | write | optional | `unity-catalog.tables.get`, `unity-catalog.tables.list`, `unity-catalog.schemas.list`, `unity-catalog.functions.list`, `unity-catalog.functions.get`, `unity-catalog.volumes.list`, `unity-catalog.registered-models.list`, `sql.warehouses.get`, `sql.history.queries.list`, `sql.statements.change` |
| `delete` | delete | optional | `unity-catalog.tables.get`, `unity-catalog.tables.list`, `unity-catalog.schemas.list`, `unity-catalog.functions.list`, `unity-catalog.functions.get`, `unity-catalog.volumes.list`, `unity-catalog.registered-models.list`, `sql.warehouses.get`, `sql.history.queries.list`, `sql.statements.change` |
| `share` | share | optional | `unity-catalog.tables.get`, `unity-catalog.tables.list`, `unity-catalog.schemas.list`, `unity-catalog.functions.list`, `unity-catalog.functions.get`, `unity-catalog.volumes.list`, `unity-catalog.registered-models.list`, `sql.warehouses.get`, `sql.history.queries.list`, `sql.statements.change` |
| `export` | export | optional | `unity-catalog.tables.get`, `unity-catalog.tables.list`, `unity-catalog.schemas.list`, `unity-catalog.functions.list`, `unity-catalog.functions.get`, `unity-catalog.volumes.list`, `unity-catalog.registered-models.list`, `sql.warehouses.get`, `sql.history.queries.list`, `sql.statements.change` |
| `run` | delete | optional | `unity-catalog.tables.get`, `unity-catalog.tables.list`, `unity-catalog.schemas.list`, `unity-catalog.functions.list`, `unity-catalog.functions.get`, `unity-catalog.volumes.list`, `unity-catalog.registered-models.list`, `sql.warehouses.get`, `sql.history.queries.list`, `sql.statements.change`, `jobs.jobs.get`, `jobs.jobs.runNow`, `jobs.runs.submit` |
| `admin` | admin | optional | `unity-catalog.tables.get`, `unity-catalog.tables.list`, `unity-catalog.schemas.list`, `unity-catalog.functions.list`, `unity-catalog.functions.get`, `unity-catalog.volumes.list`, `unity-catalog.registered-models.list`, `sql.warehouses.get`, `sql.history.queries.list`, `sql.statements.change`, `sql.warehouses.edit` |
| `cancel` | write | optional | `sql.statements.get`, `sql.statements.cancel`, `jobs.runs.cancel`, `scim.me.get`, `sql.history.queries.list`, `jobs.runs.get` |
| `stop` | write | optional | `sql.warehouses.get`, `scim.me.get`, `sql.history.queries.list`, `sql.warehouses.stop` |
| `start` | write | optional | `sql.warehouses.get`, `sql.warehouses.start` |
| `probe` | read | optional | `scim.me.get` |
| `saved_list` | read | optional | `sql.queries.list` |

### Sources

| Source | Kind | Reads or output | Method | Cost |
|---|---|---|---|---|
| `databricks.queries` | events | `x-databricks/query` | `events_list` | free |
| `databricks.runs` | events | `x-databricks/run` | `events_list` | free |
| `databricks.saved` | snapshot | `table` | `saved_read` | billed |

### Actions

None.

### Bus events

`rpc.databricks.changed`
<!-- /generated:capabilities -->

## Errors

Every failure reads `CODE: What happened. Next step: What to do.`

<!-- generated:errors -->
| Code | Meaning |
|---|---|
| `NEEDS_SIGN_IN` | the account is not signed in |
| `SCOPE_MISSING` | the call needs a scope the person has not confirmed |
| `ACCOUNT_REQUIRED` | the plugin serves several accounts and the call names none |
| `ACCOUNT_UNKNOWN` | the call names an alias the plugin does not serve |
| `ACCOUNT_MISMATCH` | the item belongs to another account |
| `CURSOR_INVALID` | the cursor is malformed, or belongs to another source, account or scope |
| `CURSOR_EXPIRED` | the provider no longer keeps the history the cursor names |
| `RATE_LIMITED` | the provider asked the plugin to slow down |
| `BUDGET_EXCEEDED` | the read would cost more than the person allows |
| `SOURCE_DISABLED` | the person turned this source or action off |
| `TOO_LARGE` | the answer is larger than the source's maxBytes |
| `INPUT_INVALID` | the input does not match the method's schema |
| `SOURCE_UNKNOWN` | the plugin declares no such source |
| `SCHEMA_VIOLATION` | an answer does not keep the contract's shape |
| `PERMISSION_DENIED` | the person's grant does not cover the call |
| `PLAN_INVALID` | the plan is missing, or belongs to another method |
| `PLAN_USED` | the plan was already used by an earlier commit |
| `GRANT_INVALID` | the action grant did not verify, or was already spent |
| `HOST_UNTESTED` | OpenCode is outside the plugin's tested range |
| `OPTIONS_INVALID` | the plugin's options do not match their schema |
| `UNAVAILABLE` | the provider could not be reached |
<!-- /generated:errors -->

## Documentation

- [Capabilities](docs/capabilities.md)
- [Accounts](docs/accounts.md)
- [Configuration](docs/configuration.md)
- [Architecture](docs/architecture.md)
- [Security](docs/security.md)
- [Automations](docs/automations.md)
