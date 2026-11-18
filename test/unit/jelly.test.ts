/**
 * The `jelly` section of package.json, which Jelly reads without loading the plugin. The shared kit checks it against
 * Jelly's plugin authors' standard; the tests below add what only Databricks declares:
 *
 * - declared equals the registry plus the three permission-only entries (`databricks.start`, `databricks.probe`,
 *   `databricks.read`), with
 *   each tool's readOnly and note from the one tool table;
 * - a port of Jelly's `accessRules` over every action the plugin can assert gives design §10.3's table at all three
 *   levels, and the plugin's own default rules agree with it;
 * - the write disclosure appears verbatim in its five places, and the policy disclosure in the sign-in;
 * - with an export of Jelly's contracts at hand (`JELLY_CONTRACTS`: the `protocol/contracts/src` folder of a
 *   `git archive` of Jelly's default branch, with zod resolvable from it), the declaration also passes Jelly's own
 *   `PluginDeclarationSchema`, with and without `sources`, and the restated `effectOfAccess` equals Jelly's. CI has
 *   no export, so that case is skipped there.
 */
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { ACCESS_VALUES } from "../../src/constants.js"
import { actionOf, DECLARED_ACTIONS, PERMISSION_ONLY, START_ACTION, TOOLS } from "../../src/domain/actions.js"
import { POLICY_DISCLOSURE, WRITE_DISCLOSURE } from "../../src/domain/contract.js"
import { loadOptions } from "../../src/options.js"
import { defaultRules, effectOf } from "../../src/permissions.js"
import { REGISTERED } from "../../src/registry.js"
import { SKILL_IDS } from "../../src/skills.js"
import { type Declaration, type DeclaredTool, declarationProblems, docProblems, effectFromRules, lineProblems, readPackage } from "../support/jelly-kit.js"
import { ACCESS_CHOICES, type PluginSetting, settingsProblems } from "../support/jelly-settings.js"

const ROOT = new URL("../../", import.meta.url)
const manifest = readPackage(ROOT)
type SignIn = { id: string; label: string; integration: string; scopes: string[]; needed: string[]; account: { description: string }; relay: unknown; help: unknown }
const jelly = manifest.jelly as Declaration & { tools: DeclaredTool[]; signIns: SignIn[]; contributes: { settings: PluginSetting[] } }

