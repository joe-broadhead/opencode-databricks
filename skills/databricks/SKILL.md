---
name: databricks
description: Use for Databricks reads and changes: browse Unity Catalog, run read-only SQL, read Query History and jobs, read saved queries, and plan then commit writes. A warehouse start is its own asked method.
---

# Databricks

Pick the account first: every method takes `account` when the plugin has more than one alias. `databricks.probe`
answers the alias and its owner without reading content.

## Read

- `databricks.catalog`, `databricks.table`, `databricks.warehouses` are free control-plane reads.
- `databricks.query` runs one read through the guarded read path; `databricks.explain` validates it without running it.
- `databricks.statement` reads one statement's state and next chunk.
- `databricks.history`, `databricks.jobs` and `databricks.workspace` read Query History, jobs and workspace paths.
- `databricks.events_list` reads the `databricks.queries` and `databricks.runs` event sources.

A read never starts a warehouse. If the warehouse is stopped, call `databricks.start` first; it is a write with effect
`ask`, so it asks at every level where it may run. At `read-only` it is refused.

## Change

Each class has its own plan method and commit method:

| Plan | Commit |
|---|---|
| `databricks.plan_write` | `databricks.write` |
| `databricks.plan_delete` | `databricks.delete` |
| `databricks.plan_share` | `databricks.share` |
| `databricks.plan_export` | `databricks.export` |
| `databricks.plan_run` | `databricks.run` |
| `databricks.plan_admin` | `databricks.admin` |

A plan answers a preview; show it, then call the commit with `{ planId }` and nothing else. A plan commits once and
expires after 15 minutes. If a change is refused as another class, use that class's plan.

`databricks.save` writes a query's full result to a file under the results directory; it is an export.
`databricks.cancel` and `databricks.stop` act on what this account started.

## Errors

Every failure is `CODE: What happened. Next step: What to do.` Read the next step. `NEEDS_SIGN_IN` means sign in to
that alias; `PLAN_INVALID` means plan again; `PERMISSION_DENIED` means the access level or the person's rules refused.
