/**
 * The automation's owner lock: one process per machine is the sweep's owner, so several OpenCode processes do not each
 * spend the same free calls; status reports which process owns it.
 *
 * A real lock, not a timestamp guess (review of F, M1):
 * - the file holds this process's random token and the time it last refreshed it, written `O_EXCL` (`wx`), so only one
 *   process creates it;
 * - its holder refreshes the timestamp on every sweep; another process may take it only when the timestamp is older than
 *   `LOCK_STALE_MS`;
 * - a stale takeover unlinks and then creates, and the create is `O_EXCL`, so of two processes racing for a stale lock
 *   only one wins. The unlink itself is not conditional on the timestamp it read, which is the residual race: the loser
 *   of the create sees `EEXIST` and simply does not own;
 * - release and refresh only touch a file whose token is ours, so a process that lost the lock cannot delete the new
 *   owner's.
 */
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { dirname } from "node:path"

/** A lock older than this belongs to a dead process: three sweeps at two minutes, with room for a slow one. */
export const LOCK_STALE_MS = 6 * 60_000

export class OwnerLock {
  private readonly token = randomUUID()

  constructor(readonly path: string) {}

  /** Takes the lock, keeps it if it is already ours, or takes it over when its holder is stale. */
  refresh(now: number): boolean {
    let text: string
    try {
      text = readFileSync(this.path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false
      return this.create(now)
    }
    const [token, stamp] = text.split("\n")
    if (token === this.token) {
      try {
        writeFileSync(this.path, this.line(now), { mode: 0o600 })
        return true
      } catch {
        return false
      }
    }
    const at = Number(stamp)
    if (!Number.isFinite(at) || now - at < LOCK_STALE_MS) return false
    try {
      unlinkSync(this.path)
    } catch {
      // Another process took it first; the create below decides.
    }
    return this.create(now)
  }

  /** Whether the lock is ours and fresh, without taking it. */
  owned(now: number): boolean {
    try {
      const [token, stamp] = readFileSync(this.path, "utf8").split("\n")
      return token === this.token && Number(stamp) <= now && now - Number(stamp) < LOCK_STALE_MS
    } catch {
      return false
    }
  }

  /** Removes the lock, only when it is ours. */
  release(): void {
    try {
      const [token] = readFileSync(this.path, "utf8").split("\n")
      if (token === this.token) rmSync(this.path, { force: true })
    } catch {
      // Already gone, or another process's: leave it.
    }
  }

  private line(now: number): string {
    return `${this.token}\n${now}`
  }

  private create(now: number): boolean {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      writeFileSync(this.path, this.line(now), { flag: "wx", mode: 0o600 })
      return true
    } catch {
      return false
    }
  }
}
