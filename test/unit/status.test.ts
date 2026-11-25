import { describe, expect, it } from "vitest"
import { createStatusHandler } from "../../src/handlers/status.js"
import type { Deps } from "../../src/handlers/deps.js"
import { manifest, version } from "../../src/manifest.js"

const deps = {
  options: { accounts: {} },
  auth: {
    account: () => ({ alias: "default", mode: "pat", host: "https://example.cloud.databricks.com", cloud: "aws", features: [], enforcement: "identity" }),
    accounts: () => [],
    token: async () => ({ accessToken: "x", expiresAt: 0, scopes: [], host: "https://example.cloud.databricks.com" }),
  },
  databricks: { me: async () => ({ id: "42", userName: "ana@example.com", displayName: "Ana" }) },
} as unknown as Deps

const call = {
  sessionID: "s",
  agent: "a",
  messageID: "m",
  id: "c",
  signal: new AbortController().signal,
  account: "default",
  progress: async () => {},
  bus: {},
  access: { rules: [] },
  unguardedAgents: async () => ({ ok: true, agents: [] }),
  door: "rpc",
} as never

describe("status", () => {
  it("answers the contract's status shape from the call, not from post-register state", async () => {
    const handler = createStatusHandler({ manifest, version, hostVersion: "2.4.1", deps, accountProblems: [] })
    const answer = (await handler.run({}, call)) as {
      name: string
      version: string
      host: { version: string; range: string; tested: string[] }
      state: string
      accounts: { alias: string; state: string; owner?: { id: string } }[]
      unguardedAgents: string[]
      nextStep: string | null
    }
    expect(answer.name).toBe("databricks")
    expect(answer.version).toBe(version)
    expect(answer.host).toEqual({ version: "2.4.1", range: ">=2.4.1 <2.5.0", tested: ["2.4.1"] })
    expect(answer.state).toBe("ready")
    expect(answer.accounts[0]).toMatchObject({ alias: "default", state: "ready", owner: { id: "mailto:ana@example.com" } })
    expect(answer.unguardedAgents).toEqual([])
    expect(answer.nextStep).toBeNull()
  })
})
