import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

describe("the Databricks MCP record", () => {
  it("records that no Databricks MCP server covers the plugin's job", () => {
    const readme = read("../../README.md").replace(/\s+/gu, " ")
    expect(readme).toContain("## Databricks' MCP servers")
    expect(readme).toContain("https://docs.databricks.com/aws/en/agents/mcp-tools/built-in-mcp-services")
    expect(readme).toContain("https://docs.databricks.com/aws/en/agents/mcp-tools/databricks-sql")
    expect(readme).toContain("checked on 28 November 2026")
    expect(readme).toContain("no Databricks MCP server to build this plugin on")
  })

  it("declares no pass-through MCP tools", () => {
    const manifest = JSON.parse(read("../../package.json")) as {
      capabilities: { methods: Record<string, unknown> }
    }
    expect(Object.keys(manifest.capabilities.methods).filter((name) => name.startsWith("mcp:"))).toEqual([])
  })
})
