// The expected skill data, parsed by a real YAML parser rather than the plugin's own line parser.
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { parse } from "yaml"

export interface ExpectedSkill {
  readonly id: string
  readonly name: string
  readonly description: string
}

export function expectedSkills(repo: string): ExpectedSkill[] {
  const ids = readdirSync(join(repo, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  return ids.map((id) => {
    const text = readFileSync(join(repo, "skills", id, "SKILL.md"), "utf8")
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(text)
    if (!match) throw new Error(`skills/${id}/SKILL.md has no frontmatter`)
    const front = parse(match[1]!) as unknown
    if (typeof front !== "object" || front === null) throw new Error(`skills/${id}/SKILL.md frontmatter is not an object`)
    const { name, description } = front as { readonly name?: unknown; readonly description?: unknown }
    if (typeof name !== "string" || typeof description !== "string") throw new Error(`skills/${id}/SKILL.md needs a string name and description`)
    return { id, name, description }
  })
}