describe("the jelly declaration", () => {
  it("follows the plugin authors' standard, with the effects the plugin's own default rules give", () => {
    // A declared `ask` means "asks at Ask before changes" in Jelly (effectOfAccess), so databricks.start's declared
    // effect is compared with the plugin's ask-changes rules; every other entry with its default (all) rules.
    const atAll = effectFromRules(defaultRules("all"))
    const atAsk = effectFromRules(defaultRules("ask-changes"))
    const effectOf = (permission: string) => (permission === START_ACTION ? atAsk(permission) : atAll(permission))
    expect(declarationProblems(ROOT, { effectOf, registered: DECLARED_ACTIONS, actionPermissions: true })).toEqual([])
  })

  it("declares the registry's 23 tools and the three permission-only entries, 26 in all, 17 read-only", () => {
    expect(jelly.tools.map((tool) => tool.permission)).toEqual([...REGISTERED.map(actionOf), ...PERMISSION_ONLY.map((entry) => entry.action)])
    expect(jelly.tools).toHaveLength(26)
    expect(jelly.tools.filter((tool) => tool.readOnly)).toHaveLength(17)
    for (const tool of TOOLS) {
      const declared = jelly.tools.find((entry) => entry.permission === actionOf(tool.name))!
      expect(declared, tool.name).toEqual({ name: actionOf(tool.name), permission: actionOf(tool.name), effect: "allow", readOnly: tool.readOnly, ...("note" in tool ? { note: tool.note } : {}) })
    }
    for (const entry of PERMISSION_ONLY) expect(jelly.tools.find((tool) => tool.permission === entry.action)).toEqual({ name: entry.action, permission: entry.action, effect: entry.effect, readOnly: true, ...("note" in entry ? { note: entry.note } : {}) })
  })

  it("declares the skills the plugin registers", () => {
    expect(jelly.skills).toEqual([...SKILL_IDS])
  })

  it("declares one sign-in group per workspace, with the scopes' sorted union, the relay fields and its codes", () => {
    expect(jelly.signIns).toHaveLength(1)
    const signIn = jelly.signIns[0]!
    expect(signIn).toMatchObject({ id: "databricks", label: "Databricks workspace", integration: "databricks-*", relay: { redirectField: "redirectUri", portField: "callbackPort" }, needed: ["AUTH_REQUIRED", "AUTH_SCOPE_MISSING"] })
    expect(signIn.scopes).toEqual([...signIn.scopes].sort())
    expect(signIn.scopes).toEqual(["all-apis", "email", "files", "jobs", "offline_access", "openid", "profile", "query-history", "sql", "unity-catalog", "workspace"])
    expect(signIn.account.description.length).toBeLessThanOrEqual(500)
  })

  it("says the write disclosure verbatim in its five places, and the policy disclosure at sign-in (round 3, LOW 1)", () => {
    const flat = (text: string) => text.replace(/\n> /g, " ").replace(/\n\s*/g, " ")
    expect(flat(readFileSync(new URL("README.md", ROOT), "utf8"))).toContain(WRITE_DISCLOSURE)
    expect(flat(readFileSync(new URL("skills/opencode-databricks/SKILL.md", ROOT), "utf8"))).toContain(WRITE_DISCLOSURE)
    expect(jelly.signIns[0]!.account.description).toContain(WRITE_DISCLOSURE)
    expect(jelly.tools.find((tool) => tool.permission === "databricks.write")!.note).toBe(WRITE_DISCLOSURE)
    expect(readFileSync(new URL("src/status.ts", ROOT), "utf8")).toContain("disclosure: WRITE_DISCLOSURE")
    expect(jelly.signIns[0]!.account.description).toContain(POLICY_DISCLOSURE)
    expect(flat(readFileSync(new URL("README.md", ROOT), "utf8"))).toContain(POLICY_DISCLOSURE)
    expect(flat(readFileSync(new URL("docs/safety.md", ROOT), "utf8"))).toContain("Column masks and row filters set by your admins run their own functions on every read; Databricks enforces them, and the plugin cannot see them.")
  })

  it("states the cost and the admin step within Jelly's limits", () => {
    expect(lineProblems("cost", jelly.cost, 300)).toEqual([])
    expect(lineProblems("admin", jelly.admin, 200)).toEqual([])
    expect(jelly.cost).toMatch(/bills by the hour while it runs/)
    expect(jelly.cost).toMatch(/until it auto-stops/)
  })

  it("declares access with Jelly's own words, the parser's default, and the read-only line about starts", () => {
    const settings = jelly.contributes.settings
    expect(settingsProblems(settings)).toEqual([])
    expect(settings.map((setting) => setting.key)).toEqual(["access"])
    expect(settings[0]!.default).toBe(loadOptions({}).access)
    const choices = settings[0]!.choices as { value: string; label: string; description: string }[]
    expect(choices.map((choice) => choice.value)).toEqual(ACCESS_CHOICES.map((choice) => choice.value))
    expect(choices.find((choice) => choice.value === "read-only")!.description).toBe("Reads run, and may start a small serverless warehouse that bills until it auto-stops. Changes never run.")
  })
})

/**
 * Jelly's `accessRules` (backend/host/src/connections/plugin-access.ts), ported: the namespace patterns get the
 * namespace effect, then one rule per declared permission through `effectOfAccess`; the last match wins.
 * `effectOfAccess` is protocol/contracts/src/plugin-access.light.ts, word for word in logic.
 */
