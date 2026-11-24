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

- The hosted-engine sign-in plumbing and its docs. The host-held refresh marker is kept and refused before any
  request, so a sign-in the host holds fails with a clear needs-sign-in error instead of a token request.
- The `context` hook that added a cost line on every request. Cost stays in `databricks_status`, which lists this
  plugin's running statements and the warehouses it started with their idle time and $/hour.
- The no-op `strictDependencies`, `autoStopIdleMinutes` and `maxConcurrentStatements` options.
