# Automations

Read a source with an OpenCode automation that keeps its cursor in the automation's state. `events_list` answers
`more`; keep the cursor it returns and pass it back on the next run.

```ts
const page = await tools.databricks.events_list({ source: "queries", account: "work", cursor: state?.cursor })
return {
  state: { cursor: page.cursor },
  ...(page.events.length > 0 ? { send: { prompt: "New Databricks statements: review them." } } : {}),
}
```

A missed bus event costs a re-read, never data.

<!-- generated:automations -->
| Source | Method | Provider floor | Suggested | Signals |
|---|---|---|---|---|
| `databricks.queries` | `tools.databricks.events_list` | — | 2 min | `bus` |
| `databricks.runs` | `tools.databricks.events_list` | — | 5 min | `bus` |
<!-- /generated:automations -->
