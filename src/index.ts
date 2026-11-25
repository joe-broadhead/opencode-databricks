/**
 * The server entry: one `Plugin.define`, one `register` call. `register` wires every method through the agent tool, Code
 * Mode and RPC doors, resolves the account, generates the access rules and carries the bus events; this file only builds
 * the plugin's ports, handlers and packaged skills.
 */
import { Plugin } from "@opencode/plugin"
import { assertHost, register } from "@we-the-rebel-alliance/plugin-contract/register"
import { createAuth } from "./accounts.js"
import { manifest, version } from "./manifest.js"
import { loadOptions } from "./options.js"
import { createDatabricksClient } from "./provider/client.js"
import { createReadGuard } from "./provider/guards/read.js"
import { createLedger } from "./provider/ledger.js"
import { createHandlers } from "./handlers/index.js"
import { readSkills, registerSkills } from "./skills.js"
import type { Deps } from "./handlers/deps.js"

export default Plugin.define({
  id: manifest.plugin.name,
  async setup(ctx) {
    assertHost(ctx, manifest)
    // Check every skill before anything registers, so a malformed file fails setup with one clear error.
    const skills = readSkills()
    const skillRegistration = await registerSkills(ctx, skills)
    try {
      const options = loadOptions(ctx.options)
      const auth = await createAuth({ ctx, manifest, options })
      const ports = {
        options,
        access: options.access,
        auth: auth.port,
        databricks: createDatabricksClient({ auth: auth.port }),
        ledger: createLedger(),
        clock: { now: Date.now, uuid: () => crypto.randomUUID() },
      }
      const deps: Deps = { ...ports, reads: createReadGuard(ports) }
      const handlers = createHandlers({
        deps,
        manifest,
        version,
        hostVersion: ctx.app.version,
        accountProblems: auth.problems,
      })
      const registration = await register(ctx, manifest, handlers)
      return async () => {
        await skillRegistration.dispose()
        await registration.dispose()
      }
    } catch (error) {
      await skillRegistration.dispose().catch(() => undefined)
      throw error
    }
  },
})
