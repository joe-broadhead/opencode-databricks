# Changelog

## 0.0.0 (unreleased)

The first release in `we-the-rebel-alliance`: the plugin starts again at `0.0.0`.

### Added

- Unity Catalog reads, SQL warehouses, query, statement, history, profile and save tools, the plan-then-commit change
  tools, the two event sources and the saved-query snapshot, status, the `/databricks-status` command, the
  `/databricks-cleanup` command, `/databricks-doctor`, the tools RPC and the `databricks` and `databricks-sql` skills.

### Changed

- OpenCode `>=2.4.1 <2.5.0`, tested on 2.4.1. The package is `@we-the-rebel-alliance/databricks-plugin`.

### Removed

- The Jelly integration: the hosted-engine refusal, the host-owned refresh marker and the Jelly docs.
- The `context` hook that added a cost line on every request. Cost and idle warehouses stay in `databricks_status`.
- The no-op `strictDependencies` and `autoStopIdleMinutes` options.
