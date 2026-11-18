# Ownership: who edits which file

Day 0 fixed the contract; packages A to F build on it in parallel (design §16). Each file has one owner. A package
edits only its own files, adds new files only under its own folders, and wires a finished handler into
`src/registry.ts` with a one-line change to `HANDLERS` (the only shared edit, merged in package order). A change to a
**contract** file needs a review of the contract and lands as its own pull request before the packages that use it.

## Contract files (Day 0; change only with a contract review)

| File | What it fixes |
|---|---|
| `src/constants.ts` | ids, namespace, host range, tested hosts |
| `src/domain/actions.ts` | the 23 tools, their classes, the dotted actions, the three permission-only entries, operations and scopes |
| `src/domain/contract.ts` | every tool's input and output schema; the two disclosures |
| `src/domain/errors.ts` | every code, warning and the family error form |
| `src/domain/functions.ts`, `src/domain/builtins.generated.ts`, `grammar/databricks/` | the allowlist, the exclusions, the keyword forms, the path rule |
| `src/domain/statements.ts` | the statement table and the token rules |
| `src/domain/plans.ts` | the plan store and commit routing |
| `src/domain/cost.ts`, `src/ledger.ts` | DBU table, charge formulas, the spend ledger |
| `src/ports.ts` | every port |
| `src/sql/` (`parse.ts`, `analyze.ts`, `generated/`), `grammar/spark/`, `grammar/port.mjs`, `scripts/generate-*.mjs` | the parser, the read path's local rules, the walk |
| `src/permissions.ts`, `src/options.ts` | the default rules, every option |
| `package.json` (`jelly`, `sources`, `opencode`) | the declaration |
| `test/fake/ports.ts`, `test/fake/databricks.ts` (interface) | the fakes and the fake server's interface |

## Package files

