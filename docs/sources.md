# Sources

The plugin is a source for Memory and Jelly ([source-contract](https://github.com/we-the-rebel-alliance/source-contract)
v0.2.0). It has three sources, read over the tools RPC `databricks.databricks.tools`:

| Source | Kind | What it lists | Owner |
|---|---|---|---|
| `databricks.queries` | events | Your own finished statements (Query History), one event each, when it ends | you (`mailto:`, from `probe`) |
| `databricks.runs` | events | The workspace's finished job runs, one event each, when it ends | the workspace account |
| `databricks.saved` | snapshot | One saved SQL query you chose, read only on a warehouse that is already running | you |

Events carry metadata only: the statement type, warehouse, status, duration and row count, or the run's name, result
and trigger. `text` is always empty: SQL holds literals and secrets, and a run's state message can hold data. Every
answer is `trust: "untrusted"`.

`probe` reads only SCIM `Me` and records your user id for the account and workspace (in
`$XDG_STATE_HOME/opencode-databricks/sources.json`, mode 0600, no token). `databricks.queries` filters Query History by
that id, so its reads never read the identity. A queries read on an account that was never probed answers
`UNAVAILABLE` ("probe this source first"); a consumer probes at every bind. The model's own `databricks_events_list`
reads the identity itself when no probe has.

## How the event sources page

Both APIs filter only by when an item *started*: Query History's `filter_by.query_start_time_range` (at most 30 days,
"most recently started queries are returned first", 1,000 rows a page) and Jobs `runs/list`'s
`start_time_from`/`start_time_to` ("descending order by start time", 25 runs a page). Both list running items too, and a
statement or run becomes an event only when it *ends*, which can be hours later
([Query History](https://docs.databricks.com/api/workspace/queryhistory/list),
[runs/list](https://docs.databricks.com/api/workspace/jobs/listruns)).

So each event is keyed on the moment it becomes final: `occurred_at` is the end, and pages list items in
`(end, id hash)` order up to a horizon five minutes before the read. The cursor holds:

- the **listing line** `(e, k)`: every final item at or before it is listed;
- the **running floor** `l` and the **finished floor** `n`: every item not listed yet started at or after one of them,
  so a page re-reads back to them by start time and finds the long statements and runs that finished since;
- a few **tracked ids** `z` (with the end of each finished one): items that started so far back that re-reading to
  them would cost more than reading them by id (`statement_ids`, `runs/get`);
- the **visibility line** `m`: what was still running at the last full page cannot be final before it, so a backlog is
  read slice by slice without re-reading everything behind the line for every page;
- the **slice width** `d`, sized to what a page takes, and a flag so a read answers at most one gap.

Nothing is de-duplicated by a set of ids, so no volume shortens the window. The cursor is at most 964 characters (the
contract's cap is 1,024), whatever the load.

A gap is answered only when something is really dropped, once per read:

- `expired`: the cursor's line, or `since`, is older than the provider keeps (30 days for Query History, the API's
  range; 60 days for runs, which "Databricks retains" for 60 days, [Jobs](https://docs.databricks.com/aws/en/jobs/monitor));
  the read restarts at that edge, from the line the cursor carried;
- `window-truncated`: more than 100,000 statements or 10,000 runs started in one millisecond; or more long-running items
  than the cursor can track (20 statements or 40 runs) *and* more rows behind them than a page reads; or a first read's
  look back before `since` (49 hours for statements, 6 hours for runs) longer than a page reads.

## Known limits

- **Five minutes late, at most one read.** An item is listed by the first read that starts at least five minutes after
  it ended (a statement that ends at +10 min is on the +20 min read). That margin covers Query History and runs/list
  showing a new row, or a final one, within five minutes, and the host's clock running up to that much ahead of
  Databricks'. A row shown later than that, or a clock further ahead, can be missed without a gap.
- **Tied orders.** Both APIs page by token over a fixed start range; the plugin assumes a page token walks that range
  once, and that rows with one start time keep their order between two calls.
- **A first read** looks back 49 hours before `since` for statements (longer than `STATEMENT_TIMEOUT`'s 48-hour
  maximum) and 6 hours for runs. A run that started more than 6 hours before `since` and ended after it is not listed.
- **Deleted items** are not lost history: a tracked run that `runs/get` no longer finds, or can no longer read, is
  dropped without a gap.
- **Signing in to an alias as someone else** keeps the old probe record until the next probe.

## Cost

The event sources read free REST APIs and never touch a warehouse. A page makes one Query History call for about
1,000 statements it reads, plus one for the tracked statements; a runs page makes one `runs/list` call per 25 runs it
reads, plus one `runs/get` per tracked run that is due. Re-reads behind the line are bounded: about 5,000 statements or
250 runs. `databricks.saved` runs one statement on a warehouse that is already running, and charges it to the spend
ledger like every read.

## Live checks before release

1. Query History shows a new statement, and a finished one with `is_final`, within five minutes; `runs/list` likewise.
2. `filter_by.statement_ids` combined with `user_ids` and a 30-day range answers exactly those statements.
3. A page token walks a fixed start range once while new statements start.
4. A skipped run's `end_time` (0, or its start).
