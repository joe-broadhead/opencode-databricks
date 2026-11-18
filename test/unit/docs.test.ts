/**
 * The docs test (design §15.1, "Declaration and docs"): the parts of the documentation and the skills that a reviewer
 * can check mechanically.
 *
 * - The README's and docs/errors.md's tables are exactly `errorRows()`, generated from `src/domain/errors.ts`.
 * - Every tool name and every dotted action in the docs and the skills is one the plugin declares; no skill invents an
 *   input.
 * - Every option in `docs/configuration.md` exists, and every option the plugin has is documented.
 * - The two disclosures appear verbatim in the README and the working skill, and status returns the write one.
 * - Every Databricks fact carries a numbered citation, and every citation is a Databricks documentation page (or the
 *   pricing page, labelled as such): no claim without a source.
 * - The Known limits list every limit the package reviews named, by a phrase from each.
 * - The commands exist in the docs, and the cleanup rules are stated: read-only reports, ask-changes asks, nothing is
 *   ever deleted.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { DECLARED_ACTIONS, engineName, TOOL_NAMES } from "../../src/domain/actions.js"
import { POLICY_DISCLOSURE, WRITE_DISCLOSURE } from "../../src/domain/contract.js"
import { errorRows } from "../../src/domain/errors.js"
import { OptionsSchema } from "../../src/options.js"

const ROOT = new URL("../../", import.meta.url)
const read = (path: string) => readFileSync(new URL(path, ROOT), "utf8")
const flat = (text: string) => text.replace(/\n> /gu, " ").replace(/\n\s*/gu, " ")

const DOCS = ["README.md", "docs/auth.md", "docs/configuration.md", "docs/costs.md", "docs/jelly.md", "docs/safety.md", "docs/scripting.md", "docs/architecture.md"]
const SKILLS = ["skills/opencode-databricks/SKILL.md", "skills/opencode-databricks-sql/SKILL.md"]
const CITED = ["README.md", "docs/auth.md", "docs/costs.md", "docs/jelly.md", "docs/safety.md"]

/** A numbered citation's use in prose: `[6]`, but not the definition line `[6]:`. */
const uses = (text: string): number[] => [...text.matchAll(/\[(\d+)\]/gu)].filter((match) => !text.slice(match.index + match[0].length).startsWith(":")).map((match) => Number(match[1]))

