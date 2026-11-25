# Contributing

This repository is the Databricks plugin on
[plugin-contract](https://github.com/we-the-rebel-alliance/plugin-contract) v0. The contract is
[docs/contract.md](https://github.com/we-the-rebel-alliance/plugin-contract/blob/master/docs/contract.md), the bar for
every plugin repository is
[docs/plugin-standard.md](https://github.com/we-the-rebel-alliance/plugin-contract/blob/master/docs/plugin-standard.md),
and [AGENTS.md](AGENTS.md) is the working guide.

## Set up and check

You need Node 24.

```sh
npm ci --ignore-scripts
npm run check
```

`npm run check` runs the whole gate:

| Step | What it proves |
|---|---|
| `npm run typecheck` | the sources and tests typecheck under strict settings |
| `npm run bundle` | `dist/index.js` is built from `src/index.ts` with esbuild |
| `npm run test:unit` | the method table, access rules, schemas, the read path, both events sources and the warehouse start |
| `npm run test:pack` | the tarball holds `package.json`, `dist/index.js`, the skills, the assets, `README.md` and `LICENSE` |
| `plugin-kit check` | conformance T0 and T1, the doc file set, the forbidden patterns and no bundled kit |

CI runs `npm run check` in one job, named `ci`. `dist/` is committed: after a source change, run `npm run bundle` and
commit the result, and CI fails when the committed bundle is stale.

## The contract pin

`package.json` pins the contract to `github:we-the-rebel-alliance/plugin-contract#v0.0.0`. Move the pin to the
contract's next release tag; never follow a branch. Never copy a contract module into this repository. The committed
`package-lock.json` records the contract over `git+https`, so a fresh `npm ci` needs no SSH key.

## Pull requests

One change per pull request, based on `master`, with a conventional commit (`feat:`, `fix:`, `docs:`, `chore:`). The
pull request says what changed and why, the contract section it implements, and the exact `npm run check` result.

A new method, source or action starts in `package.json` `capabilities`, then its handler in `src/handlers/`, then its
tests, then `npx plugin-kit docs`, then `npx plugin-kit check`. Every capability has tests, including its negative cases.

## Fixtures

`fixtures/conformance.json` is the plugin's evidence to the conformance kit. It records two synthetic accounts; rebuild
it with `node test/fixtures/make-conformance.mjs`, then run `npx plugin-kit record` to redact it. Once a real workspace
is available, record from two real accounts:

```sh
npx plugin-kit record --account work
npx plugin-kit record --account personal
```

## Releases

Releases are tags, not npm packages. A release is prepared in one pull request, `chore(release): prepare vX.Y.Z`: the
version in `package.json` and `package-lock.json`, the `CHANGELOG.md` section, and `npx plugin-kit docs` if the manifest
changed. The owner pushes the tag after `master`'s CI passed; the release workflow checks the tag, builds, and creates
the GitHub release with the packed tarball, the conformance report and `SHA256SUMS`.
