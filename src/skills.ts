// Registers the plugin's hand-written skills. Each is read once at setup from the package's skills/<id>/SKILL.md.
import { readFile, readdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { type Plugin, Skill } from "@opencode/plugin"
import { DatabricksError } from "./domain/errors.js"

/** Every skill directory with a SKILL.md, in name order. */
export async function skillIds(): Promise<string[]> {
  const root = fileURLToPath(new URL("../skills/", import.meta.url))
  const entries = await readdir(root, { withFileTypes: true })
  const ids: string[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue
    try {
      await readFile(fileURLToPath(new URL(`../skills/${entry.name}/SKILL.md`, import.meta.url)), "utf8")
      ids.push(entry.name)
    } catch {
      // A directory without a SKILL.md is not a skill.
    }
  }
  return ids
}

type ParsedSkill = { readonly name: string; readonly description: string; readonly content: string }

/** A real one-line description: not empty, not a YAML block marker, and not a folded or literal block. */
function descriptionOf(id: string, raw: string | undefined): string {
  const text = raw?.trim()
  if (!text || text.startsWith(">") || text.startsWith("|") || text.includes("\n") || text.includes("\r")) {
    throw invalid(`skills/${id}/SKILL.md needs a one-line description: not empty, not ">", "|", or a block scalar.`)
  }
  return text
}

/** Parses the frontmatter strictly: exactly `name` (equal to the folder) and a one-line `description`. */
export function parseSkill(id: string, text: string): ParsedSkill {
  const source = text.replace(/\r\n/g, "\n")
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source)
  if (!match) throw invalid(`skills/${id}/SKILL.md has no frontmatter block.`)
  const fields = new Map<string, string>()
  for (const line of match[1]!.split("\n")) {
    const field = /^([a-z]+):\s*(.*)$/.exec(line)
    if (!field || fields.has(field[1]!)) throw invalid(`skills/${id}/SKILL.md has an invalid frontmatter line: ${line.slice(0, 80)}.`)
    fields.set(field[1]!, field[2]!.trim())
  }
  const name = fields.get("name")
  if (fields.size !== 2 || name !== id) throw invalid(`skills/${id}/SKILL.md needs exactly a name equal to "${id}" and a description.`)
  const description = descriptionOf(id, fields.get("description"))
  const content = match[2]!.trimStart()
  if (content.trim() === "") throw invalid(`skills/${id}/SKILL.md has no content.`)
  return { name, description, content }
}

function invalid(message: string): DatabricksError {
  return new DatabricksError("UNAVAILABLE", message, "Reinstall the plugin.")
}

export function skillPath(id: string): string {
  return fileURLToPath(new URL(`../skills/${id}/SKILL.md`, import.meta.url))
}

type SkillContext = { readonly skill: Pick<Plugin.Context["skill"], "transform"> }

export async function registerSkills(ctx: SkillContext): Promise<{ dispose(): Promise<void> }> {
  const ids = await skillIds()
  if (ids.length === 0) throw invalid("The package has no skills.")
  const skills = await Promise.all(
    ids.map(async (id) => {
      const path = skillPath(id)
      const text = await readFile(path, "utf8").catch(() => {
        throw invalid(`skills/${id}/SKILL.md is missing or unreadable.`)
      })
      return { id, path, ...parseSkill(id, text) }
    }),
  )
  return ctx.skill.transform((editor) => {
    for (const skill of skills) {
      editor.add({
        id: Skill.ID.make(skill.id),
        name: Skill.Name.make(skill.name),
        description: skill.description,
        // The host brands absolute paths; this one comes from the package location.
        path: skill.path as Skill.Info["path"],
        content: skill.content,
      })
    }
  })
}
