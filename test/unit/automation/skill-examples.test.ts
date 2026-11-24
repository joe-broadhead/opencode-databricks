/**
 * The skills' examples, run against the fake workspace (design §16, package F's must-prove). Every fenced `sql` block in
 * the SQL skill, and the one `json` request in the working skill, goes through the **real** read path (C's guard), the
 * **real** client (B's) and the loopback fake (B's): nothing here is a mock of the thing being proved. A statement the
 * fake does not know answers SUCCEEDED with no rows, which is exactly what an example needs: the read path accepted it
 * and sent the wrapper.
 *
 * The examples name a `samples` catalog, seeded here; no real workspace, host or person appears.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { createDatabricksClient } from "../../../src/process/client.js"
import { createReadGuard } from "../../../src/guards/read.js"
import { loadOptions } from "../../../src/options.js"
import { createPlanStore } from "../../../src/domain/plans.js"
import type { AuthPort, DatabricksPort, StatementAnswer, TableInfo } from "../../../src/ports.js"
import type { Deps } from "../../../src/registry.js"
import { HANDLERS } from "../../../src/registry.js"
import { runTool } from "../../../src/tool-spec.js"
import { startFakeDatabricks, FAKE_ACCESS_TOKEN } from "../../fake/databricks-server.js"
import type { FakeDatabricks, FakeRequest } from "../../fake/databricks.js"
import { MemoryLedger } from "../../fake/ports.js"

const BASE_SCOPES = ["sql", "unity-catalog", "query-history", "openid", "email", "profile", "offline_access"]
const PATH = "system.session,system.builtin,system.ai,samples.default"
const PROBE = "SELECT * FROM (\nSELECT system.builtin.`current_path`()\n) AS oc_q"

const table = (fullName: string, columns: [string, string][]): TableInfo => ({
  fullName,
  tableType: "MANAGED",
  columns: columns.map(([name, typeText]) => ({ name, typeText })),
})

const TABLES = new Map<string, TableInfo>([
  ["samples.nyctaxi.trips", table("samples.nyctaxi.trips", [["pickup_zip", "STRING"], ["dropoff_zip", "STRING"], ["trip_distance", "DOUBLE"], ["fare_amount", "DOUBLE"], ["tpep_pickup_datetime", "TIMESTAMP"]])],
  ["samples.nyctaxi.zones", table("samples.nyctaxi.zones", [["pickup_zip", "STRING"]])],
  ["samples.information_schema.tables", table("samples.information_schema.tables", [["table_name", "STRING"]])],
])

const answer = (statementId: string, rows: (string | null)[][]): StatementAnswer => ({
  statementId,
  state: "SUCCEEDED",
  manifest: { columns: [{ name: "value", typeName: "STRING", typeText: "STRING", position: 0 }], totalRowCount: rows.length },
  rows,
})

/** The fenced blocks of a Markdown file, by language. */
export function fences(text: string, language: string): string[] {
  const marker = "```"
  return [...text.matchAll(new RegExp(`${marker}${language}\\n([\\s\\S]*?)\\n${marker}`, "gu"))].map((match) => match[1]!.trim())
}

const SQL_SKILL = readFileSync(new URL("../../../skills/databricks-sql/SKILL.md", import.meta.url), "utf8")
const WORK_SKILL = readFileSync(new URL("../../../skills/databricks/SKILL.md", import.meta.url), "utf8")

describe("the skills' examples run against the fake", () => {
  let fake: FakeDatabricks
  let deps: Deps

  beforeAll(async () => {
    fake = await startFakeDatabricks({
      tables: TABLES,
      statements: new Map([[PROBE, answer("st-path", [[PATH]])]]),
      identity: { id: "42", userName: "ada@example.com", displayName: "Ada" },
    })
    const auth: AuthPort = {
      accounts: () => [{ alias: "work", mode: "interactive", host: fake.origin, cloud: "custom", features: [], warehouse: "wh-small", enforcement: "identity" }],
      account: () => ({ alias: "work", mode: "interactive", host: fake.origin, cloud: "custom", features: [], warehouse: "wh-small", enforcement: "identity" }),
      token: async () => ({ accessToken: FAKE_ACCESS_TOKEN, expiresAt: Date.now() + 3_600_000, scopes: BASE_SCOPES, host: fake.origin }),
    }
    const options = loadOptions({ accounts: { work: { warehouse: "wh-small", host: fake.origin } }, allowCustomHost: true })
    const base = {
      options,
      access: options.access,
      auth,
      databricks: createDatabricksClient({ auth }),
      ledger: new MemoryLedger(),
      plans: createPlanStore({ ttlSeconds: 300 }),
      permission: { assert: async () => undefined },
      clock: { now: Date.now, uuid: () => "00000000-0000-4000-8000-000000000000" },
    }
    deps = { ...base, reads: createReadGuard(base) }
  }, 60_000)

  afterAll(async () => {
    await fake.close()
  })

  const call = { sessionID: "ses_test", agent: "build", messageID: "msg_test", id: "call_1", signal: new AbortController().signal }

  it("the SQL skill has ten examples, all reads", () => {
    const examples = fences(SQL_SKILL, "sql")
    expect(examples.length).toBeGreaterThanOrEqual(10)
    for (const sql of examples) expect(sql).not.toMatch(/^\s*(VACUUM|OPTIMIZE|GRANT|DROP|DELETE|INSERT|UPDATE|CREATE)\b/iu)
  })

  it("runs every SQL example through the real read path and the fake workspace", async () => {
    for (const sql of fences(SQL_SKILL, "sql")) {
      const input = sql.includes(":zip") ? { sql, params: [{ name: "zip", value: "10001", type: "STRING" }], maxRows: 5 } : { sql, maxRows: 5 }
      const out = await runTool("query", input, call, deps, HANDLERS)
      expect(out.error, `${sql}\n${out.message ?? ""}\n${out.next ?? ""}`).toBeUndefined()
      expect(out.state).toBe("ok")
      // The text that reached the workspace is the wrapper around the example (with allowlisted calls qualified).
      const sent = fake.requests.filter((request: FakeRequest) => request.path.endsWith("/sql/statements") && request.statement !== PROBE).at(-1)!
      expect(sent.statement!.startsWith("SELECT * FROM (\n")).toBe(true)
      expect(sent.statement!.endsWith("\n) AS oc_q")).toBe(true)
      if (sql.includes("samples.")) expect(sent.statement).toContain("samples.")
    }
  }, 60_000)

  it("runs the working skill's request example the same way", async () => {
    const example = JSON.parse(fences(WORK_SKILL, "json")[0]!) as Record<string, unknown>
    const out = await runTool("query", example, call, deps, HANDLERS)
    expect(out.error, `${out.message ?? ""}`).toBeUndefined()
    expect(out.state).toBe("ok")
  })
})
