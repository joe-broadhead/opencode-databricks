# Configuration

Unofficial plugin. Not affiliated with Databricks. Install from a release: `opencode plugin add
github:we-the-rebel-alliance/databricks-plugin#v<version>`; the first release on plugin-contract is `v0.0.0` (phase 4b).

```json
{
  "plugins": [
    { "package": "github:we-the-rebel-alliance/databricks-plugin#v0.0.0", "options": { "access": "ask-changes", "accounts": { "work": { "warehouse": "abc123" } } } }
  ]
}
```

## Sign in

Each workspace is an account alias with its own sign-in, `databricks-<alias>`, through `/connect` → Databricks or
`opencode auth login databricks-<alias>`: OAuth with PKCE against the workspace's own `/oidc/v1/authorize`, using the
app connection your account admin creates once (a public client, no secret) [9][11][12]:

```sh
databricks account custom-app-integration create --json '{
  "name": "databricks-plugin",
  "redirect_urls": ["http://localhost:8765/callback"],
  "scopes": ["sql", "unity-catalog", "query-history", "jobs", "workspace", "files",
             "openid", "email", "profile", "offline_access"]
}'
```

- The UI fallback (Settings → App connections) offers only **SQL** or **All APIs**; an app made there with All APIs
  works with `scopes: "all-apis"`, and one made with only SQL lacks `unity-catalog` and `query-history` and cannot serve
  this plugin [11][12].
- Drop `jobs`, `workspace` or `files` to forbid those families for everyone: the `jobs` scope covers Run Now as readily
  as List Runs [12].
- The loopback redirect may use `http`; every other redirect must be `https`. When a host serves OpenCode to a browser
  elsewhere, the connection lists the host's relay address as well, and `redirectUri` carries it.
- "Updates to OAuth applications can take 30 minutes to process" [11]; a change that does not work at once may be the
  wait.
- Signing in with a read-only role (`role`, the numeric group ID) is the only hard limit on what the agent can do; see
  [Safety](safety.md) and [Auth](auth.md#enforcement).

## Options

| Option | Default | Meaning |
|---|---|---|
| `access` | `"all"` | `all`, `ask-changes` or `read-only`: the default rules. |
| `accounts` | one `default` | Per alias: `host`, `mode` (`interactive`, `pat`, `m2m`, `cli`), `clientId`, `role`, `warehouse`, `catalog`, `schema`, `scopes` (`fine` or `all-apis`), `features` (`jobs`, `workspace`, `files`), `fence`, `inline`, and for headless modes `tokenEnv`, `clientSecretEnv` or `profile` (names, never secrets). |
| `redirectUri`, `callbackPort` | none, `8765` | The sign-in's redirect; a host fills the relay fields. |
| `allowCustomHost` | `false` | A host other than `*.cloud.databricks.com`, `*.azuredatabricks.net` or `*.gcp.databricks.com`. |
| `maxStartSize` | `"Small"` | The largest warehouse a call may start. |
| `maxStartAutoStopMinutes` | `15` | A warehouse with a longer or no auto-stop is never started. |
| `maxRunSize` | none | The largest warehouse an agent may run on. |
| `maxRunSeconds` | `600` | The plugin's cancel, for reads with `wait` above 50 seconds. |
| `wait` | `50` | Reads at or under 50 seconds are cancelled by Databricks at the wait. |
| `budget` | none | `{ daily?, session?, action: "warn" \| "refuse" }`: opt-in, in DBU-hour estimates. |
| `usdPerDbu` | `{ serverless: 0.70, pro: 0.55, classic: 0.22 }` | For estimates. |
| `maxRows`, `maxInlineBytes` | `50`, `"32KiB"` | Inline results. |
| `maxSaveRows`, `maxSaveBytes` | `1000000`, `"256MiB"` | Saved files. |
| `resultsDir`, `allowedRoots` | `".databricks/results"`, `[]` | Where saves go. |
| `inlinePii` | `"warn"` | Or `"save-only"`: no inline rows for a source with a personal-data tag. |
| `dependencyDepth` | `4` | How deep view and function bodies are checked. |
| `runTimeoutSeconds` | `3600` | Notebook runs: the server stops them. |
| `automation` | `"auto"` | `"auto"`: on at `access: "all"`, off otherwise. `"on"`: your standing yes at any level. `"off"`: never. |
| `planTtlSeconds` | `300` | How long a plan lives. |
| `admin` | `{ enabled: true, requireReason: true }` | Admin plans. |
| `allowUntestedHost` | `false` | Load on an OpenCode release outside the tested range. |

An option that does not exist is refused with `OPTIONS_INVALID`.

## The default rules

After each agent's base `* * allow`, the plugin inserts: `databricks.*` with the change effect (so an action it does
not know is treated like a change); then each read tool and `databricks.probe` allowed; `databricks.start` allowed at
`all` and `read-only` and asked at `ask-changes`; then each change tool with the change effect (allowed, asked,
denied). These are the effects the access level gives every action. Your own rules after the block still win, such as
`{ "action": "databricks.query", "resource": "work:table:*.hr.*", "effect": "deny" }`.

## Automation and cleanup

- **Orphaned reads are cancelled at every access level.** When OpenCode reports a session deleted or archived, the
  plugin cancels the read statements it started for that session. A read has no effects; a change statement and a job
  run are never cancelled there.
- **`automation` is the consent for everything else, and in this version there is nothing else:** no warehouse is stopped
  automatically. The option is kept for the next release, and "on" is documented as a standing yes to what it covers.
- **`/databricks-cleanup` is yours.** Every stop and cancel asserts its own `databricks.stop` or `databricks.cancel`.
  At `ask-changes` that is a permission prompt only you answer; at `all` the default rules allow it, so typing the command
  is the confirmation — but your own deny rule still wins, action by action. At `read-only` it reports and takes no
  action. A stop is offered only for a warehouse this plugin started (the ledger's start record, a start in the last 24
  hours). Nothing deletes.

## Headless modes

`pat`, `m2m` and `cli` are opt-in per account and never a fallback. [Auth](auth.md#headless-modes) has each mode and
its limits.

## Errors

See [Errors](errors.md).

## Sources

- [9] OAuth U2M — https://docs.databricks.com/aws/en/dev-tools/auth/oauth-u2m
- [11] Partner and custom OAuth apps — https://docs.databricks.com/aws/en/integrations/enable-disable-oauth
- [12] Custom OAuth App Integration API — https://docs.databricks.com/api/account/customappintegration/create
