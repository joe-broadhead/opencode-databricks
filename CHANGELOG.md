# Changelog

## 0.0.0 (2026-11-25)

### Added

- First release on plugin-contract v0: one `register` call, with 31 methods reachable as agent tools, in Code Mode and
  over RPC — 21 reads, 4 writes, 2 deletes, 1 share, 2 exports and 1 admin.
- Several named accounts through the contract's `accounts` module: one Databricks integration per alias, `account` on
  every method that takes one, `statusAnswer` status, and `changed` bus nudges after provider writes.
- Three sources: `databricks.queries` and `databricks.runs` as event feeds, and `databricks.saved` as a snapshot read
  from a saved SQL query. Event cursors are a total order of end time and external id, so a same-timestamp event is
  never skipped across a page boundary.
- A plan and a commit per class (`plan_write`, `plan_delete`, `plan_share`, `plan_export`, `plan_run`, `plan_admin`),
  and a separate `start` write with effect `ask` for a billed SQL warehouse start.
- Fresh docs, skills and `AGENTS.md`; a conformance fixture with two synthetic accounts; unit tests for the method table,
  access rules, schemas, the read path, both events sources' cursor tie, and the warehouse start.
- Skills are registered at setup through `ctx.skill.transform`; the real OpenCode 2.4.1 host test proves both
  `databricks` and `databricks-sql` are listed after load, alongside all 31 tools.

### Removed since v0.0.<n> (4a, pre-4b)

The old v0.0.x tags are gone; the comparison is the 4a merge `bd5a019`. Every removal is deliberate.

- `/databricks-status`, `/databricks-doctor` and the TUI `/databricks` view: plugin-contract v0 has no command or TUI
  surface. `status` remains a method and a tool. A configured role now reports `role-requested`; the doctor's in-memory
  certification is gone because the contract's status shape has no certification field.
- `/databricks-cleanup` and the 120-second orphan-read sweep: v0 registers no session-event listener and no background
  timer after setup. `stop` and `cancel` remain explicit methods, and their refusals name those methods or ask the
  warehouse owner, never the removed command.
- The cost fields in status (spend estimates, the plugin's running statements and cleanup suggestions): the contract's
  `STATUS_SCHEMA` has no cost field. `warehouses` still reports each warehouse's estimated $/hour, and plan previews
  still show cost.
- The per-request cost-line hook: removed in 4a during the move to the contract and not restored; v0 has no per-request
  hook.
- The single `plan` tool: replaced by `plan_write`, `plan_delete`, `plan_share`, `plan_export`, `plan_run` and
  `plan_admin`, because a v0 planning method is bound to exactly one commit method. The six share one classifier; no
  capability was dropped.
- The permission-only `databricks.read` action: v0 has no permission-only action. A rule on `databricks.read` no longer
  applies; move the rule (including a deny) to `databricks.events_list` and `databricks.saved_read`, denying both to
  keep a blanket deny on source reads. The old `databricks.plan` action is now the six `databricks.plan_*` actions;
  move a rule to the planner(s) it should cover, and a deny on `databricks.plan` alone no longer applies.
- The `role` enforcement value: the contract cannot carry a certification, so a configured role reports
  `role-requested`. The role is still assumed at sign-in; the grants it enforces are unchanged.

The default account's integration id changed from `databricks-default` to `databricks`; named aliases keep
`databricks-<alias>`. This is a rename, not a removed mode: `interactive`, `pat`, `m2m` and `cli` all remain.
