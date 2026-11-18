/**
 * Where `databricks_save` writes (design §8.2 step 7): under `resultsDir` by default, or a path the caller names, but
 * only inside the project, `resultsDir` or the `allowedRoots` option — otherwise `SAVE_PATH_REFUSED`. An existing file
 * is `SAVE_EXISTS` unless `overwrite: true`. The write goes to a temporary name beside the target and is renamed into
 * place, so a failed save never leaves a half-written file under the target's name.
 *
 * `OpenCode`'s own file permissions are asked for too: `edit` on the target, and `external_directory` when the target is
 * outside the project (§4's row for this tool, §15.3's host suite).
 *
 * Every comparison is between **real paths**: the target's deepest existing ancestor and every root are resolved with
 * `realpath`, so a symlinked folder under an allowed root cannot carry a save outside every root, and the permissions
 * are asked for the real path. A dangling symlink on the way is refused. The temporary file is opened with
 * `O_CREAT | O_EXCL | O_NOFOLLOW` (`openTemporary`), so a link planted at its name is never followed.
 */
import { constants, existsSync, lstatSync, openSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { DatabricksError } from "../../domain/errors.js"
import type { Deps } from "../../registry.js"
import type { Call } from "../../tool-spec.js"

export type SaveFormat = "csv" | "jsonl" | "parquet" | "arrow"

const EXTENSION: Record<SaveFormat, string> = { csv: "csv", jsonl: "jsonl", parquet: "parquet", arrow: "arrow" }

const inside = (path: string, root: string): boolean => {
  const rel = relative(resolve(root), resolve(path))
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

const refused = () => new DatabricksError("SAVE_PATH_REFUSED", "The save path is outside the project, resultsDir and allowedRoots.", "Save under the results folder, or add the folder to allowedRoots.")

/**
 * The real path of `path`, which need not exist yet: the deepest ancestor that exists, resolved by `realpath`, and the
 * rest appended. An existing entry that cannot be resolved (a dangling or looping symlink) is refused.
 */
export function realPathOf(path: string): string {
  const absolute = resolve(path)
  const rest: string[] = []
  let at = absolute
  for (;;) {
    let exists = false
    try {
      lstatSync(at)
      exists = true
    } catch {
      exists = false
    }
    if (exists) {
      let real: string
      try {
        real = realpathSync.native(at)
      } catch {
        throw refused()
      }
      return rest.length === 0 ? real : join(real, ...rest.reverse())
    }
    const parent = dirname(at)
    if (parent === at) return absolute
    rest.push(basename(at))
    at = parent
  }
}

/** A new temporary file beside the target: created exclusively, never through a link. */
export function openTemporary(path: string): number {
  return openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
}

/** True when the folder that will hold `target` still resolves to itself: no link was put on the way since the check. */
export function folderIsReal(target: string): boolean {
  try {
    return realpathSync.native(dirname(target)) === dirname(target)
  } catch {
    return false
  }
}

/**
 * The target's absolute path: the caller's, or `<resultsDir>/<statementId>.<ext>`, and never outside the project, the
 * results folder or `allowedRoots`. `statementId` is `pending` while an explicit path is checked before the submit.
 */
export function resolveTarget(input: { path?: string; format: SaveFormat; statementId: string; overwrite?: boolean }, deps: Deps): string {
  const cwd = process.cwd()
  const results = resolve(cwd, deps.options.resultsDir)
  const lexical = input.path ? resolve(cwd, input.path) : resolve(results, `${input.statementId}.${EXTENSION[input.format]}`)
  // Both sides as real paths: a symlinked folder under a root is followed to where it really points before the check.
  const target = realPathOf(lexical)
  const roots = [cwd, results, ...deps.options.allowedRoots.map((root) => resolve(cwd, root))].map(realPathOf)
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
  const cwd = realPathOf(process.cwd())
  await deps.permission.assert({ action: "edit", resource: target, sessionID: call.sessionID, messageID: call.messageID, callID: call.id }, call.signal)
  if (!inside(target, cwd)) {
    await deps.permission.assert(
      { action: "external_directory", resource: dirname(target), sessionID: call.sessionID, messageID: call.messageID, callID: call.id },
      call.signal,
    )
  }
}
