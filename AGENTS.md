# Repository rules

This repository builds `@joe-broadhead/opencode-databricks`, an unofficial OpenCode plugin for Databricks: Unity
Catalog, SQL warehouses, queries, jobs and saved results, over Databricks' REST APIs, with every change planned
first. User docs: `README.md`, `docs/configuration.md`, `docs/safety.md`; contributor docs: `docs/architecture.md`,
`docs/ownership.md`, `docs/parser.md`, `CONTRIBUTING.md`.

## Platform

- Use only public APIs of `@opencode/plugin` 2.2.3. The supported host range is exactly `>=2.2.3 <2.4.0`, in
  `package.json` `opencode.host`, `SUPPORTED_HOST` in `src/constants.ts` and `HOST_RANGE` in `scripts/check.mjs`.
  Never write it as `^2.2.3`.
- Test against stock OpenCode 2.2.3, 2.2.4, 2.2.5, 2.2.6, 2.2.7, 2.3.0, 2.3.1 and 2.3.2. `TESTED_HOSTS` in
  `src/constants.ts` is the one list.
- Keep the plugin ids `databricks.databricks` (status RPC), `databricks.databricks.tools` (tools RPC) and
  `databricks.databricks.tui` (TUI), and the namespace `databricks`.

## Forbidden

`npm run lint` (`scripts/check-forbidden.mjs`) runs its self-test, then scans `src/`, `test/`, `scripts/` and `dist/`,
and every tracked file for the family's private names. Do not use the V1 packages under `@opencode-ai/`,
`ctx.generate.*`, `experimental.policies`, `ctx.experimental.artifact`, imports of `@opencode/ai` or of private
OpenCode source, machine-local paths, or `ctx.permission.hook` anywhere but once in `dist/index.js` (the source
contract's tools RPC).

## Databricks

- **No silent warehouse start.** Every statement checks the warehouse first; starting needs `start: true`, the start
  policy and the `databricks.start` action.
- **Read means read.** A read sends exactly `SELECT * FROM (\n<sql>\n) AS oc_q`, with no `;`, through the function
  allowlist (`src/domain/functions.ts`), with allowlisted calls qualified as `system.builtin.<name>`. The plugin's
  checks are best-effort; the identity's privileges are the only server-enforced read-only, and the docs say so.
- **Changes go plan, then commit.** `databricks_plan` sends no statement, never `EXPLAIN`. The parser's category is
  final; token rules only raise it.
- **Every assert uses the dotted action** `databricks.<tool>`, the name Jelly declares. Asserted equals declared.
- **No secret in config or in a result.** Tokens live in OpenCode's credential store; external-link URLs carry
  credentials and are never returned, logged or stored. Databricks' text goes only in `providerError`.
- **Never invent Databricks facts.** Every fact cites Databricks' docs, a live check or a measurement.

## Design

- The tool table is `src/domain/actions.ts`; the schemas are `src/domain/contract.ts`; the errors are
  `src/domain/errors.ts`. Change them only with a review of the contract (`docs/ownership.md`).
- The SQL parser is generated from Spark's pinned grammar (`grammar/spark/PIN.json`) by `scripts/generate-parser.mjs`.
  Never edit `src/sql/generated/`; `npm run check` regenerates and diffs it.
- Permission defaults go through `ctx.agent.transform`, right after each agent's base `* * allow`. No permission hook
  decides them. User rules and saved approvals keep winning.
- Transforms are synchronous and never throw.
- `dist/` holds exactly two self-contained bundles, `index.js` and `tui.js`.

## Package

- No peer and no runtime dependencies: esbuild bundles zod, the antlr4ng runtime, the generated parser and the source
  contract into `dist/index.js`. `NOTICE` carries their licences and Spark's.
- Ship prebuilt `dist/` and no `.d.ts` files. No install, `prepare` or `prepack` scripts.
- The shared kit files are byte-for-byte copies, pinned in `scripts/check-copies.mjs`. Change them in every plugin at
  once.
- Releases come only from `.github/workflows/release.yml`, approved by the owner. Never push a tag or a `release/*`
  branch.

## Hygiene

- No tokens, keys, personal data, workspace hosts or machine-local paths in the repository. Fixtures are invented.
- Host tests isolate `HOME`, the XDG folders, `TMPDIR` and `OPENCODE_TEST_HOME` under the system's `/tmp`, and block
  every request off loopback.
- Run `npm run check` before every commit. Commit messages use `type(scope): summary`.
