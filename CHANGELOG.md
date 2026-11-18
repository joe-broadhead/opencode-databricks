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

### Changed

- The `sources` declaration holds the source-contract v0.2.0 keys a v0.1.x consumer refuses: `readsIdentity` on the
  queries source, and `min` and `conditions` on the saved source's price, which is `$0.70 per DBU` on its own. The
  conditions sentence (each read runs only on a warehouse that is already running, which then stays up until it
  auto-stops) moved to the saved source's scope description and the cost texts. These keys return once Jelly and
  Memory are on source-contract v0.2.0.
- The permission-only action `databricks.read`, allowed at every access, for a bound source's content reads.

### Fixed

- `databricks.queries` tracks a statement by a 7-character reference (its start second and 12 bits of its id's hash,
  unique within that second) instead of its 22-character id, so about 70 fit the cursor: at 300 statements an hour
  with 5% running 1–6 hours, every statement is listed within 10 minutes of its end, where most waited up to 80.
- A proven lag in Databricks' final states answers one gap per episode, and only when the line passed an untracked
  running item under a shorter hold; the hold then widens to the lag (at most 12 hours), so the episode loses nothing
  more. The model's tool says what was seen in its `message`.
- `databricks.runs` re-walks up to 12,000 runs behind the line before it gives one up, so a workspace with hundreds of
  day-long runs at once no longer gaps.
- A job run's parameters are sent as run-now 2.2's documented `job_parameters`, not `notebook_params`.
