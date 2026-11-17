# Configuration

Unofficial plugin. Not affiliated with Databricks.

```json
{
  "plugins": [
    { "package": "github:joe-broadhead/opencode-databricks#v0.0.1", "options": { "access": "ask-changes", "accounts": { "work": { "warehouse": "abc123" } } } }
  ]
}
```

## Sign in

Each workspace is an account alias with its own sign-in, `databricks-<alias>`, through `/connect` → Databricks or
`opencode auth login databricks-<alias>`: OAuth with PKCE against the workspace's own `/oidc/v1/authorize`, using the
app connection your account admin creates once (a public client, no secret):

```sh
databricks account custom-app-integration create --json '{
  "name": "opencode-databricks",
  "redirect_urls": ["http://localhost:8765/callback"],
  "scopes": ["sql", "unity-catalog", "query-history", "openid", "email", "profile", "offline_access"]
}'
```

Add `jobs`, `workspace` or `files` to the scopes to allow those features. An app made in the account console with
**All APIs** works with `scopes: "all-apis"`. App changes can take 30 minutes to apply. Signing in with a read-only
role (`role`) is the only hard limit on what the agent can do; see [Safety](safety.md).

## Options

| Option | Default | Meaning |
|---|---|---|
| `access` | `"all"` | `all`, `ask-changes` or `read-only`: the default rules. |
| `accounts` | one `default` | Per alias: `host`, `mode` (`interactive`, `pat`, `m2m`, `cli`), `clientId`, `role`, `warehouse`, `catalog`, `schema`, `scopes` (`fine` or `all-apis`), `features` (`jobs`, `workspace`, `files`), `fence`, `inline`, and for headless modes `tokenEnv`, `clientSecretEnv` or `profile` (names, never secrets). |
| `redirectUri`, `callbackPort` | none, `8765` | The sign-in's redirect. |
| `allowCustomHost`, `allowHeadlessInHost` | `false` | A host other than `*.cloud.databricks.com`, `*.azuredatabricks.net` or `*.gcp.databricks.com`; headless modes in a hosted engine. |
| `maxStartSize` | `"Small"` | The largest warehouse a call may start. |
| `maxStartAutoStopMinutes` | `15` | A warehouse with a longer or no auto-stop is never started. |
| `maxRunSize` | none | The largest warehouse an agent may run on. |
| `maxRunSeconds` | `600` | The plugin's cancel, for reads with `wait` above 50 seconds. |
| `wait` | `50` | Reads at or under 50 seconds are cancelled by Databricks at the wait. |
| `maxConcurrentStatements` | `4` | Per account. |
| `budget` | none | `{ daily?, session?, action }`: opt-in. |
| `usdPerDbu` | `{ serverless: 0.70, pro: 0.55, classic: 0.22 }` | For estimates. |
| `maxRows`, `maxInlineBytes` | `50`, `"32KiB"` | Inline results. |
| `maxSaveRows`, `maxSaveBytes` | `1000000`, `"256MiB"` | Saved files. |
| `resultsDir`, `allowedRoots` | `".databricks/results"`, `[]` | Where saves go. |
| `inlinePii` | `"warn"` | Or `"save-only"`. |
| `strictDependencies` | `false` | Refuse views whose dependencies are not recorded. |
| `dependencyDepth` | `4` | How deep view and function bodies are checked. |
| `runTimeoutSeconds` | `3600` | Notebook runs. |
| `automation`, `autoStopIdleMinutes` | `"auto"`, `10` | Stopping warehouses this plugin started once everyone has left them idle. |
| `planTtlSeconds` | `300` | How long a plan lives. |
| `admin` | `{ enabled: true, requireReason: true }` | Admin plans. |
| `allowUntestedHost` | `false` | Load on an OpenCode release outside the tested range. |

An option that does not exist is refused with `OPTIONS_INVALID`.

## The default rules

After each agent's base `* * allow`, the plugin inserts: `databricks.*` with the change effect (so an action it does
not know is treated like a change); then each read tool and `databricks.probe` allowed; `databricks.start` allowed at
`all` and `read-only` and asked at `ask-changes`; then each change tool with the change effect (allowed, asked,
denied). These are the effects Jelly gives the same actions. Your own rules after the block still win, such as
`{ "action": "databricks.query", "resource": "work:table:*.hr.*", "effect": "deny" }`.

## Errors

See [Errors](errors.md).
