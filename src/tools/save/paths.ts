/**
 * Where `databricks_save` writes (design §8.2 step 7): under `resultsDir` by default, or a path the caller names, but
 * only inside the project, `resultsDir` or the `allowedRoots` option — otherwise `SAVE_PATH_REFUSED`. An existing file
 * is `SAVE_EXISTS` unless `overwrite: true`. The write goes to a temporary name beside the target and is renamed into
 * place, so a failed save never leaves a half-written file under the target's name.
 *
 * `OpenCode`'s own file permissions are asked for too: `edit` on the target, and `external_directory` when the target is
 * outside the project (§4's row for this tool, §15.3's host suite).
 */
import { existsSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { DatabricksError } from "../../domain/errors.js"
import type { Deps } from "../../registry.js"
import type { Call } from "../../tool-spec.js"

export type SaveFormat = "csv" | "jsonl" | "parquet" | "arrow"

const EXTENSION: Record<SaveFormat, string> = { csv: "csv", jsonl: "jsonl", parquet: "parquet", arrow: "arrow" }

const inside = (path: string, root: string): boolean => {
  const rel = relative(resolve(root), resolve(path))
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * The target's absolute path: the caller's, or `<resultsDir>/<statementId>.<ext>`, and never outside the project, the
 * results folder or `allowedRoots`. `statementId` is `pending` while an explicit path is checked before the submit.
 */
export function resolveTarget(input: { path?: string; format: SaveFormat; statementId: string; overwrite?: boolean }, deps: Deps): string {
  const cwd = process.cwd()
  const results = resolve(cwd, deps.options.resultsDir)
  const target = input.path ? resolve(cwd, input.path) : resolve(results, `${input.statementId}.${EXTENSION[input.format]}`)
  const roots = [cwd, results, ...deps.options.allowedRoots.map((root) => resolve(cwd, root))]
  if (!roots.some((root) => inside(target, root))) {
    throw new DatabricksError("SAVE_PATH_REFUSED", "The save path is outside the project, resultsDir and allowedRoots.", `Save under ${deps.options.resultsDir}, or add the folder to allowedRoots.`)
  }
  if (input.path && existsSync(target) && input.overwrite !== true) {
    throw new DatabricksError("SAVE_EXISTS", "A file already exists at the save path.", "Pass overwrite: true, or choose another path.")
  }
  return target
}

/** `edit` on the file, and `external_directory` when it is outside the project (§4). */
export async function assertEdit(target: string, call: Call, deps: Deps): Promise<void> {
  const cwd = process.cwd()
  await deps.permission.assert({ action: "edit", resource: target, sessionID: call.sessionID, messageID: call.messageID, callID: call.id }, call.signal)
  if (!inside(target, cwd)) {
    await deps.permission.assert(
      { action: "external_directory", resource: dirname(target), sessionID: call.sessionID, messageID: call.messageID, callID: call.id },
      call.signal,
    )
  }
}
