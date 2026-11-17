// The credential-store read (review of #5, M4's mitigation): a failed resolve is retried once, so a rotation another
// process finished is picked up; a credential that is still broken answers AUTH_REQUIRED, and a stopped call CANCELLED.
import { describe, expect, it } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import { readHostCredential, type HostCredentialStore } from "../../../src/auth/host-credential.js"
import type { HostConnection, HostCredential } from "../../../src/auth/types.js"
import { hostCredential } from "./support.js"

const connection: HostConnection = { type: "credential", id: "credential_1" }
const signal = () => new AbortController().signal

function store(resolve: () => Promise<HostCredential | undefined>): { port: HostCredentialStore; calls: () => number } {
  let calls = 0
  return {
    calls: () => calls,
    port: {
      active: async () => connection,
      resolve: async () => {
        calls += 1
        return resolve()
      },
    },
  }
}

describe("reading a stored credential", () => {
  it("returns the first resolve when it works", async () => {
    const { port, calls } = store(async () => hostCredential())
    const credential = await readHostCredential(port, "work", signal())
    expect(credential?.access).toBeTruthy()
    expect(calls()).toBe(1)
  })

  it("retries once after a failure, for a rotation another process just stored", async () => {
    let attempt = 0
    const { port, calls } = store(async () => {
      attempt += 1
      if (attempt === 1) throw new Error("invalid_grant, the other process rotated first")
      return hostCredential({ access: "the-other-process-token" })
    })
    const credential = await readHostCredential(port, "work", signal())
    expect(credential?.access).toBe("the-other-process-token")
    expect(calls()).toBe(2)
  })

  it("reports AUTH_REQUIRED when both reads fail, and returns undefined when there is no sign-in", async () => {
    const { port, calls } = store(async () => Promise.reject(new DatabricksError("AUTH_REQUIRED", "refresh failed", "sign in again")))
    const error = (await readHostCredential(port, "work", signal()).catch((caught: unknown) => caught)) as DatabricksError
    expect(error.code).toBe("AUTH_REQUIRED")
    expect(calls()).toBe(2)

    const absent: HostCredentialStore = { active: async () => undefined, resolve: async () => undefined }
    await expect(readHostCredential(absent, "work", signal())).resolves.toBeUndefined()
  })

  it("stops before a read when the call is already aborted", async () => {
    const { port, calls } = store(async () => hostCredential())
    const controller = new AbortController()
    controller.abort()
    const error = (await readHostCredential(port, "work", controller.signal).catch((caught: unknown) => caught)) as DatabricksError
    expect(error.code).toBe("CANCELLED")
    expect(calls()).toBe(0)
  })
})
