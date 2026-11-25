# Accounts

The plugin holds the credentials: one OpenCode integration per alias. `default` is `databricks`; another alias `work`
is `databricks-work`. Sign in with `/connect` or `opencode auth login databricks-work`.

With one account, `account` may be omitted. With more than one, a method that takes an account refuses a call without
one (`ACCOUNT_REQUIRED`), and an alias the plugin does not have is `ACCOUNT_UNKNOWN`.

Each alias is one workspace. `probe` answers its owner without reading content.

A sign-in the host holds is used while its access token is valid. Once it expires the plugin refuses with
`NEEDS_SIGN_IN` rather than trying to renew a refresh token it does not hold; sign in again from the host that holds it.

<!-- generated:accounts -->
Accounts are held by the **integration** mechanism: the plugin holds the credentials.

| Field | Type | Required |
|---|---|---|
| `host` | string | no |
| `mode` | `interactive` \| `pat` \| `m2m` \| `cli` | no |
| `clientId` | string | no |
| `role` | string | no |
| `warehouse` | string | no |
| `catalog` | string | no |
| `schema` | string | no |
| `scopes` | `fine` \| `all-apis` | no |
| `features` | array | no |
| `fence` | object | no |
| `inline` | object | no |
| `tokenEnv` | string | no |
| `clientSecretEnv` | string | no |
| `profile` | string | no |
<!-- /generated:accounts -->
