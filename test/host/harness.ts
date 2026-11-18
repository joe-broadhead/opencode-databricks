// An embedded OpenCode host from the public @opencode/sdk, with no listener and no private host source, as in
// opencode-github's host tests. The plugin is loaded the way a user loads it: a config `plugins` entry that points at
// this package (its built dist/) with options. A probe plugin lends its context to the tests. The fetch router has no
// target here, so any request off the machine is blocked and fails the host's close(); a test that expects the plugin's
// Databricks port to try (because no fake answers it) says so with `expectBlocked`, and asserts what the report says.
//
// Host version: the SDK in devDependencies (2.2.3). HOST_SDK_DIR names a directory whose node_modules holds another
// @opencode/sdk (scripts/check.mjs installs each tested release outside the lockfile); the host then runs that SDK.
import { ROOT, SDK_OVERRIDE } from "./isolate.js"
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { OpenCodeClient } from "@opencode/client"
import { Plugin } from "@opencode/plugin"
import { PLUGIN_ID } from "../../src/constants.js"
import { routeFetch } from "./route-fetch.js"

import { DatabricksRpc, type Status } from "../../src/rpc.js"

const REPO = realpathSync(fileURLToPath(new URL("../../", import.meta.url)))
const SDK = join(SDK_OVERRIDE ? realpathSync(SDK_OVERRIDE) : REPO, "node_modules", "@opencode", "sdk")
const manifest = JSON.parse(readFileSync(join(SDK, "package.json"), "utf8")) as { version: string; exports: { ".": { import: string } } }
/** The OpenCode release under test: the version of the SDK that runs the host. */
export const SDK_VERSION = manifest.version

if (!existsSync(join(REPO, "dist", "index.js"))) throw new Error("dist/ is missing. Run npm run build first.")

export type Rule = { action: string; resource: string; effect: "allow" | "ask" | "deny" }

/** The SDK's client surface; its own declarations import packages that ship no types. */
export type Client = Omit<OpenCodeClient, "plugin"> & {
  readonly sessions: OpenCodeClient["session"]
  readonly plugin: OpenCodeClient["plugin"]
  readonly close: () => Promise<void>
}

export const router = routeFetch()

/** Removes the temp root and restores fetch; call once after every host in the file has closed. */
export function cleanup() {
  if (router.stale.length > 0) console.warn(`requests from closed hosts, blocked: ${[...new Set(router.stale)].join(", ")}`)
  router.restore()
  rmSync(ROOT, { recursive: true, force: true })
}

const probes = new Map<string, Plugin.Context>()
const probe = Plugin.define({
  id: "databricks.host-test.probe",
  setup: (ctx) => void probes.set(ctx.location.directory, ctx),
})

export interface HostInput {
  /** Plugin options, as a user writes them in opencode.json. */
  readonly options?: Record<string, unknown>
  /** Extra user config, such as permissions or agents. */
  readonly config?: () => Record<string, unknown>
  /** The version the host reports to plugins; defaults to the SDK's. */
  readonly version?: string
  /**
   * The plugin's Databricks port is expected to try to reach a workspace, and the router blocks it: those calls are
   * part of what the test checks (the report says they were unavailable), so `close()` does not fail on them.
   */
  readonly expectBlocked?: boolean
  /** The start's overall bound; HOST_START_MS unless a test of the bound itself sets it. */
  readonly startWithinMs?: number
}

let hosts = 0

/**
 * One host start's overall bound: importing the SDK, creating the host, and waiting for the readiness signal (the
 * plugin's state is reported and the probe plugin has loaded). The first host in a test process pays the cold start:
 * the SDK's import and the first plugin load took 4 to 6 s on 2.3.0 and 5 to 9 s on 2.3.1 on a loaded machine, against
 * under 3 s for every later host. So the bound is generous, and the harness, not the test runner, enforces it: a host
 * that misses it fails with its OpenCode version, the phase and the plugin's last state.
 */
export const HOST_START_MS = 90_000
/**
 * The limit for a hook or test that starts one host. It sits above HOST_START_MS, so the harness's own error is the one
 * a failure shows, never the runner's anonymous "hook timed out" (bun's default for a hook is 5 s).
 */
