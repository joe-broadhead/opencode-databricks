# Contributing

## Setup

- Node.js 22.12 or later, with npm. CI uses Node.js 24.
- Bun 1.4 (CI uses 1.4.4). The conformance, host and pack tests run with `bun test`.
- macOS or Linux.

```sh
git clone https://github.com/we-the-rebel-alliance/databricks-plugin.git
cd databricks-plugin
npm ci --ignore-scripts
npm run check
```

No dependency needs install scripts, and OpenCode installs plugins without them, so always pass `--ignore-scripts`.

### Run your checkout in OpenCode

Build it with `npm run build`, then point the `plugins` entry of a development OpenCode config at the clone's directory
instead of the release install. A development build answers `NOT_RELEASED` and never calls Databricks.

## `npm run check`

One command, `scripts/check.mjs`, runs every stage in order and stops at the first failure. `node scripts/check.mjs
<stage>...` runs only the named stages.

| Stage | What it does |
| --- | --- |
| `parser` | Regenerates the SQL parser and the built-in list into a temporary folder and fails on any difference. |
| `typecheck` | `tsc` over `src/` and the tests. |
| `unit` | Vitest over `test/unit/`. |
| `conformance` | The `sources` declaration against the source contract v0.3.0, under Bun; the kit's run over the sources lands with them. |
| `kit` | The release kit's own tests. |
| `build` | esbuild bundles `dist/index.js` and `dist/tui.js`, and checks `NOTICE`. |
| `icons` | The family icon contract. |
| `host` | The built plugin in an embedded OpenCode host, once per tested release, against a loopback fake. |
| `pack` | Packs, installs with scripts disabled and imports both entries. |
| `forbidden` | The forbidden APIs and private names. |
| `copies` | The shared kit files against their pinned hashes. |
| `whitelist` | `package.json` and `dist/` against the approved package shape. |
| `actionlint` | The workflows, when `actionlint` is on PATH. |

## The parser

`src/sql/generated/` is generated: never edit it. To move the grammar pin, copy the two grammar files of the new
Apache Spark tag into `grammar/spark/`, update `grammar/spark/PIN.json`, port any changed action in `grammar/port.mjs`,
run `node scripts/generate-parser.mjs`, and run the fuzz (`npm run fuzz`, which needs Java 17). See
[The parser](docs/parser.md).

## Releases

Versions follow semantic versioning on the plugin's contract: its options, the namespace `databricks`, the
`/databricks-status` command, the status RPC, the skill names, the tool schemas and the default rules.

Each release is the GitHub tag `v<version>`, made only by `.github/workflows/release.yml` after the owner approves the
`release` environment. While changes land, their notes go under `## [Unreleased]` in `CHANGELOG.md`; a release-prep
commit runs `node scripts/changelog.mjs release`. `package.json` stays `"private": true` and in canonical form.

CI runs one `ci` job on every pull request and every push to `master`; the release stands on that run.
