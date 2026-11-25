# Configuration

Every option is set under the plugin's `options` in `opencode.json`. `access` is the ceiling the generated permission
rules enforce; `accounts` maps an alias to its workspace profile.

<!-- generated:configuration -->
| Option | Type | Default | Description |
|---|---|---|---|
| `access` | `all` \| `ask-changes` \| `read-only` | `"all"` | How much the plugin's methods may do: all, ask-changes or read-only. |
| `accounts` | object | — | One profile per account alias; each alias is one Databricks workspace. |
| `redirectUri` | string | — | The public OAuth redirect URI when OpenCode runs on another machine. |
| `callbackPort` | integer | `8765` | The local port the OAuth callback listens on. |
| `allowCustomHost` | boolean | `false` | Allow a workspace host that is not a Databricks domain, such as a private link. |
| `maxStartSize` | `2X-Small` \| `X-Small` \| `Small` \| `Medium` \| `Large` \| `X-Large` \| `2X-Large` \| `3X-Large` \| `4X-Large` | `"Small"` | The largest warehouse databricks.start may start. |
| `maxStartAutoStopMinutes` | integer | `15` | The longest auto-stop databricks.start may accept. |
| `maxRunSize` | `2X-Small` \| `X-Small` \| `Small` \| `Medium` \| `Large` \| `X-Large` \| `2X-Large` \| `3X-Large` \| `4X-Large` | — | The largest warehouse a read may run on. |
| `maxRunSeconds` | integer | `600` | How long a read may keep polling before it is cancelled. |
| `wait` | integer | `50` | Seconds a statement submit waits before it answers running. |
| `budget` | object | — | An optional daily or per-session start and DBU budget. |
| `usdPerDbu` | object | `{"serverless":0.7,"pro":0.55,"classic":0.22}` | List-price dollars per DBU, by warehouse kind, for estimates. |
| `maxRows` | integer | `50` | Rows a read returns inline. |
| `maxInlineBytes` | value | `"32KiB"` | Bytes a read returns inline. |
| `maxSaveRows` | integer | `1000000` | Rows databricks.save writes. |
| `maxSaveBytes` | value | `"256MiB"` | Bytes databricks.save writes. |
| `resultsDir` | string | `".databricks/results"` | The only directory databricks.save writes under. |
| `inlinePii` | `warn` \| `save-only` | `"warn"` | How a column tagged as PII is treated inline. |
| `dependencyDepth` | integer | `4` | How deep a view's dependencies are resolved. |
| `runTimeoutSeconds` | integer | `3600` | The timeout for a one-time notebook run. |
| `admin` | object | `{"enabled":true,"requireReason":true}` | Whether admin plans are enabled, and whether they need a reason. |
| `allowUntestedHost` | boolean | `false` | Start outside the tested OpenCode range (2.4.1). |
<!-- /generated:configuration -->

An example with two accounts:

```json
{
  "plugins": [
    {
      "package": "github:we-the-rebel-alliance/databricks-plugin#vX.Y.Z",
      "options": {
        "access": "ask-changes",
        "accounts": {
          "work": { "host": "https://dbc-1234abcd-5678.cloud.databricks.com", "warehouse": "wh-small", "catalog": "main", "schema": "default" },
          "personal": { "host": "https://dbc-9876fedc-5432.cloud.databricks.com" }
        }
      }
    }
  ]
}
```
