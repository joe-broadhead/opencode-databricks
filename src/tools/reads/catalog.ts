/**
 * `databricks_catalog` (design §4): browse Unity Catalog for free — catalogs, then schemas, then the objects of one
 * schema (tables, functions and volumes). It never reads data and never needs a warehouse, so it is the first tool to
 * call on an unfamiliar workspace.
 *
 * - `{}` → catalogs; `{ catalog }` → its schemas; `{ catalog, schema }` → that schema's tables, functions and volumes.
 * - `filter` matches a case-insensitive substring of the name within what was listed; `limit` (default 100) caps the
 *   items returned.
 * - `pageToken` is passed to the Unity Catalog list calls. The objects level unions three lists, so its token is the
 *   tables list's: a page that is full and may hold more says so, and a caller who needs every object pages through
 *   `databricks_catalog` with `pageToken` and a `filter`.
 *
 * Names, comments and owners come from Unity Catalog and are untrusted data (design §5.8): they are never put in
 * `message` or `next`, and the result carries `trust: "untrusted"`.
 */
import { DatabricksError } from "../../domain/errors.js"
import { assertTool } from "../../registry.js"
import type { Handler } from "../../tool-spec.js"
import { accountOf } from "./context.js"

const DEFAULT_LIMIT = 100

interface Item {
  readonly name: string
  readonly kind: string
  readonly comment?: string
  readonly owner?: string
  readonly format?: string
  readonly updatedAt?: string
}

const when = (millis: number | undefined): string | undefined => (millis === undefined ? undefined : new Date(millis).toISOString())

const matching = (items: readonly Item[], filter: string | undefined): Item[] => {
  if (!filter) return [...items]
  const needle = filter.toLowerCase()
  return items.filter((item) => item.name.toLowerCase().includes(needle))
}

const catalog: Handler<"catalog"> = async (input, call, deps) => {
  const account = accountOf(input, deps)
  await assertTool("catalog", account, call, deps)
  const limit = input.limit ?? DEFAULT_LIMIT
  const page = (maxResults?: number) => ({ ...(input.pageToken ? { pageToken: input.pageToken } : {}), ...(maxResults === undefined ? {} : { maxResults }) })
  if (input.schema && !input.catalog) throw new DatabricksError("INPUT_INVALID", "A schema needs its catalog: pass catalog with schema.", "Pass both catalog and schema, or neither.")
  if (!input.catalog) {
    const answer = await deps.databricks.listCatalogs(account, page(limit), call.signal)
    const items = matching(answer.items.map((item) => ({ name: item.name, kind: "catalog", ...(item.comment ? { comment: item.comment } : {}), ...(item.owner ? { owner: item.owner } : {}) })), input.filter)
    return { state: "ok", trust: "untrusted", level: "catalogs" as const, items: items.slice(0, limit), ...(answer.nextPageToken ? { nextPageToken: answer.nextPageToken } : {}) }
  }
  if (!input.schema) {
    const answer = await deps.databricks.listSchemas(account, input.catalog, page(limit), call.signal)
    const items = matching(answer.items.map((item) => ({ name: item.name, kind: "schema", ...(item.comment ? { comment: item.comment } : {}), ...(item.owner ? { owner: item.owner } : {}) })), input.filter)
    return { state: "ok", trust: "untrusted", level: "schemas" as const, items: items.slice(0, limit), ...(answer.nextPageToken ? { nextPageToken: answer.nextPageToken } : {}) }
  }
  const [tables, functions, volumes] = await Promise.all([
    deps.databricks.listTables(account, input.catalog, input.schema, page(limit), call.signal),
    deps.databricks.listFunctions(account, input.catalog, input.schema, page(), call.signal),
    deps.databricks.listVolumes(account, input.catalog, input.schema, page(), call.signal),
  ])
  const items: Item[] = [
    ...tables.items.map((item) => ({ name: item.name, kind: item.tableType.toLowerCase() || "table", ...(item.comment ? { comment: item.comment } : {}), ...(item.owner ? { owner: item.owner } : {}), ...(when(item.updatedAt) ? { updatedAt: when(item.updatedAt)! } : {}) })),
    ...functions.items.map((item) => ({ name: item.name, kind: "function" })),
    ...volumes.items.map((item) => ({ name: item.name, kind: `volume:${item.volumeType.toLowerCase()}` })),
  ]
  const sorted = matching(items, input.filter).sort((left, right) => (left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind.localeCompare(right.kind)))
  const nextPageToken = tables.nextPageToken
  return { state: "ok", trust: "untrusted", level: "objects" as const, items: sorted.slice(0, limit), ...(nextPageToken ? { nextPageToken } : {}) }
}

export default catalog
