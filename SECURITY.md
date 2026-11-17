# Security

## Supported versions

Only the latest release is supported.

## Reporting a vulnerability

Report a vulnerability privately through GitHub's security advisories for this repository, not in a public issue.

## Data handling

### Network access

The plugin's requests go only to the workspace hosts you configure (`*.cloud.databricks.com`, `*.azuredatabricks.net`,
`*.gcp.databricks.com`, or a host you allow with `allowCustomHost`) and, for saved results, to the cloud storage host
a Databricks external link names, without an `Authorization` header. Account-level APIs are never called. This version
makes no request yet: the tools that call Databricks are not built.

### Credentials

- Tokens live in OpenCode's credential store, per workspace (`databricks-<alias>`). No option holds a secret:
  headless modes name an environment variable (`tokenEnv`, `clientSecretEnv`) or a CLI profile (`profile`), and are
  refused in a hosted engine unless `allowHeadlessInHost` is set.
- A token never appears in an error, a status line, a log line or a result. External-link URLs carry credentials and
  are never returned, logged or stored.
- The token carries `sql` and `unity-catalog`, which cover running statements and changing tables. Any process of the
  same user that can read the credential store could use them. Only a read-only role holds there.

### What the agent can do

> At Allowed, the agent can change or delete anything your Databricks identity can, after a plan it makes itself.
> For a hard limit, sign in with a read-only role.

The plugin's read checks, when they arrive, are best-effort. Column masks and row filters set by your admins run their own functions
on every read; Databricks enforces them, and the plugin cannot see them.

### Untrusted content

Rows, comments, view and function SQL, job names, run output and Databricks' error text are data, never
instructions. Databricks' text is only ever in `providerError`, marked untrusted.

## Permissions

The default rules allow reads, ask or deny changes and warehouse starts as the `access` option sets, and treat an
action the plugin does not know as a change. Agents without the block are named in `/databricks-status`.

## Scripts

Scripts call the tools RPC as a session and its agent; only a prior explicit `allow` runs, and an `ask` is refused.
