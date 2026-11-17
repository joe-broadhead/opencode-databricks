# In Jelly

[Jelly](https://heyjelly.ai) runs OpenCode agents. It reads the `jelly` section of this package's `package.json` as
JSON, without loading the plugin, when a person reviews the exact version, and uses it as follows.

Jelly names the plugin **Databricks** (`jelly.title`), with the package name and version beneath, the one line in
`jelly.summary`, and the mark in `jelly.icon` (`assets/icon.svg`, shipped in the package). The mark is the family's own
tile, not Databricks' logo.

## Tools and permissions

0 tools are declared (0 read-only). Nothing is declared until the tools exist; an action the plugin does not
declare still follows the access choice, as the block below says.

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

## Sign-in

One sign-in group, **Databricks workspace**, with the integration `databricks-*` (one per workspace alias). The
person enters the workspace URL and the admin's OAuth client ID; Jelly fills the relay fields `redirectUri` and
`callbackPort`. The account description carries the write disclosure and says that column masks and row filters run
functions the plugin cannot see. `jelly.admin` asks the admin for an OAuth app connection with this plugin's redirect
URLs: the loopback URL and Jelly's relay address, `<Jelly ID issuer>/connect/callback`.

## Skills

Declared: `opencode-databricks` and `opencode-databricks-sql`.

## Views and scripts

None: `jelly.views` and `jelly.rpc` are empty.

## Cost

`jelly.cost` says queries run on a warehouse billed by the hour while it runs, that a start bills until auto-stop, and
that AI functions and jobs bill separately.
