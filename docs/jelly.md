# In Jelly

[Jelly](https://heyjelly.ai) runs OpenCode agents. It reads the `jelly` section of this package's `package.json` as
JSON, without loading the plugin, when a person reviews the exact version, and uses it as follows.

Jelly names the plugin **Databricks** (`jelly.title`), with the package name and version beneath, the one line in
`jelly.summary`, and the mark in `jelly.icon` (`assets/icon.svg`, shipped in the package). The mark is the family's own
tile, not Databricks' logo.

## Tools and permissions

26 tools are declared (17 read-only): the 23 tools, each by its dotted action `databricks.<tool>`, and three
permission-only entries the plugin asserts that are not tools: `databricks.start` (a warehouse start; `effect: "ask"`,
`readOnly: true`), `databricks.probe` (a source's identity probe; `readOnly: true`) and `databricks.read` (a bound
source's content read; `readOnly: true`). So a start is allowed at Allowed, asks at Ask before changes and runs at Read
only; the probe, a source's read and every read tool run at every level; the save, the six commit tools, cancel and
stop follow the access choice as changes. `test/unit/jelly.test.ts` checks the declaration equals the registry plus
those three entries, runs Jelly's access rules over every action the plugin asserts, and checks the plugin's own
default rules agree.

The family's shared rules, word for word from Jelly's guide:

<!-- family-block:start -->
- At Allowed (`all`), the default, every tool runs without asking, declared or not, whatever its `effect`.
- At Ask before changes (`ask-changes`), a `readOnly` tool runs, and every other tool asks first, including a tool this plugin does not declare.
- At Read only (`read-only`), a `readOnly` tool runs, and every other tool is off, including a tool this plugin does not declare.
- A declared `effect` of `allow` changes nothing: the tool follows the access choice and its `readOnly`.
- A declared `effect` of `ask` makes the tool ask at Ask before changes, even when it is `readOnly`, and changes nothing at Allowed or Read only.
- A declared `effect` of `deny` turns the tool off at Ask before changes and at Read only, and changes nothing at Allowed.
- An action listed in `asks` asks first at Ask before changes and at Read only, and never at Allowed.
- A tool named with one `*`, such as another account's `plaud-*.get_file`, follows the same rules as a tool named in full.
- A choice the person makes for one tool wins over the access choice and the declared `effect`.
- jelly leaves out a key it does not know at the top level of the `jelly` block, and reads the rest.
- jelly refuses the plugin for a key it does not know inside anything it reads, such as a tool, a sign-in or a setting.
- jelly refuses the plugin, with one plain line, when `requires` names a field or a feature it does not read.
<!-- family-block:end -->

Two actions are not tools and are not in `jelly.tools`: `/databricks-cleanup` is a command a person types, and its
at-`ask-changes` confirmation is a permission prompt for `databricks.stop` or `databricks.cancel` (both already
declared). Jelly needs no entry for the command.

## Sign-in

One sign-in group, **Databricks workspace**, with the integration `databricks-*` (one per workspace alias). The person
enters the workspace URL and the admin's OAuth client ID; Jelly fills the relay fields `redirectUri` and `callbackPort`.
The account description carries the write disclosure and says that column masks and row filters run functions the
plugin cannot see.

`jelly.admin` asks the admin for an OAuth app connection (a public client) with this plugin's redirect URLs [11][12]:

- the loopback URL, `http://localhost:8765/callback` (the default `callbackPort`), and
- **Jelly's relay address**, `<Jelly ID issuer>/connect/callback` — `connectRelayAddress(issuer)` in Jelly's
  `connect-relay.ts`. It must be registered exactly: Databricks matches redirect URLs exactly, and a non-loopback one
  must be `https` [12].

The plugin asks for fine-grained scopes and one per feature, or `all-apis` for an app made in the console with All
APIs [12]. Under `all-apis` the doctor cannot earn `enforcement: "role"`, because secret scopes and serving endpoints
are reachable through that token and the doctor does not check them; the sign-in help says so.

The relay must carry Databricks' `state` back unchanged; Jelly replaces it with a signed JWT, and Databricks must echo
it intact (live check L12). The form's hidden `redirectUri` and `callbackPort` are the gws mechanism, already
supported.

**Headless modes stay off in hosted engines** (`HEADLESS_REFUSED`), so Jelly needs nothing for them: every engine Jelly
runs, desktop or cloud, refuses `pat`, `m2m` and `cli` unless `allowHeadlessInHost` is set.

## Skills

Declared: `opencode-databricks` and `opencode-databricks-sql`. Jelly shows both on the card; the plugin registers the
same two files.

## Views and scripts

None: `jelly.views` and `jelly.rpc` are empty. Status is a tool and a command; the TUI dialog is the `./tui` export.

## Cost

`jelly.cost` says a warehouse bills by the hour while it runs, that a start bills until auto-stop, that saved-query
reads run only on a warehouse already running, which then stays up until it auto-stops, and that AI functions and jobs
bill separately [16][18][21]. See [Costs](costs.md).

The plugin cancels its own orphaned reads when a session ends, at every access level, and stops no warehouse in
v0.1.0: warehouse cleanup is the person's, through `/databricks-cleanup` or `databricks_stop`. `automation: "on"` is a
standing yes to what automation does, and in v0.1.0 that is only the orphan cancels, which need no consent. The card's
setting description says what Ask before changes and Read only do; [Configuration](configuration.md#automation-and-cleanup)
says the rest.

## Sources declaration

`package.json` `sources` declares `databricks.queries` (your finished statements, metadata only),
`databricks.runs` (finished job runs) and `databricks.saved` (a saved query's table, read only on a running
warehouse), validated with the source contract v0.2.0's `assertDeclaration` [24][29].

## Sources for this page

- [11] Partner and custom OAuth apps — https://docs.databricks.com/aws/en/integrations/enable-disable-oauth
- [12] Custom OAuth App Integration API — https://docs.databricks.com/api/account/customappintegration/create
- [16] Create a SQL warehouse — https://docs.databricks.com/aws/en/compute/sql-warehouse/create
- [18] SQL warehouses — https://docs.databricks.com/aws/en/compute/sql-warehouse/
- [21] Pricing — https://www.databricks.com/product/pricing/databricks-sql
- [24] Query History API — https://docs.databricks.com/api/query-history/v1/list-queries.md
- [29] Jobs runs — https://docs.databricks.com/api/jobs/v2/list-runs.md
