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

### Removed since v0.0.<n> (4a, pre-4b)

- **The permission-only `databricks.read` action.** plugin-contract v0 has no permission-only action, so the old rule
  no longer applies on its own. The four source reads (`events_list`, `saved_read`, `probe` and `saved_list`) are gated
  by the method actions `databricks.events_list`, `databricks.saved_read`, `databricks.probe` and
  `databricks.saved_list`. Move an old allow, ask or deny rule to those method actions; a blanket deny means denying all
  four. See [docs/security.md](docs/security.md#source-reads).
- **The `databricks.plan` action and the single `plan` tool.** The action is now the six `databricks.plan_*` actions
  (`plan_write`, `plan_delete`, `plan_share`, `plan_export`, `plan_run`, `plan_admin`), and the tool is now those six
  methods, because a v0 planning method is bound to exactly one commit. Move a rule to each planner it should cover; a
  deny on `databricks.plan` alone no longer applies.
- **The commands (`4 → 0`).** `/databricks-status`, `/databricks-doctor`, `/databricks-cleanup` and the TUI
  `/databricks` view are gone: v0 has no command or TUI surface. `status`, `stop` and `cancel` remain methods and tools;
  `status` reports `role-requested`, and a refused `stop` or `cancel` names those methods or asks the warehouse owner.
