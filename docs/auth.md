# Auth

Unofficial plugin. Not affiliated with Databricks.

One account is one workspace, with its own sign-in: the integration `databricks-<alias>`, through `/connect` →
Databricks or `opencode auth login databricks-<alias>`. The admin's part is in [Configuration](configuration.md#sign-in);
this page is what the sign-in stores, what each mode does, and how far each guarantee reaches.

## The interactive sign-in

The form asks for:

- **Workspace URL**. `https://` and one of `*.cloud.databricks.com`, `*.azuredatabricks.net` or
  `*.gcp.databricks.com`; another host (PrivateLink, a custom domain) needs `allowCustomHost`. The account consoles are
  refused: this plugin calls workspace APIs only.
- **OAuth client ID**. The public client ID of the app connection an account admin creates. No secret is involved.
- **API scopes**. *Fine-grained* (recommended) requests `sql`, `unity-catalog`, `query-history`, `openid`, `email`,
  `profile`, `offline_access`, plus one per configured feature; *All APIs* requests `all-apis offline_access`, for an app
  made in the account console with All APIs.
- **Role (optional)**. The **numeric group ID** of an RBAC role to assume, from the account console under Identity and
  access → Groups. Databricks' `assume_group` takes the group ID, and no token exists before the first authorization, so
  a display name cannot be resolved first.

The browser goes to `https://<workspace>/oidc/v1/authorize` with PKCE (S256) and a random `state`, and Databricks sends
it back to `http://localhost:8765/callback` — or, when a host serves OpenCode to a browser elsewhere, to the host's
relay (`redirectUri`) while a local listener on `callbackPort` receives it [9][12]. The code is exchanged once at
`https://<workspace>/oidc/v1/token`; the app connection is a public client, so no secret is sent. An access token lives
60 minutes and a refresh token 7 days by default; the admin sets both per app [11].

**The credential's record.** OpenCode's credential store holds the tokens; its metadata holds the workspace, the public
client ID, the scope choice and grant, the bound role group and a sign-in generation. Every token call compares the
workspace and the configured role with that record. A later edit of `opencode.json` can therefore not redirect the token
to another workspace, and cannot change the identity a token runs as: a configured role that differs from the bound one
answers `AUTH_REQUIRED` until the person signs in again. A role chosen on the form with no `role` option is the bound
identity; a form that chooses a role other than a configured one is refused before the browser opens. Each token also
carries the workspace it was minted for, so a caller sends it there even if the display summary names another workspace.

## Headless modes

`pat`, `m2m` and `cli` are opt-in, one per account, and never a fallback. No option holds a secret [9][10][14]:

- `pat` reads the personal access token from the environment variable `tokenEnv` names.
- `m2m` exchanges the service principal's client ID and the OAuth secret `clientSecretEnv` names at the workspace token
  endpoint, with HTTP Basic and `client_credentials`, plus `assume_group` for a role.
- `cli` runs `databricks auth token --profile <profile> -o json` and reads `access_token` and `expiry`. The CLI owns
  refresh and the keychain; the plugin never reads `~/.databrickscfg` or the keychain itself. Every `DATABRICKS_*`
  variable is removed from the child's environment except `DATABRICKS_CONFIG_FILE`, which only relocates profiles.

Each mode takes its secret from the environment or the CLI, never from an option, and caches a minted token until 60
seconds before it expires; `pat` reads the environment on every call. A rotated secret is therefore picked up without a
restart.

## Scopes, and the check before a call

Databricks scopes are per API family, never per read and write [8]: the `sql` scope covers Execute Statement, Start and
Stop Warehouse and Edit Warehouse alike, and `jobs` covers List Runs and Run Now. The plugin asks for the base families
and one scope per configured feature, and compares the scope a call needs with the ones the sign-in was granted **before
any request**. A missing family is `AUTH_SCOPE_MISSING`, and Databricks is not called.

A pat or cli token's scope is unknown to the plugin and treated as every scope; a `m2m` token requests the scopes the
call needs, and a scoped OAuth secret narrower than the request answers `AUTH_SCOPE_MISSING`. Fine-grained M2M scopes are
not part of the live check yet.

## Enforcement

