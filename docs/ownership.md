# Ownership: who edits which file

Day 0 fixed the contract; packages A to F build on it in parallel (design §16). Each file has one owner. A package
edits only its own files, adds new files only under its own folders, and wires a finished handler into
`src/registry.ts` with a one-line change to `HANDLERS` (the only shared edit, merged in package order). A change to a
**contract** file needs a review of the contract and lands as its own pull request before the packages that use it.

## Contract files (Day 0; change only with a contract review)

| File | What it fixes |
|---|---|
| `src/constants.ts` | ids, namespace, host range, tested hosts |
| `src/domain/actions.ts` | the 23 tools, their classes, the dotted actions, the two permission-only entries, operations and scopes |
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