export const START_HOOK_MS = HOST_START_MS + 30_000

/** Hosts whose start missed its bound, still closing: `settleAbandoned` waits for them. */
const abandoned: Promise<unknown>[] = []
export const settleAbandoned = () => Promise.allSettled(abandoned.splice(0))

/** Settles `work`, or fails at the start's deadline with a message naming the host version and the phase. */
async function within<T>(start: { deadline: number; boundMs: number }, phase: string, work: Promise<T>, abandon?: (value: T) => unknown): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (abandon) abandoned.push(work.then(abandon))
      reject(new Error(`the OpenCode ${SDK_VERSION} host did not ${phase} within ${start.boundMs / 1000} s of starting`))
    }, Math.max(0, start.deadline - Date.now()))
  })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

export async function startHost(input: HostInput = {}) {
  const boundMs = input.startWithinMs ?? HOST_START_MS
  const start = { deadline: Date.now() + boundMs, boundMs }
  const base = join(ROOT, `host-${++hosts}`)
  const work = join(base, "work")
  mkdirSync(work, { recursive: true })
  const blockedBefore = router.blocked.length
  const expectBlocked = input.expectBlocked ?? false
  const config = {
    plugins: [{ package: REPO, options: input.options ?? {} }],
    // Keep the built-in local providers from probing their default ports.
    providers: { lmstudio: { settings: { baseURL: "" } }, ollama: { settings: { baseURL: "" } }, vllm: { settings: { baseURL: "" } } },
    ...input.config?.(),
  }
  const { OpenCode } = (await within(start, "import its SDK", import(pathToFileURL(join(SDK, manifest.exports["."].import)).href))) as typeof import("@opencode/sdk")
  const client = (await within(start, "start", OpenCode.create({
    plugins: [probe],
    // An embedded host reports "unknown" unless told, and the plugin's host check refuses that.
    app: { version: input.version ?? SDK_VERSION },
    config: { content: JSON.stringify(config), directory: join(base, "config"), project: false, claude: false },
    database: { path: join(base, "opencode.db") },
    models: { fetch: false },
    fs: { filewatcher: false },
    log: { level: "error" },
  }), (late) => (late as Client).close())) as Client
  const location = { directory: work }
  const host = {
    client,
    location,
    probe: () => {
      const ctx = probes.get(work)
      if (!ctx) throw new Error("the probe plugin has not loaded")
      return ctx
    },
    async close() {
      await client.close()
      const blocked = router.blocked.slice(blockedBefore)
      if (!expectBlocked && blocked.length > 0) throw new Error(`the host tried to leave the machine: ${[...new Set(blocked)].join(", ")}`)
    },
  }
  // The readiness signal: the host reports the plugin's state (active or failed) and the probe plugin has its context.
  try {
    let state: Awaited<ReturnType<typeof pluginState>>
    for (;;) {
      state = await within(start, "answer its plugin list", pluginState(host))
      if (state !== undefined && probes.has(work)) break
      if (Date.now() > start.deadline) {
        throw new Error(`the OpenCode ${SDK_VERSION} host did not settle within ${boundMs / 1000} s of starting: the plugin's state was ${JSON.stringify(state) ?? "not reported"}, and the probe ${probes.has(work) ? "had" : "had not"} loaded`)
      }
      await Bun.sleep(50)
    }
  } catch (error) {
    await host.close().catch(() => undefined)
    throw error
  }
  return host
}

export type Host = Awaited<ReturnType<typeof startHost>>

export async function until<T>(what: string, check: () => Promise<T | false | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`)
    await Bun.sleep(50)
  }
}

export async function pluginState(host: Host) {
  const { data } = await host.client.plugin.list({ location: host.location })
  return data.find((plugin) => plugin.id === PLUGIN_ID)?.state
}


export const agentRules = async (host: Host) =>
  new Map((await host.client.agent.list({ location: host.location })).data.map((agent) => [agent.id as string, agent.permissions as Rule[]]))

/** The status RPC, called through the probe plugin's context, as opencode-github's host tests call theirs. */
export const status = (host: Host) => host.probe().rpc(DatabricksRpc).status({}) as Promise<Status>