describe("the docs", () => {
  it("carries exactly the generated error table in the README and docs/errors.md", () => {
    const table = errorRows()
    for (const path of ["README.md", "docs/errors.md"]) {
      const text = read(path)
      const match = /<!-- errors:start -->\n([\s\S]*?)\n<!-- errors:end -->/u.exec(text)
      expect(match, `${path} has no generated table`).not.toBeNull()
      expect(match![1]).toBe(table)
    }
  })

  it("names only tools and actions the plugin declares", () => {
    const tools = new Set(TOOL_NAMES.map((name) => engineName(name)))
    const actions = new Set(DECLARED_ACTIONS)
    // The source ids share the prefix but are not actions; the source contract declares them in package.json.
    const sources = new Set(["databricks.queries", "databricks.runs", "databricks.saved"])
    // The plugin's own ids: the RPC id `databricks.databricks` and its tools RPC.
    const ids = new Set(["databricks.databricks"])
    for (const path of [...DOCS, ...SKILLS]) {
      const text = read(path)
      const named = [...text.matchAll(/\bdatabricks_[a-z][a-z0-9_]*/gu)].map((match) => match[0])
      expect(named.filter((name) => !tools.has(name)), `${path}: unknown tool names`).toEqual([])
      const dotted = [...text.matchAll(/`databricks\.([a-z][a-z0-9_]*)`/gu)].map((match) => `databricks.${match[1]}`)
      expect(dotted.filter((name) => !actions.has(name) && !sources.has(name) && !ids.has(name)), `${path}: unknown actions`).toEqual([])
    }
  })

  it("documents every option, and only options that exist", () => {
    const keys = Object.keys(OptionsSchema.shape)
    const accountKeys = Object.keys((OptionsSchema.shape.accounts as { unwrap(): { valueType: { shape: Record<string, unknown> } } }).unwrap().valueType.shape)
    const text = read("docs/configuration.md")
    for (const key of keys) expect(text, `docs/configuration.md does not document ${key}`).toContain(`\`${key}\``)
    const named = [...text.matchAll(/`([a-zA-Z][a-zA-Z0-9]*)`/gu)].map((match) => match[1]!)
    // Every backticked lower-camel name in the table that looks like a setting is either an option, an account option,
    // an enum value or a documented sub-key. A typo shows up as a name none of those is.
    const nested = new Set(["daily", "session", "starts", "dbuHours", "serverless", "pro", "classic", "enabled", "requireReason", "interactive", "pat", "m2m", "cli", "fine", "all-apis", "jobs", "workspace", "files", "allow", "deny", "piiTags", "warn", "refuse", "save-only", "auto", "on", "off"])
    const unknown = named.filter((name) => /^[a-z][A-Za-z0-9]*$/u.test(name) && !keys.includes(name) && !accountKeys.includes(name) && !nested.has(name) && /[A-Z]/u.test(name))
    expect(unknown, "docs/configuration.md names settings that do not exist").toEqual([])
  })

  it("carries both disclosures verbatim in the README and the working skill, and status returns the write one", () => {
    for (const path of ["README.md", SKILLS[0]!]) {
      const text = flat(read(path))
      expect(text, path).toContain(WRITE_DISCLOSURE)
      expect(text, path).toContain(POLICY_DISCLOSURE)
    }
    expect(read("src/status.ts")).toContain("disclosure: WRITE_DISCLOSURE")
    expect(read("src/status.ts")).toContain("policies: POLICY_DISCLOSURE")
  })

  it("cites every Databricks fact to Databricks' documentation, with no dangling citation", () => {
    // Databricks' pages, and Apache Spark's grammar for the one claim about the parser (which is Apache's, not
    // Databricks').
    const allowed = (url: string) => /^https:\/\/(docs\.databricks\.com|learn\.microsoft\.com|www\.databricks\.com)\//u.test(url) || /^https:\/\/github\.com\/apache\/spark\//u.test(url)
    for (const path of CITED) {
      const text = read(path)
      const defined = new Map<number, string>()
      for (const match of text.matchAll(/^- \[(\d+)\] .*?(https:\/\/\S+)$/gmu)) defined.set(Number(match[1]), match[2]!)
      const used = new Set(uses(text))
      expect(used.size, `${path} cites nothing`).toBeGreaterThan(2)
      for (const number of used) expect(defined.has(number), `${path} uses [${number}] without a definition`).toBe(true)
      for (const [number, url] of defined) {
        expect(allowed(url), `${path} [${number}] is not a Databricks page: ${url}`).toBe(true)
        expect(used.has(number), `${path} defines [${number}] but never uses it`).toBe(true)
      }
    }
  })

  it("lists every Known limit the package reviews named", () => {
    const text = read("README.md")
    const limits = [
      "Privileges are the only server-enforced read-only",
      "A role is weaker than",
      "Non-ASCII names are refused",
      "The dependency set is the union",
      "The parser is Spark's, not Databricks'",
      "Keyword forms follow the path",
      "A start bills",
      "Stopping needs Can manage",
      "Single-use refresh tokens",
      "Headless modes are refused in every engine Jelly runs",
      "Masks and filters run functions you cannot see",
      "Results and history are bounded by Databricks",
      "Query tags are Public Preview",
      "Some cell renderings are unverified",
      "Automation runs only while OpenCode runs",
      "Actions can email people",
    ]
    for (const limit of limits) expect(text, `README.md's Known limits is missing: ${limit}`).toContain(limit)
  })

  it("documents the two commands and the cleanup rules", () => {
    const costs = read("docs/costs.md")
    const config = read("docs/configuration.md")
    expect(read("README.md")).toContain("/databricks-status")
    for (const text of [read("README.md"), costs, config]) expect(text).toContain("/databricks-cleanup")
    expect(costs).toMatch(/At `ask-changes` each action is a permission prompt only you answer/u)
    expect(costs).toMatch(/at `read-only` it reports and does nothing/u)
    expect(costs).toContain("Nothing in any layer deletes")
    expect(read("docs/scripting.md")).toMatch(/neither is `\/databricks-cleanup`/u)
  })

  it("gives Jelly both redirect URLs and keeps the family block", () => {
    const jelly = read("docs/jelly.md")
    expect(jelly).toContain("http://localhost:8765/callback")
    expect(jelly).toContain("<Jelly ID issuer>/connect/callback")
    expect(jelly).toContain("<!-- family-block:start -->")
    expect(read("package.json")).toContain('"redirectField": "redirectUri"')
  })

  it("links only local docs that exist", () => {
    for (const path of DOCS) {
      const text = read(path)
      for (const match of text.matchAll(/\]\((?!https?:)([^)#]+)(?:#[^)]+)?\)/gu)) {
        const target = match[1]!
        if (target.startsWith("#")) continue
        const resolved = new URL(target, new URL(path, ROOT))
        expect(() => readFileSync(resolved), `${path} links to missing ${target}`).not.toThrow()
      }
    }
  })

  it("has no stale 'nothing is built' claim in user-facing docs", () => {
    for (const path of DOCS) expect(read(path)).not.toMatch(/Nothing is built yet|every other tool answers `NOT_IMPLEMENTED`/u)
  })
})
