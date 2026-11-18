/**
 * Fixtures for the Workspace, Files and Statement Execution calls package D makes, copied from Databricks' REST
 * reference on 17 Nov 2026. Each block names the page it came from; none of these fields is invented.
 */
import type { Fixture } from "./jobs.js"

/**
 * `GET /api/2.0/workspace/list`: "Lists the contents of a directory, or the object if it is not a directory. If the
 * input path does not exist, this call returns an error `RESOURCE_DOES_NOT_EXIST`." Query: `path` (required),
 * `notebooks_modified_after`. Response: `objects[]` of `ObjectInfo`: `path`, `object_type` (`DIRECTORY`, `NOTEBOOK`,
 * `FILE`, `LIBRARY`, `REPO`), `object_id`, and `language` for a notebook.
 * https://docs.databricks.com/api/workspace-files/v1/list.md
 */
export const WORKSPACE_LIST: Fixture = {
  method: "GET",
  path: "/api/2.0/workspace/list",
  cite: "https://docs.databricks.com/api/workspace-files/v1/list.md",
  query: ["path", "notebooks_modified_after"],
  queryRequired: ["path"],
}
/**
 * The reference's response shape, with this repository's invented values: the example's own paths are replaced, because
 * every value in this repository is invented (AGENTS.md), and the reference's own home-style paths are indistinguishable
 * from a developer's local ones, which `npm run lint` refuses.
 */
export const WORKSPACE_LIST_RESPONSE = {
  objects: [
    { path: "/Shared/project", object_type: "DIRECTORY", object_id: 123 },
    { path: "/Shared/PythonExampleNotebook", language: "PYTHON", object_type: "NOTEBOOK", object_id: 456 },
  ],
} as const

/**
 * `GET /api/2.0/workspace/export`: "Exports an object or the contents of an entire directory." Query: `path`
 * (required), `format` (`SOURCE` default, `HTML`, `JUPYTER`, `DBC`, `R_MARKDOWN`, `AUTO`, `RAW`), `direct_download`.
 * Response: `content` (the base64-encoded content) and `file_type` ("the file extension that matches the exported
 * content"). "If the content exceeds the size limit (10 MB), the call fails with `MAX_NOTEBOOK_SIZE_EXCEEDED`."
 * https://docs.databricks.com/api/workspace-files/v1/export.md
 */
export const WORKSPACE_EXPORT: Fixture = {
  method: "GET",
  path: "/api/2.0/workspace/export",
  cite: "https://docs.databricks.com/api/workspace-files/v1/export.md",
  query: ["path", "format", "direct_download"],
  queryRequired: ["path"],
}
export const WORKSPACE_EXPORT_FORMATS = ["SOURCE", "HTML", "JUPYTER", "DBC", "R_MARKDOWN", "AUTO", "RAW"] as const
/** The reference's own response example ("// Databricks notebook source\n1+1" in base64). */
export const WORKSPACE_EXPORT_RESPONSE = { content: "Ly8gRGF0YWJyaWNrcyBub3RlYm9vayBzb3VyY2UKMSsx", file_type: "scala" } as const

/**
 * `GET /api/2.0/fs/directories{directory_path}`: "Returns the contents of a directory. If there is no directory at the
 * specified path, the API returns an HTTP 404 error." Query: `page_size` (default 1000), `page_token`. Response:
 * `contents[]` of `DirectoryEntry` (`path`, `is_directory`, `file_size`, `last_modified`, `name`) and
 * `next_page_token`.
 * https://docs.databricks.com/api/files/v2/list-directory-contents.md
 */
export const FILES_LIST_DIRECTORY: Fixture = {
  method: "GET",
  path: "/api/2.0/fs/directories/{directory_path}",
  cite: "https://docs.databricks.com/api/files/v2/list-directory-contents.md",
  query: ["page_size", "page_token"],
}
export const FILES_LIST_DIRECTORY_RESPONSE = {
  contents: [{ file_size: 0, is_directory: true, last_modified: 0, name: "string", path: "string" }],
  next_page_token: "string",
} as const

/**
 * `POST /api/2.0/sql/statements`: "Execute a SQL statement and optionally await its results for a specified time."
 * Body: `statement` and `warehouse_id` (required), `catalog`, `schema`, `row_limit`, `byte_limit`, `format`,
 * `disposition`, `wait_timeout`, `on_wait_timeout`, `parameters`, `query_tags`. "If the SQL warehouse fails to execute
 * the provided statement, a 200 response is returned with `status.state` set to `FAILED` … Details of the error can be
 * found at `status.error`". "StatementResponse contains `statement_id` and `status`; other fields might be absent or
 * present depending on context."
 * https://docs.databricks.com/api/statement-execution/v1/execute-statement.md
 */
