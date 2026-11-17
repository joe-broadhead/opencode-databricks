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
- `userFunctions` holds only three-part names: a non-built-in function named by one or two parts is refused by
  `analyzeRead` (`FUNCTION_NAME_PARTIAL`). Package C checks each under design §5.4 and sends it as written.
- The read path is one entry point, `ReadGuardPort.prepare` (`src/ports.ts`), which package C implements in
  `src/guards/read.ts`. Every read tool, and package E's `saved_read` and `save`, call it; E builds against
  `FakeReads` (`test/fake/ports.ts`) until C lands.
- A plan's category comes only from `classifyPlan` (`src/domain/statements.ts`); nothing lowers it.
- Errors are `DatabricksError(code)` from the one table; Databricks' text goes only in `providerError`.
- No package adds a runtime dependency. A new devDependency is pinned exactly and, if bundled, appears in `NOTICE`.