`status` and each read carry one of:

- `identity`: the person's own privileges, the default;
- `service-principal`: a `m2m` account, not the person;
- `role-requested`: a role is bound and configured;
- `role`: `/databricks-doctor` proved what the role allows, in this process.

Only the identity's privileges are enforced by Databricks. Under fine-grained scopes a clean doctor report earns
`role`, and its guarantee is exactly:

> SQL writes refused on what doctor checked; secret scopes and serving endpoints not checked; job runs use each job's
> Run as identity

That wording is `ROLE_ENFORCEMENT_TEXT` in `src/domain/contract.ts`, and `src/auth/doctor.ts` sets it only with
`enforcement: "role"` [13].

The doctor checks the role's own grants, and those of the `users` and `account users` groups a role inherits, on every
visible catalog and on the workspace catalog's `default` schema; the `EXTERNAL` functions in each `default` schema are
checked for a function-level `EXECUTE`, and a catalog- or schema-level `EXECUTE` is refused when an `EXTERNAL` function
exists beneath it. It also checks `USE` or `MANAGE` on every visible connection, which would let `http_request` act with
the connection's credential. Every list is paged to its end; if a cap stops one, the report says `NOT_CHECKED` and a role
is not certified over it. It does **not** check schema- or table-level grants outside the `default` schema, secret
scopes, serving endpoints, or job permissions. Under `all-apis` secret scopes and serving endpoints are reachable, so
they block the claim; jobs are `OK` without the `jobs` scope (no job can run through that token) and `NOT_CHECKED` with
it. After a restart status says `role-requested` until `/databricks-doctor` runs again; the certification is held in
memory only, bound to the credential the report ran against, and any sign-in or refresh that changes its workspace, role
or granted scopes clears it.

SCIM `Me` is not documented to list the inherited `users` and `account users` groups [30], so the doctor always queries
them by name along with the role group. Whether `effective-permissions?principal=<role group>` already includes a parent
group's grants is live check L3; the explicit inherited groups cover it either way.

## Known limits

- **Single-use refresh tokens and two processes.** With `enable_single_use_refresh_tokens` (Beta, an admin's choice),
  each refresh invalidates the old refresh token. This plugin serializes refreshes within one process and always returns
  the rotated token for OpenCode to store, and after a failed read it reads the store once more, so a rotation another
  process just finished is picked up. If two OpenCode processes still renew the same sign-in at the same instant, one can
  be signed out and answers `AUTH_REQUIRED`; sign in again. A cross-process lock is not available to a plugin: the
  credential store is the host's.
- **A role's display name.** Only the numeric group ID is accepted, for the reason above. `AccountInfo.role.name` is for
  display only, filled when SCIM `Me` returns the group.
- **The doctor's reach** is the list above. It is not a whole-metastore claim, and it never is: the guarantee names what
  it checked.
- **Fine-grained M2M scopes** are not exercised by the live check; the request and the error mapping are tested against
  a fake endpoint.
- **The role's name is for display.** `assume_group` takes the numeric group ID [13], and the name shown comes from SCIM
  `Me`'s groups when it is there.
- **A host's relay.** An app connection registered for a host's relay must list the relay address beside the loopback
  URL, exactly, and Databricks must echo the relay's signed `state` (live check L12) [12].

## Sources

- [8] API scopes — https://docs.databricks.com/api/workspace/scopes
- [9] OAuth U2M — https://docs.databricks.com/aws/en/dev-tools/auth/oauth-u2m
- [10] OAuth M2M — https://docs.databricks.com/aws/en/dev-tools/auth/oauth-m2m
- [11] Partner and custom OAuth apps — https://docs.databricks.com/aws/en/integrations/enable-disable-oauth
- [12] Custom OAuth App Integration API — https://docs.databricks.com/api/account/customappintegration/create
- [13] RBAC — https://docs.databricks.com/aws/en/security/auth/rbac
- [14] CLI authentication — https://docs.databricks.com/aws/en/dev-tools/cli/authentication
- [30] SCIM Me — https://docs.databricks.com/api/scim/v1/me.md
- [38] Manage privileges — https://docs.databricks.com/aws/en/data-governance/unity-catalog/manage-privileges/
