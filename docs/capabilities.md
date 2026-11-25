# Capabilities

The plugin declares three sources, no actions, and one bus event.

## Sources

- `databricks.queries` reads your own finished SQL statements from Query History, oldest first, with a cursor bound to
  the account and scope.
- `databricks.runs` reads finished job runs.
- `databricks.saved` is a snapshot of one saved SQL query, read only on a warehouse that is already running.
  `saved_list` offers each query as `id#sha256`; pass that id in the source scope (`scope.queries`), or pass `query`
  and `sha` directly. The sha binds the exact SQL the person saw, and a changed query is refused.

Every source is private: its owner is your Databricks identity. A read never starts a warehouse.

## Methods

- Reads: `status`, `catalog`, `table`, `warehouses`, `explain`, `query`, `statement`, `history`, `profile`, `jobs`,
  `workspace`, `events_list`, `saved_read`, `probe`, `saved_list`, and the six plan methods.
- Writes: `write`, `cancel`, `stop`, `start`.
- Deletes: `delete`, `run`.
- Shares: `share`.
- Exports: `save`, `export`.
- Admin: `admin`.

Each class has its own plan method: `plan_write`, `plan_delete`, `plan_share`, `plan_export`, `plan_run`, `plan_admin`.
A plan answers a preview and the commit method; committing takes only `{ planId }`.

`run` is class `delete`: a SQL script, a job run or a notebook run can change or drop anything its identity can reach,
and its effects are not known before it runs. The stricter class is the safe one.

`start` is class `write` and it is the only method that starts a warehouse. A read or a plan never starts one: a stopped
warehouse refuses with the start method as its next step, so the start's ask and its bill are never hidden inside a
change the person approved for another reason.

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
