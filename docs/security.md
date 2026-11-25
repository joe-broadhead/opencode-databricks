# Security

The plugin sends requests only to the workspace URL of the account that made the call. The URL is validated (https, a
Databricks host, or a host the person explicitly allows) and the token is minted for that host.

## What leaves the machine

- The SQL you ask it to run, the catalog and schema names, and the job, notebook or warehouse identifiers.
- The account's OAuth token, in the `Authorization` header, to that workspace only.
- Nothing else: status reasons are redacted and cut to one line, and provider text is marked untrusted.

## Scopes

An interactive sign-in requests the fine-grained scopes for the features the account enables (`sql`,
`unity-catalog`, `query-history`, `jobs`, `workspace`, `files`), or `all-apis` when the app connection is made that way.
A missing scope is `SCOPE_MISSING` before any request.

## Source reads

The four source reads (`events_list`, `saved_read`, `probe` and `saved_list`) assert their method action
(`databricks.events_list`, `databricks.saved_read`, `databricks.probe`, `databricks.saved_list`) and, for every operation
the method declares, `databricks.read` on `<account>:<operation>`. An old `databricks.read` allow, ask or deny rule
therefore still governs all four; a deny stops the call before any provider request.

## Plan and commit

A write is planned first. The plan writes nothing; it previews the targets, the warehouse and the cost. The commit
takes the plan id only, re-checks what the preview showed, and runs once. A commit over RPC needs an OpenCode ask or a
host-signed action grant; an allow rule alone is not a confirmation.

## Redaction

The plugin never puts a token, a URL query string or provider error text in status. Event text is screened for secrets
and refused events carry no content.