export const EXECUTE_STATEMENT: Fixture = {
  method: "POST",
  path: "/api/2.0/sql/statements",
  cite: "https://docs.databricks.com/api/statement-execution/v1/execute-statement.md",
  required: ["statement", "warehouse_id"],
  optional: ["catalog", "schema", "row_limit", "byte_limit", "format", "disposition", "wait_timeout", "on_wait_timeout", "parameters", "query_tags"],
}
/** `wait_timeout`: "can be set to 0 or to a value between 5 and 50". */
export const WAIT_TIMEOUT = { zeroAllowed: true, min: 5, max: 50 } as const
export const DISPOSITIONS = ["INLINE", "EXTERNAL_LINKS"] as const

/** The reference's "Statement succeeeded with INLINE data" response, verbatim. */
export const STATEMENT_SUCCEEDED_INLINE = {
  manifest: {
    format: "JSON_ARRAY",
    schema: { column_count: 1, columns: [{ name: "id", position: 0, type_name: "LONG", type_text: "BIGINT" }] },
  },
  result: { chunk_index: 0, data_array: [["0"], ["1"], ["2"]], row_count: 3, row_offset: 0 },
  statement_id: "01eda0e7-e315-1846-84e2-79a963ffad44",
  status: { state: "SUCCEEDED" },
} as const

/**
 * The same documented response shape for a statement with no result set: the reference says `StatementResponse`
 * contains `statement_id` and `status`, and "other fields might be absent or present depending on context" — which is
 * what a DDL statement's answer is. Nothing here claims a manifest the API did not send.
 */
export const STATEMENT_SUCCEEDED_NO_RESULT = {
  statement_id: "01eda0e7-e315-1846-84e2-79a963ffad45",
  status: { state: "SUCCEEDED" },
} as const

/** The reference's "Statement failed with syntax errror" response, verbatim. */
export const STATEMENT_FAILED = {
  statement_id: "01ee48eb-5124-1922-bb90-f98c82f024fe",
  status: { error: { error_code: "BAD_REQUEST", message: "[PARSE_SYNTAX_ERROR] Syntax error at or near ..." }, state: "FAILED" },
} as const

/**
 * `POST /api/2.0/sql/statements/{statement_id}/cancel`: "Requests that an executing statement be canceled."
 * https://docs.databricks.com/api/statement-execution/v1/cancel-statement.md
 */
export const CANCEL_STATEMENT: Fixture = { method: "POST", path: "/api/2.0/sql/statements/{statement_id}/cancel", cite: "https://docs.databricks.com/api/statement-execution/v1/cancel-statement.md" }

/**
 * `GET /api/2.0/sql/history/queries`: "List queries." Query: `filter_by`, `max_results` (≤ 1000), `page_token`,
 * `include_metrics`. Response: `res[]` of `QueryInfo`, `next_page_token`, `has_more`.
 * `QueryInfo.statement_type` is one of `OTHER`, `ALTER`, `ANALYZE`, `COPY`, `CREATE`, `DELETE`, `DESCRIBE`, `DROP`,
 * `EXPLAIN`, `GRANT`, `INSERT`, `MERGE`, `OPTIMIZE`, `REFRESH`, `REPLACE`, `REVOKE`, `SELECT`, `SET`, `SHOW`,
 * `TRUNCATE`, `UPDATE`, `USE`.
 * https://docs.databricks.com/api/query-history/v1/list-queries.md and `…/query-history/object.md`
 */
export const QUERY_HISTORY: Fixture = {
  method: "GET",
  path: "/api/2.0/sql/history/queries",
  cite: "https://docs.databricks.com/api/query-history/v1/list-queries.md",
  query: ["filter_by", "max_results", "page_token", "include_metrics"],
}
export const QUERY_HISTORY_MAX_RESULTS = 1000
export const QUERY_HISTORY_RESPONSE = {
  res: [
    {
      query_id: "01eda0e7-e315-1846-84e2-79a963ffad44",
      status: "FINISHED",
      statement_type: "DELETE",
      warehouse_id: "abcdef0123456789",
      user_id: 42,
      query_start_time_ms: 1763400000000,
      query_end_time_ms: 1763400001400,
      duration: 1400,
      rows_produced: 3,
      is_final: true,
      query_text: "delete from main.s.t where id = 1",
    },
  ],
  next_page_token: "",
  has_more: false,
} as const

/**
 * The same documented `StatementResponse` with `manifest.total_row_count`, the reference's own field ("The total number
 * of rows in the result set"): a commit reports its affected rows from it (design §5.5). The value is invented; the
 * column is the reference's own `id`/`LONG` example, so nothing here claims a field or a column the API does not send.
 */
export const STATEMENT_SUCCEEDED_WITH_ROW_COUNT = {
  manifest: {
    format: "JSON_ARRAY",
    schema: { column_count: 1, columns: [{ name: "id", position: 0, type_name: "LONG", type_text: "BIGINT" }] },
    total_row_count: 3,
    total_chunk_count: 1,
  },
  statement_id: "01eda0e7-e315-1846-84e2-79a963ffad46",
  status: { state: "SUCCEEDED" },
} as const
