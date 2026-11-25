# Architecture

The plugin has three layers:

1. `src/index.ts` builds the ports and the handler table, then calls the contract's `register` once. `register` owns the
   agent tool, Code Mode, RPC, the account selector, the permission gate, the plan ids, the answer checks and the bus.
2. `src/handlers/` is one handler per method. A handler parses nothing itself: the register has checked its input and
   resolved its account. It calls the provider and maps the plugin's failure to a contract refusal.
3. `src/provider/` is the Databricks client and the read path. The client names the endpoint once, sends every request
   with the account's token, retries the documented failures, and never prints a token. The read path analyses the SQL,
   resolves its tables and functions with free Unity Catalog reads, applies the fence and inline rules, checks the
   warehouse, and only then submits.

## What the read path guarantees

- exactly one statement, with every allowlisted built-in call qualified;
- no session statement, no second statement after a semicolon, no `IDENTIFIER(...)`;
- a table or function the path cannot resolve is refused, never guessed;
- a warehouse that is stopped is refused; a start is a separate method.
- rows are inline only under the account's inline rules; otherwise `save` writes them to a file.

## Caches and state

The dependency cache is in memory, with a short TTL; it holds Unity Catalog metadata, never rows. The identity record a
`probe` writes is a user id and host in the state directory, mode 0600, with no token. Plans live in the contract's
register for 15 minutes. Nothing else is stored.

## OpenCode APIs

The plugin uses only `@opencode/plugin` 2.4.1: the plugin context, `ctx.integration`, `ctx.storage`, `ctx.agent`,
`ctx.tool`, `ctx.rpc` and `ctx.permission`, through the contract's modules. It does not import a private host module.
