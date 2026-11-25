# Changelog

## 0.0.0 (2026-11-25)

### Added

- First release on plugin-contract v0: one `register` call, with 31 methods reachable as agent tools, in Code Mode and
  over RPC — 21 reads, 4 writes, 2 deletes, 1 share, 2 exports and 1 admin.
- Several named accounts through the contract's `accounts` module: one Databricks integration per alias (`databricks`
  for the default account, `databricks-<alias>` otherwise), `account` on every method that takes one, `statusAnswer`
  status, and `changed` bus nudges after provider writes.
- Three sources: `databricks.queries` and `databricks.runs` as event feeds, and `databricks.saved` as a snapshot read
  from a saved SQL query. Event cursors are a total order of end time and external id, so a same-timestamp event is
  never skipped across a page boundary.
- A plan and a commit per class (`plan_write`, `plan_delete`, `plan_share`, `plan_export`, `plan_run`, `plan_admin`),
  and a separate `start` write with effect `ask` for a billed SQL warehouse start.
- Fresh docs, skills and `AGENTS.md`; a conformance fixture with two synthetic accounts; unit tests for the method table,
  access rules, schemas, the read path, both events sources' cursor tie, and the warehouse start.
- Skills are registered at setup through `ctx.skill.transform`, with each `SKILL.md` frontmatter parsed as YAML; the
  real OpenCode 2.4.1 host test proves both `databricks` and `databricks-sql` are listed after load, alongside all 31
  tools.
