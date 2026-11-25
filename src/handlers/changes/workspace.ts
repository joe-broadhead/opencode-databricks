/**
 * `databricks_workspace` (design §4): list workspace folders and notebooks, export one notebook's source, and list a
 * Unity Catalog volume's path. Free control-plane reads; it never writes to the workspace (a workspace write is a
 * this version's non-goal, design §2).
 *
 * - A workspace path goes through `GET /api/2.0/workspace/list` (scope `workspace`), whose objects carry `path` and
 *   `object_type` (https://docs.databricks.com/api/workspace-files/v1/list.md).
 * - `export: true` on a notebook reads `GET /api/2.0/workspace/export` with `format=SOURCE`, whose answer is the
 *   base64 `content` and its `file_type` (https://docs.databricks.com/api/workspace-files/v1/export.md). The source is
 *   cut to 32 KiB: it is untrusted text (design §5.8).
 * - A `/Volumes/...` path goes through the Files API (`GET /api/2.0/fs/directories{directory_path}`, scope `files`),
 *   which returns `path`, `is_directory`, `file_size` and `last_modified`
 *   (https://docs.databricks.com/api/files/v2/list-directory-contents.md).
 *
 * The API family is the account's choice (design §3.3), so the path decides which one is required and a missing one is
 * `AUTH_SCOPE_MISSING` before any call.
 */
import { DatabricksError } from "../../domain/errors.js"
import type { Handler } from "../types.js"
import { accountOf, requireFeature } from "./context.js"
import { cutBytes } from "./jobs.js"

/** A notebook's source, cut: §4's 32 KiB for `databricks_workspace`. */
export const SOURCE_LIMIT = 32 * 1024

const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString())

const workspace: Handler<"workspace"> = async (input, call, deps) => {
  const account = accountOf(input, deps)
  const isVolume = /^\/Volumes(\/|$)/u.test(input.path)

  if (isVolume) {
    requireFeature(deps, account, "files", "Listing a volume path")
    const entries = await deps.databricks.listDirectory(account, input.path, call.signal)
    return {
      state: "ok",
      trust: "untrusted",
      items: entries.map((entry) => ({
        path: entry.path,
        kind: entry.isDirectory ? "DIRECTORY" : "FILE",
        ...(entry.size === undefined ? {} : { size: entry.size }),
        ...(iso(entry.modifiedAt) ? { modifiedAt: iso(entry.modifiedAt)! } : {}),
      })),
      ...(input.export ? { next: "A volume path holds files, not notebooks: there is nothing to export." } : {}),
    }
  }

  requireFeature(deps, account, "workspace", "Listing a workspace path")
  const entries = await deps.databricks.listWorkspace(account, input.path, call.signal)
  const items = entries.map((entry) => ({
    path: entry.path,
    kind: entry.objectType,
    ...(entry.size === undefined ? {} : { size: entry.size }),
    ...(iso(entry.modifiedAt) ? { modifiedAt: iso(entry.modifiedAt)! } : {}),
  }))
  if (!input.export) return { state: "ok", trust: "untrusted", items }

  const notebook = entries.find((entry) => entry.path === input.path && entry.objectType === "NOTEBOOK")
  if (!notebook) {
    const shown = input.path.length > 120 ? `${input.path.slice(0, 120)}…` : input.path
    throw new DatabricksError("INPUT_INVALID", `export: true needs a notebook's path, and ${shown} is not a notebook this call listed${entries.length === 0 ? " (the path listed nothing)" : ""}.`, "List the folder first, then pass the notebook's own path with export: true.")
  }
  const exported = await deps.databricks.exportNotebook(account, input.path, call.signal)
  const source = cutBytes(exported.source, SOURCE_LIMIT)
  return { state: "ok", trust: "untrusted", items, source: source.text, ...(source.cut ? { cut: true } : {}) }
}

export default workspace
