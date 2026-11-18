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
- the **tracked items** `z`: items found again by key instead of by the floors — anything shown running for more than
  five minutes, while there is room, and finished items whose start lies far back. A tracked item is listed whenever
  it is final, wherever its end falls, so its final state may lag by any amount. A run is tracked by its id
  (delta-encoded, about 100 fit; read back with `runs/get`). A statement is tracked by a **reference**, the second it
  started and 12 bits of its id's hash (about 7 characters, so about 70 fit, where 24 full ids did): the walk behind
  the line finds it, or a one-second Query History read does. A reference is admitted only when no other statement of
  yours started in that second with the same hash, and every statement of a second is shown within five minutes of it,
  so a reference names exactly one statement: it can neither lose one nor list one twice. An item is admitted only if
  the set still fits once every entry is finished, so the set never has to drop one;
- the **visibility line** `m`: a backlog is read slice by slice without re-reading everything behind the line for
  every page;
- the **slice width** `d`, sized to what a page takes, a time `t` for the lag check, the lag episode's state (`r`,
  `h`; below), and a flag so a read answers at most one gap.

**The line is held at the oldest untracked item still shown running.** A row shown running may already have ended
with its final state lagging, so the line never passes its start, but it never waits more than 75 minutes behind the
read. Since items running longer than five minutes are tracked by id while there is room, the hold matters only when
more items run at once than the cursor tracks.

**A lag episode widens the hold.** When a tracked item proves that Databricks showed a final state more than 75
minutes after its end, the hold widens to that lag plus 15 minutes (at most 12 hours) until a day passes without such
proof. A gap is answered for the episode only if the line passed an untracked running item, under a shorter hold, since
the last such gap; then once, from where that happened, and the model's tool says what was seen in its `message`.
Proof with no such pass lost nothing, and answers no gap.

Nothing is de-duplicated by a set of ids, so no volume shortens the window. The cursor is at most 1,006 characters (the
contract's cap is 1,024), whatever the load.

A gap is answered only when coverage is really lost, once per read:

- `expired`: the cursor's line, or `since`, is older than the provider keeps (30 days for Query History, the API's
  range; 60 days for runs, which "Databricks retains" for 60 days, [Jobs](https://docs.databricks.com/aws/en/jobs/monitor));
  the read restarts at that edge, from the line the cursor carried;
- `window-truncated`: more than 100,000 statements or 10,000 runs started in one millisecond; or the tracked set is full
  *and* re-walking back to an item would take more than a behind-walk reaches (16,000 statements or 12,000 runs); or a
  first read's look back before `since` (49 hours for statements, 6 hours for runs) longer than a walk reaches; or, once
  per lag episode, a proven lag longer than the hold the line passed an untracked running item under.

## Known limits

- **Latency.** An item is listed by the first read at least five minutes after it ended. Measured at 300 of your
  statements an hour with 5% running 1–6 hours, read every 5 minutes: every statement within 10 minutes of its end
  (before statement references: 2,972 of 3,548 more than 20 minutes late, up to 80). The line waits longer only when
  more items run for over five minutes at once than the cursor tracks — about 70 of your statements, or about 100 of
  the workspace's runs — and then for at most 75 minutes (plus one read interval) behind the oldest untracked one;
  during a lag episode, for the widened hold.
- **Final states that lag.** A tracked item is listed whatever the lag. An untracked one is safe while its final state
  shows within the hold of its end (75 minutes, or the widened hold during a lag episode). Measured at a 2-hour lag, 300
  an hour, read every 5 minutes: nothing lost, and one gap for the episode (queries and runs alike); at 60 an hour, no
  gap at all.
- **New rows.** A statement or run must appear in the list within five minutes of starting, and the host's clock must
  be within that of Databricks'. A row that appears later, or a clock further ahead, can be missed without a gap.
- **Tied orders.** Both APIs page by token over a fixed start range; the plugin assumes a page token walks that range
  once, and that rows with one start time keep their order between two calls.
- **A first read** looks back 49 hours before `since` for statements (longer than `STATEMENT_TIMEOUT`'s 48-hour
  maximum) and 6 hours for runs. A run that started more than 6 hours before `since` and ended after it is not listed.
- **Deleted items** are not lost history: a tracked run that `runs/get` no longer finds, or can no longer read, is
  dropped without a gap.
- **Signing in to an alias as someone else** keeps the old probe record until the next probe.

## Cost

The event sources read free REST APIs and never touch a warehouse. A queries page makes one Query History call for
about 1,000 statements it reads, plus a one-second read for each tracked statement that is due and not behind the line
within reach of the walk. A runs read makes one `runs/list` call per 25 runs it reads (and per 25 rows it re-walks
behind the line), plus one `runs/get` per tracked run (running ones once a read, finished ones when due).

Measured on the simulated workspace (calls per read, all pages of the read):

| Load | Calls a read |
|---|---|
| 300 statements an hour, 5% running 1–6 h, read every 5 min | about 3 |
| 200 statements an hour, 10% running 20–47 h, read hourly | about 65 |
| 600 runs an hour, 5% running 1–6 h, read hourly | about 300 (60 `runs/list`, 240 `runs/get`) |
| 200 runs an hour, 10% running 20–47 h, read hourly (24 h of it) | about 135 (the review measured about 170) |
| the same, sustained for 72 h (about 670 day-long runs at once) | about 505, mostly `runs/list` re-walking up to 12,000 runs back |
| 300 runs an hour with final states 60 minutes late, read every 5 min | about 115 (the review measured about 78) |

`databricks.saved` runs one statement on a warehouse that is already running, and charges it to the spend ledger like
every read.

## Live checks before release

1. Query History shows a new statement within five minutes, and its final state (`is_final`) within 75 minutes of its
   end; `runs/list` likewise for a run's terminal state.
2. `filter_by.query_start_time_range` of one second, with `user_ids`, answers every statement of yours that started in
   it.
3. A page token walks a fixed start range once while new statements start.
4. A skipped run's `end_time` (0, or its start).
