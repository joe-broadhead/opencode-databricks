# Security

## Reporting a vulnerability

Report a vulnerability through GitHub's private vulnerability reporting on this repository. Do not open a public issue
with a credential, a token or a person's data in it.

## What this plugin holds

The plugin stores no credential in an option. OpenCode holds the OAuth sign-in for each account alias; a headless
account names the environment variable or CLI profile that holds its value. The plugin sends a token only to the
workspace it was minted for, and never prints one in status or an error.

See [docs/security.md](docs/security.md) for the data flow, the scopes and the redaction.
