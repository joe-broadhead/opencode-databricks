# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The repository scaffold, in the family's layout: the `jelly` declaration, the build to two self-contained bundles,
  the shared kit (r4.1) and `scripts/check.mjs` as the one check gate.
- The contract: 23 tools under the `databricks` namespace with their input and output schemas, each asserting its
  dotted action `databricks.<tool>`, and the permission-only actions `databricks.start` and `databricks.probe`.
- The error table, in the family form, with the README and docs rows generated from it.
- A SQL parser generated from Apache Spark v4.3.0's grammar with antlr-ng, its Java actions ported by a checked table,
  regenerated and compared on every check, and a differential fuzz against Spark's own parser.
- The read path's local rules: one query in a fixed wrapper, no `;`, no nested comments or line-continued comments,
  no `IDENTIFIER(…)`, no session statements, and every invocation through the built-in allowlist, with allowlisted
  calls qualified as `system.builtin.<name>` and keyword forms held to the default SQL path.
- A user function in a read must be named in full (`catalog.schema.function`): a shorter name resolves along the SQL
  path (`FUNCTION_NAME_PARTIAL`). `LATERAL VIEW` generators stay unqualified, as Spark requires, and need the default
  path.
- The statement table that gives every change its plan category, `databricks_plan` for SQL, and single-use plans that
  commit only through their category's tool.
- The local spend ledger, the `access` option's default rules, the `sources` declaration, and the status skeleton.
- `databricks_save`: a read saved as CSV, JSONL, Parquet or Arrow under the results folder or an allowed root, compared
  as real paths, so a symlinked folder cannot carry a save outside them.
- Three sources for Memory and Jelly: `databricks.queries` (your finished statements) and `databricks.runs` (the
  workspace's finished job runs), each listed once when it ends, and the `databricks.saved` snapshot; `probe` records
  who you are so content reads never read the identity. [Sources](docs/sources.md).
- `databricks_status`: per account the mode, identity, role and enforcement, the granted scopes and the default
  warehouse with its estimated $/hour; this plugin's statements that are running; today's and this session's estimate
  from the ledger, the budget, automation, and a cleanup list with one call for each item. Every call it makes is free,
  except `include: ["spend"]`, which reconciles the estimate with `system.billing.usage` through one read on a warehouse
  that is already running.
- `/databricks-status` and the `/databricks` dialog, from the same computation: the dialog adds the cleanup key, which
  asks the server's `/databricks-cleanup` command.
- `/databricks-cleanup`, typed by a person: it reports running warehouses and this plugin's orphaned statements, and
  every action asserts its own `databricks.stop` or `databricks.cancel` — the host's prompt at Ask before changes, and
  no prompt at Allowed, where the typed command is the confirmation and a person's deny rule still wins. At Read only it
  reports and takes no action. It never deletes, and it never cancels a change statement.
- Automation: when OpenCode reports a session deleted or archived, the plugin cancels the read statements it started for
  it, at every access level. One process owns the idle sweep, through a token lock beside the spend ledger. It stops no
  warehouse in this version.
- The `context` hook: one line, at most 200 characters, on the request's tail only, for a warehouse this plugin started
  that has been left idle; fingerprinted per session, and never touching `system`.
- The two skills, written for the whole plugin: the working skill (discovery, cost, the read path, plans, cleanup, every
  error's next step) and the SQL dialect skill (names, parameters, keyword forms, QUALIFY, time travel, system tables,
  ten worked examples).
- The user docs, every Databricks claim cited (`docs/auth.md`, `configuration.md`, `costs.md`, `safety.md`,
  `scripting.md`, `jelly.md`), and `test/unit/docs.test.ts`, which checks the generated error table, the tool and action
  names, the options, the disclosures, the citations, the Known limits and the cleanup rules.
- `test/host/status.test.ts`: the built plugin registers its tools and both commands, the status RPC answers, the status
  command posts its report, and at Read only the cleanup command reports and acts on nothing.
- `test/unit/automation/skill-examples.test.ts`: every SQL example in the skill, and the working skill's request, run
  through the real read path, the real client and the loopback fake.

### Changed

- The `sources` declaration holds the source-contract v0.2.0 keys a v0.1.x consumer refuses: `readsIdentity` on the
  queries source, and `min` and `conditions` on the saved source's price, which is `$0.70 per DBU` on its own. The
  conditions sentence (each read runs only on a warehouse that is already running, which then stays up until it
  auto-stops) moved to the saved source's scope description and the cost texts. These keys return once Jelly and
  Memory are on source-contract v0.2.0.
- The permission-only action `databricks.read`, allowed at every access, for a bound source's content reads.
- `dist/tui.js` stays unminified, and the build's guard is the family's corrected regex (review of boxd #31, LOW 1 and
  the review of F, request 1): it catches `import a from"x"`, `import"x"`, `export*from"x"` and `export*as n from"x"`
  without matching a `"from"` string, and `test/unit/build-guard.test.ts` pins it.
- The TUI status dialog shows warehouses, spend, automation and cleanup, and its `c` key runs `/databricks-cleanup` on
  the open session; the TUI bundle still carries no zod and no tool code.

### Fixed

- A job run's parameters are sent as run-now 2.2's documented `job_parameters`, not `notebook_params`.
- Review of package F (PR #10):
  - `/databricks-cleanup` asserts every stop and cancel at Allowed as well as at Ask before changes, so a person's own
    deny rule wins at both; a stop is offered only for a warehouse the ledger says this plugin started.
  - Status and cleanup list only the identity's own statements, filtering Query History by the caller, so another
    person's tagged statement is never treated as this plugin's.
  - The context hook names only warehouses this plugin started, and escapes the warehouse name; the idle sweep is the
    owner's alone, and a session that ended with nothing running is no longer reported as a failure.
  - The reconcile statement reads `usage_metadata.warehouse_id`, the documented struct access, and says that
    `system.billing.usage` lags up to 12 hours.
  - The automation lock is a token lock whose holder keeps it, and orphan cancels no longer wait for it.