| Package | Owns (edits only these; adds files only under these folders) | Wires |
|---|---|---|
| **A. Auth** | `src/auth/**`, `test/unit/auth/**`, `test/host/auth.test.ts`, `skills/` sign-in sections are F's | `plugin.ts`: the `auth` seam's default (one line) |
| **B. Runtime** | `src/process/**` (http, statements client, chunks, links, values), `test/fake/databricks-server.ts` (the implementation of the fake's interface), `test/fixtures/databricks/**`, `scripts/capture-fixtures.mjs`, `test/unit/runtime/**` | `plugin.ts`: the `databricks` seam's default (one line) |
| **C. Reads and guards** | `src/tools/reads/**` (`catalog`, `table`, `warehouses`, `explain`, `query`, `statement`, `history`, `profile`), `src/guards/**` (read path steps 3–7, dependencies, fence, inline, warehouse policy, budget use), `test/unit/reads/**`, `test/unit/guards/**` | `HANDLERS` entries for its eight tools |
| **D. Changes and runs** | `src/tools/changes/**` (`plan` beyond SQL, the six commit tools, `cancel`, `stop`, `jobs`, `workspace`), `src/drift.ts`, `test/unit/changes/**`, `test/host/access.test.ts` | `HANDLERS` entries for its tools |
| **E. Files and sources** | `src/tools/save/**`, `src/sources/**` (`events_list`, `saved_read`, `saved_list`, `probe`), `test/conformance/**` (beyond `declaration.test.ts`), `test/unit/save/**`, `test/unit/sources/**` | `HANDLERS` entries; `src/tools-rpc.ts` `sourceMethod` bodies |
| **F. Status, cleanup, skills, docs** | `src/status.ts`, `src/rpc.ts`, `src/tui/**`, `src/automation/**`, `src/hooks/**`, `skills/**`, `README.md`, `docs/**` except this file and `docs/parser.md`, `CHANGELOG.md`, `test/unit/docs.test.ts`, `test/host/status.test.ts` | `plugin.ts`: status and automation registration |

## Rules for every package

- Every tool asserts its own dotted action first (`assertTool` in `src/registry.ts`), then any table
  (`<account>:table:<c>.<s>.<t>`) or warehouse (`<account>:warehouse:<id>`) resource, before any Databricks call.
  `test/unit/registry.test.ts` checks asserted equals declared.
- A read sends only `analyzeRead(sql).sent` (`src/sql/analyze.ts`). A read whose `pathSensitive` is not empty runs
  `SELECT system.builtin.current_path()` once per account and warehouse (cached 5 minutes) and refuses
  `PATH_NOT_DEFAULT` unless `pathIsSafe` (`src/domain/functions.ts`). Keyword forms, `LATERAL VIEW` generators,
  `count(*)` and unqualified table names are path-sensitive.
- `userFunctions` holds only three-part names outside the `system` catalog: a non-built-in function named by one or
  two parts is refused by `analyzeRead` (`FUNCTION_NAME_PARTIAL`), and any `system.*` name that is not an allowlisted
  built-in, such as a built-in added after the pin, is `NEEDS_PLAN` there. A function name, generator name or keyword
  written with a non-ASCII character is refused (`SQL_INVALID`), so every name C sees is ASCII. Package C checks
  each user function under design §5.4 and sends it as written; **a function Unity Catalog does not return (not
  found, or not visible) is `NEEDS_PLAN`**, and C's tests pin that.
- The read path is one entry point, `ReadGuardPort.prepare` (`src/ports.ts`), which package C implements in
  `src/guards/read.ts`. Every read tool, and package E's `saved_read` and `save`, call it; E builds against
  `FakeReads` (`test/fake/ports.ts`) until C lands.
- A plan's category comes only from `classifyPlan` (`src/domain/statements.ts`); nothing lowers it.
- Errors are `DatabricksError(code)` from the one table; Databricks' text goes only in `providerError`.
- No package adds a runtime dependency. A new devDependency is pinned exactly and, if bundled, appears in `NOTICE`.

## Contract amendments

Accepted requests from the packages' reviews, landed here by the contract keeper.

| From | Change | Who uses it |
|---|---|---|
| Review of C (#4), request 1 | `plugin.ts` builds `base` (every port but `reads`), then `reads: placeholderReads(base)`. C replaces that one call with `createReadGuard(base)` and deletes `placeholderReads`. | C |
| Review of C, request 2 | `DatabricksPort.listTagAssignments` (`unity-catalog.tag-assignments.list`). | B builds it; C matches `inline.piiTags`, refusing with `DEPENDENCIES_UNKNOWN` until both land |
| Review of C, request 3 | `TableInfo.partitionColumns`, from the columns' `partition_index`. | B maps it; C shows it |
| Review of C, request 4 | `PreparedRead.warehouse` (the running warehouse); `FakeReads` returns `FAKE_WAREHOUSE`. | C returns it; E charges statements from it |
| Review of C, request 5 | Codes `INLINE_WITHHELD` (not `FENCED`) and `RUN_SIZE_REFUSED` (not `START_REFUSED`); warnings `BUDGET_OVER` and `PATH_READ`; a `null` parameter is sent without `value`. | C; B for parameters |
| Review of C, request 6 | `test/unit/registry.test.ts` counts Databricks calls before a tool's first assert (zero); `test/host/plugin.test.ts` accepts `NOT_IMPLEMENTED` or `AUTH_REQUIRED` for a read. | every package |
| Review of C, M1 (Day 0 part) | `FunctionInfo.sqlPath` (UC `sql_path`). | B maps it; C gates function bodies on `pathIsSafe(sqlPath)` |
| Review of C, LOW 3 | `ReadRequest.wait`, the call's own wait for a STARTING warehouse. | C |
| Review of B (#3), request 1 | `FakeState` gains `queries`, `volumes`, `workspace`, `notebooks`, `directories` and `jobs` maps (and `chunks`, for H1). | B's fake; D, E and F's tests |
| Review of B, request 2 | `DatabricksPort.waitForStatement(account, statementId, { untilMs }, signal)`. | B builds it; C and D wait through the port |
| Review of B, request 3 (rejected as asked) | No `fromCache` on `StatementAnswer`. Instead `HistoryQuery.cacheQueryId`, and `history`'s filter takes `statementIds` and `includeMetrics`. | B; E for L5 |
| Review of B, request 4 | `fetchLink(account, link, signal)`: the link host is checked against that account's cloud. | B; E |
| Review of B, request 5 | `DatabricksError.retryAfterSec` (a fifth constructor argument), carried into the result as `retryAfterSec`. | B sets it on RATE_LIMITED |
| Review of B, H1 | `getChunk` answers `ChunkAnswer`, the documented top-level chunk shape, with no state or statement id. | B; E |
| Review of A (#5), ruling 1 (in part) | `DatabricksPort.listConnections`, `currentMetastoreAssignment`, and `effectivePermissions(…, principal?)` (B pages to the end), with their `unity-catalog.*` operations; `Identity.groups`. Not taken: REST reads of secret scopes, serving endpoints and job permissions (their scopes also carry writes). Without the `jobs` scope the jobs family is OK; with it, and secrets and serving always, NOT_CHECKED. | B builds them; A's doctor |
| Review of A, ruling 2 | `AccountInfo.enforcement` (the `Enforcement` type), raised to `"role"` only by an in-memory doctor report bound to (host, role group, granted scopes); `Token.host`. Decision (a): under fine scopes `"role"` is earned over the Unity Catalog checks, worded `ROLE_ENFORCEMENT_TEXT` ("SQL writes refused on what doctor checked; secret scopes and serving endpoints not checked; job runs use each job's Run as identity"); under `all-apis` secret scopes and serving endpoints stay NOT_CHECKED and block it. | A computes it; B sends to `token.host`; C and F read it |
| Review of D (#7), request 1 | `DatabricksPort.getJob` answers `JobInfo`: each task's `JobCompute` (`serverless`, `job-cluster` with node type, workers or autoscale, or `existing` all-purpose cluster) and `timeoutSeconds` (0 is no timeout); operation `jobs.jobs.get`. | B builds it from the get-job page (the client answers NOT_IMPLEMENTED until then); D's job preview and fingerprint |
| Review of D, request 2 | `DatabricksPort.editWarehouse(…, WarehouseEdit)` (`clusterSize`, `autoStopMins`, `minNumClusters`, `maxNumClusters`; never `statement_timeout`), operation `sql.warehouses.edit`. | B builds it, citing the edit page (a full-replacement body if documented so; NOT_IMPLEMENTED until then); D's warehouse plans |
| Review of D, request 3 | Code `ADMIN_DISABLED`. | D raises it from `adminDisabled()`; F's error docs |
| Review of D, request 4 | The pinned grammar's behaviour, recorded: `CREATE STREAMING TABLE` is `write`; `CREATE OR REFRESH STREAMING TABLE`, `ALTER … SET TAGS` and `UNSET TAG ON …` are unparsed, so `run`; `SET TAG ON …` is `SESSION_STATEMENT_REFUSED`, whose next step now says to write `ALTER … SET TAGS`. | D; F's docs |
| Review of D, request 5 | `walk(tree).targets`: the statement's own targets (`ChangeTarget`: `parts`, `kind` table, schema, catalog, function or other), outside any query or FROM relation. A labelled `source` (MERGE … USING, CREATE TABLE … LIKE) is read, not a target; a rename's new name is one; an `IDENTIFIER(…)` target has empty `parts`. `walk(tree).tables` is unchanged. | D's `statementTables`, H1 and M1 |
| Review of D, request 6 | Superseded by review of F, request 2: no `built` count. | — |
| Review of D, M3 (B's file, routed) | `runNow` sends run-now 2.2's documented `job_parameters`, not `notebook_params`; B's fake refuses `notebook_params`. | B |
| Review of E (#8), request 1 (H3, release blocker) | `sources` holds the keys a v0.1.x consumer refuses: no `readsIdentity`, and the saved price is `{ per: "dbu", usd: 0.7 }` alone. Its conditions sentence moved to `scope.describe`, the README, `docs/costs.md` and `jelly.cost`. A conformance test fails on any held key (`removals`, `accounts.server`, `identityRules`, `owner.verified`, an empty `permission.identity`, `readsIdentity`, a price's `conditions` or `min`). They return once jelly and Memory pin `#v0.2.0`. | E: the queries source stops asserting `scim.me.get` in its content reads |
| Review of E, request 2 | Not a Day 0 change: `billed-cost` for a billed snapshot is a source-contract v0.2.1 patch. | E keeps its recorded override until then |
| Review of E, request 3 | Permission-only `databricks.read` (`readOnly`, allow at every access), declared in `jelly.tools`. | E asserts it in `events_list` and `saved_read` (H2) |
| Review of E, request 4 | `HistoryQuery.userName`, `executedAsUserName` and `clientApplication`. | B maps them; E names the actor |
| Review of E, request 5 | `Inputs.events_list.since`, a date-time with an offset. | E passes it through |
| Review of E, the output | `Outputs.events_list` is the contract's page: `source`, `account`, `owner`, `more`, `scope`, `plugin`, and `gap.since`. | E |
| Review of E, request 6 (rejected) | No `readsIdentity` for runs; its owner is the workspace, `databricks:<host>:account:<alias>`. | E |
| Review of F (#10), request 1 | `scripts/build.mjs` (a Day 0 / kit file): `MINIFIED_IMPORT` matches `from` or `import` followed by a quote, unless a quote, backtick, word character, `$` or `.` comes before it. It is pinned by `test/unit/build-guard.test.ts` (20 samples and esbuild's minified output). Every plugin whose `build.mjs` has the old regex takes the same one. | every package |
| Review of F, request 2 | `tools: { declared, built }` is dropped from status (F's `rpc.ts` and `status.ts`); the two Day 0 status assertions (`state: "sign_in_required"` before the first sign-in, `problems[0]` with `AUTH_REQUIRED`, in `test/host/plugin.test.ts` and `test/pack/pack.test.ts`) are accepted and land with F's status. Review of D ruling 6 is superseded by this request, by the lead's decision. | F |
| Review of F, request 3 | `Outputs.status.running[].account` (required) with `id` the bare statement or run id; `Outputs.status.spend.reconciled` (`warehouse`, `usageDate`, `dbu`, `complete: false`). | F mirrors both in `rpc.ts` |
| Review of F, request 4 | `LedgerPort.starts(account, sinceMs)`: the ledger's own start lines, read back (`createLedger`, `MemoryLedger`). | F scopes the context hook and cleanup to them |
| Review of F, request 5 | Warning `SPEND_UNAVAILABLE` (status still answers `ok`). | F |
| Review of F, request 6 | `jelly.admin` names Jelly's relay among the redirect URLs (198 characters). | — |
| Review of F, request 7 | `test/unit/reads/harness.ts` (C's test helper): `HarnessInput.auth?: AuthPort`, a `FakeAuth` by default. | F's tests |
| Review of F, request 8 | No contract change: automation's `active` reports consent and gates nothing in v0.1.0. | F's docs |
