/**
 * The `jelly` section of package.json, which Jelly reads without loading the plugin. The shared kit checks it against
 * Jelly's plugin authors' standard. No tool is declared until the tools exist.
 */
import { describe, expect, it } from "vitest"
import { loadOptions } from "../../src/options.js"
import { defaultRules } from "../../src/permissions.js"
import { SKILL_IDS } from "../../src/skills.js"
import { WRITE_DISCLOSURE } from "../../src/disclosures.js"
import { type Declaration, type DeclaredTool, declarationProblems, docProblems, effectFromRules, lineProblems, readPackage } from "../support/jelly-kit.js"
import { ACCESS_CHOICES, type PluginSetting, settingsProblems } from "../support/jelly-settings.js"

const ROOT = new URL("../../", import.meta.url)
const manifest = readPackage(ROOT)
type SignIn = { id: string; label: string; integration: string; scopes: string[]; needed: string[]; account: { description: string } }
const jelly = manifest.jelly as Declaration & { tools: DeclaredTool[]; signIns: SignIn[]; contributes: { settings: PluginSetting[] } }

describe("the jelly declaration", () => {
  it("follows the plugin authors' standard; no tool is declared yet", () => {
    expect(declarationProblems(ROOT, { effectOf: effectFromRules(defaultRules()), actionPermissions: true })).toEqual(["jelly.tools is empty"])
  })

  it("declares the skills the plugin registers", () => {
    expect(jelly.skills).toEqual([...SKILL_IDS])
  })

  it("declares one sign-in group per workspace, with the write disclosure", () => {
    expect(jelly.signIns).toHaveLength(1)
    expect(jelly.signIns[0]).toMatchObject({ id: "databricks", label: "Databricks workspace", integration: "databricks-*" })
    expect(jelly.signIns[0]!.account.description).toContain(WRITE_DISCLOSURE)
  })

  it("states the cost and the admin step within Jelly's limits", () => {
    expect(lineProblems("cost", jelly.cost, 300)).toEqual([])
    expect(lineProblems("admin", jelly.admin, 200)).toEqual([])
  })

  it("declares access with Jelly's own words and the parser's default", () => {
    const settings = jelly.contributes.settings
    expect(settingsProblems(settings)).toEqual([])
    expect(settings.map((setting) => setting.key)).toEqual(["access"])
    expect(settings[0]!.default).toBe(loadOptions({}).access)
    expect((settings[0]!.choices as { value: string }[]).map((choice) => choice.value)).toEqual(ACCESS_CHOICES.map((choice) => choice.value))
  })
})

describe("docs/jelly.md", () => {
  it("follows the plugin authors' standard", () => {
    expect(docProblems(ROOT)).toEqual([])
  })
})