function effectOfAccess(access: string, readOnly: boolean, declared: string): string {
  if (access === "all") return "allow"
  if (declared === "deny") return "deny"
  if (access === "ask-changes" && declared === "ask") return "ask"
  if (readOnly) return "allow"
  return access === "read-only" ? "deny" : "ask"
}

function jellyEffect(access: string, action: string): string {
  const namespace = access === "all" ? "allow" : access === "read-only" ? "deny" : "ask"
  const rules = [
    ...["databricks.*", "databricks_*", "databricks-*.*", "databricks-*_*"].map((pattern) => ({ action: pattern, effect: namespace })),
    ...jelly.tools.map((tool) => ({ action: tool.permission, effect: effectOfAccess(access, tool.readOnly === true, tool.effect) })),
  ]
  const wild = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`)
  return rules.findLast((rule) => wild(rule.action).test(action))?.effect ?? "unmatched"
}

/** Design §10.3's table. */
const EXPECTED: Record<string, (action: string) => string> = {
  all: () => "allow",
  "ask-changes": (action) => (action === "databricks.start" ? "ask" : reads.has(action) ? "allow" : "ask"),
  "read-only": (action) => (reads.has(action) || action === "databricks.start" ? "allow" : "deny"),
}
const reads = new Set([...TOOLS.filter((tool) => tool.readOnly).map((tool) => actionOf(tool.name)), "databricks.probe", "databricks.read"])

describe("Jelly's access rules, simulated over every action the plugin can assert (design §10.3)", () => {
  for (const access of ACCESS_VALUES) {
    it(`at ${access}: reads, the probe and a source's read allow; start is allow / ask / allow; save, commits, cancel and stop follow the choice`, () => {
      for (const action of DECLARED_ACTIONS) expect(jellyEffect(access, action), `${action} at ${access}`).toBe(EXPECTED[access]!(action))
    })

    it(`at ${access}: the plugin's own default rules agree with Jelly for every declared action`, () => {
      const rules = [{ action: "*", resource: "*", effect: "allow" as const }, ...defaultRules(access)]
      for (const action of DECLARED_ACTIONS) expect(effectOf(rules, action), `${action} at ${access}`).toBe(jellyEffect(access, action))
      // A table resource is asserted under the tool's own action, so it follows the tool's row.
      expect(effectOf(rules, "databricks.query", "work:table:main.s.t")).toBe(jellyEffect(access, "databricks.query"))
    })
  }
})

const contracts = process.env.JELLY_CONTRACTS

describe("Jelly's own PluginDeclarationSchema and effectOfAccess", () => {
  it.skipIf(!contracts)("accepts the declaration, with no unknown field, with and without the sources block", async () => {
    const module = (await import(pathToFileURL(`${contracts}/plugin-contract.ts`).href)) as {
      PluginDeclarationSchema: { safeParse(value: unknown): { success: boolean; error?: { issues: { path: unknown[]; message: string }[] } } }
      unknownDeclarationFields(value: unknown): string[]
    }
    const issues = (value: unknown) => {
      const result = module.PluginDeclarationSchema.safeParse(value)
      return result.success ? [] : (result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    }
    expect(issues(jelly)).toEqual([])
    expect(issues({ ...jelly, sources: (manifest as { sources?: unknown }).sources })).toEqual([])
    expect(module.unknownDeclarationFields(jelly)).toEqual([])
  })

  it.skipIf(!contracts)("the restated effectOfAccess equals Jelly's for every access, readOnly and effect", async () => {
    const light = (await import(pathToFileURL(`${contracts}/plugin-access.light.ts`).href)) as { effectOfAccess(access: string, readOnly: boolean, effect: string): string }
    for (const access of ACCESS_VALUES) for (const readOnly of [true, false]) for (const effect of ["allow", "ask", "deny"]) expect(effectOfAccess(access, readOnly, effect)).toBe(light.effectOfAccess(access, readOnly, effect))
  })
})

describe("docs/jelly.md", () => {
  it("follows the plugin authors' standard", () => {
    expect(docProblems(ROOT)).toEqual([])
  })
})
