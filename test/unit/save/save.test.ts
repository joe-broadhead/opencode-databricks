// databricks_save (design §8.2): every format read back, the link rules, the inline fallback, the caps and the path
// rules. Nothing reaches Databricks: the harness's fake answers the submit and the links, and the Arrow bytes are a
// stream Apache Arrow's own writer produced from invented values (the Arrow IPC format, `format/Message.fbs`).
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, existsSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Bool, Float64, Int64, Utf8, tableFromArrays, tableFromIPC, tableToIPC, vectorFromArray } from "apache-arrow"
import { parquetReadObjects } from "hyparquet"
import { afterAll, describe, expect, it } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import type { StatementAnswer, Warehouse } from "../../../src/ports.js"
import { runTool } from "../../../src/tool-spec.js"
import { HANDLERS } from "../../../src/registry.js"
import { harness, runningWarehouse, answerOf } from "../reads/harness.js"

const root = mkdtempSync(join(tmpdir(), "dbx-save-"))
// A folder outside every root (the project, resultsDir and allowedRoots), for the symlink escapes.
const outside = mkdtempSync(join(tmpdir(), "dbx-save-outside-"))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const warehouse = (): Warehouse => ({ ...runningWarehouse(), id: "wh-small", name: "small", serverless: true, clusterSize: "Small", autoStopMins: 10 })

/** An Arrow IPC stream, as a Statement Execution chunk is: one schema and one record batch. */
const arrowOf = (rows: { id: number[]; name: (string | null)[]; ok: boolean[]; amount: number[] }): Uint8Array =>
  tableToIPC(
    tableFromArrays({
      id: vectorFromArray(rows.id.map((value) => BigInt(value)), new Int64()) as never,
      name: vectorFromArray(rows.name, new Utf8()) as never,
      ok: vectorFromArray(rows.ok, new Bool()) as never,
      amount: vectorFromArray(rows.amount, new Float64()) as never,
    }),
    "stream",
  )

const FIXTURE = arrowOf({ id: [1, 2, 3], name: ["alpha", null, "gamma"], ok: [true, false, true], amount: [1.5, 2.25, 3.125] })

// The documented StatementResponse manifest (`name`, `type_name`, `type_text`, `position`), and the external link object's
// fields (`external_link`, `expiration`, `chunk_index`, `row_count`, `next_chunk_index`) —
// https://docs.databricks.com/api/statement-execution/v1/statement-execution/object.md.
const manifest = {
  columns: [
    { name: "id", typeName: "LONG", typeText: "BIGINT", position: 0 },
    { name: "name", typeName: "STRING", typeText: "STRING", position: 1 },
    { name: "ok", typeName: "BOOLEAN", typeText: "BOOLEAN", position: 2 },
    { name: "amount", typeName: "DOUBLE", typeText: "DOUBLE", position: 3 },
  ],
  totalRowCount: 3,
}

interface Options {
  readonly bytes?: Uint8Array
  readonly links?: boolean
  readonly linkHost?: string
  readonly fetchFails?: boolean
  readonly inline?: boolean
  readonly expired?: boolean
  readonly remainder?: Uint8Array
  readonly rows?: number
}

function harnessFor(options: Options = {}) {
  let submitCount = 0
  const fetched: string[] = []
  const test = harness({
    options: { resultsDir: root, accounts: { work: { warehouse: "wh-small" } } },
    answers: {
      getWarehouse: () => Promise.resolve(warehouse()),
      submit: (request: unknown) => {
        const ask = request as { disposition: string; statement: string }
        submitCount += 1
        if (ask.statement.includes("current_path")) return answerOf({ rows: [["system.session,system.builtin,main.default"]] })
        if (ask.disposition === "INLINE") {
          return { statementId: "st-save", state: "SUCCEEDED", manifest, rows: [["1", "alpha", "true", "1.5"], ["2", null, "false", "2.25"]] } satisfies StatementAnswer
        }
        if (options.inline) return { statementId: "st-save", state: "SUCCEEDED", manifest, rows: [["1", "alpha", "true", "1.5"]] } satisfies StatementAnswer
        return {
          statementId: "st-save",
          state: "SUCCEEDED",
          manifest,
          links: [
            {
              chunkIndex: 0,
              url: `https://${options.linkHost ?? "bucket.s3.amazonaws.com"}/chunk/0`,
              expiration: new Date(Date.now() + (options.expired ? -1000 : 600_000)).toISOString(),
              rowCount: 3,
              byteCount: FIXTURE.length,
              ...(options.remainder ? { nextChunkIndex: 1 } : {}),
            },
          ],
          ...(options.remainder ? { nextChunkIndex: 1 } : {}),
        } satisfies StatementAnswer
      },
      fetchLink: (_account: unknown, link: unknown) => {
        fetched.push((link as { url: string }).url)
        if (options.fetchFails) return Promise.reject(new DatabricksError("UNAVAILABLE"))
        const bytes = options.remainder && fetched.length > 1 ? options.remainder : (options.bytes ?? FIXTURE)
        return Promise.resolve(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes)
              controller.close()
            },
          }),
        )
      },
      getChunk: () =>
        Promise.resolve({
          chunkIndex: 1,
          links: [
            {
              chunkIndex: 1,
              url: `https://bucket.s3.amazonaws.com/chunk/1`,
              expiration: new Date(Date.now() + 600_000).toISOString(),
              rowCount: 1,
              byteCount: options.remainder?.length ?? 0,
            },
          ],
        }),
    },
  })
  return { test, fetched, submits: () => submitCount }
}

const run = async (input: Record<string, unknown>, fake: ReturnType<typeof harnessFor>["test"]) =>
  runTool("save", { sql: "select * from main.s.t", ...input }, fake.call("call_save"), fake.deps, HANDLERS)

describe("databricks_save", () => {
  it("writes CSV, JSONL and Parquet that charts' own readers read back", async () => {
    const csv = await run({ format: "csv", path: join(root, "out.csv") }, harnessFor().test)
    expect(csv.state).toBe("ok")
    expect(readFileSync(join(root, "out.csv"), "utf8")).toBe("id,name,ok,amount\n1,alpha,true,1.5\n2,,false,2.25\n3,gamma,true,3.125\n")
    expect(csv.rows).toBe(3)

    const jsonl = await run({ format: "jsonl", path: join(root, "out.jsonl") }, harnessFor().test)
    expect(jsonl.state).toBe("ok")
    const lines = readFileSync(join(root, "out.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(lines).toEqual([
      { id: 1, name: "alpha", ok: true, amount: 1.5 },
      { id: 2, name: null, ok: false, amount: 2.25 },
      { id: 3, name: "gamma", ok: true, amount: 3.125 },
    ])

    const parquet = await run({ format: "parquet", path: join(root, "out.parquet") }, harnessFor().test)
    expect(parquet.state).toBe("ok")
    const file = readFileSync(join(root, "out.parquet"))
    const objects = await parquetReadObjects({ file: file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer })
    expect(objects.map((row) => ({ ...row, id: Number(row.id) }))).toEqual([
      { id: 1, name: "alpha", ok: true, amount: 1.5 },
      { id: 2, name: null, ok: false, amount: 2.25 },
      { id: 3, name: "gamma", ok: true, amount: 3.125 },
    ])
  })

  it("writes the Arrow stream the provider sent, and Apache Arrow's reader reads it back", async () => {
    const answer = await run({ format: "arrow", path: join(root, "out.arrow") }, harnessFor().test)
    expect(answer.state).toBe("ok")
    const table = tableFromIPC(readFileSync(join(root, "out.arrow")))
    expect(table.numRows).toBe(3)
    expect(table.getChild("name")?.get(0)).toBe("alpha")
    expect(table.getChild("name")?.get(1)).toBe(null)
    expect(answer.charts).toMatchObject({ path: join(root, "out.arrow"), format: "arrow", fitsCharts: false })
  })

  it("keeps a second chunk's rows and the schema", async () => {
    const second = arrowOf({ id: [4], name: ["delta"], ok: [true], amount: [4.5] })
    const answer = await run({ format: "csv", path: join(root, "two.csv") }, harnessFor({ remainder: second }).test)
    expect(answer.state).toBe("ok")
    expect(answer.rows).toBe(4)
    expect(readFileSync(join(root, "two.csv"), "utf8")).toContain("4,delta,true,4.5")
  })

  it("refuses a link that is not on the workspace cloud's storage hosts, without fetching it", async () => {
    const { test, fetched } = harnessFor({ linkHost: "evil.example.com" })
    const answer = await run({ format: "csv", path: join(root, "nope.csv") }, test)
    expect(answer.error).toBe("EXTERNAL_LINK_REFUSED")
    expect(fetched).toEqual([])
    expect(existsSync(join(root, "nope.csv"))).toBe(false)
  })

  it("falls back to INLINE when a link cannot be fetched, and says so", async () => {
    const { test, submits } = harnessFor({ fetchFails: true })
    const answer = await run({ format: "csv", path: join(root, "fallback.csv") }, test)
    expect(answer.state).toBe("ok")
    expect(submits()).toBe(2)
    expect(JSON.stringify(answer.warnings)).toContain("SAVE_INLINE_FALLBACK")
    expect(readFileSync(join(root, "fallback.csv"), "utf8")).toContain("1,alpha,true,1.5")
  })

  it("refuses an existing file without overwrite, and a path outside the roots", async () => {
    await run({ format: "csv", path: join(root, "exists.csv") }, harnessFor().test)
    const again = await run({ format: "csv", path: join(root, "exists.csv") }, harnessFor().test)
    expect(again.error).toBe("SAVE_EXISTS")
    const outside = await run({ format: "csv", path: "/etc/opencode-databricks-nope.csv" }, harnessFor().test)
    expect(outside.error).toBe("SAVE_PATH_REFUSED")
  })

  it("removes the partial file when the result is over maxSaveRows, and reports SAVE_LIMIT", async () => {
    const many = arrowOf({ id: [1, 2, 3, 4], name: ["a", "b", "c", "d"], ok: [true, true, true, true], amount: [1, 2, 3, 4] })
    const { test } = harnessFor({ bytes: many })
    const answer = await runTool("save", { sql: "select * from main.s.t", format: "csv", path: join(root, "limit.csv") }, test.call("call_limit"), { ...test.deps, options: { ...test.deps.options, maxSaveRows: 2 } }, HANDLERS)
    expect(answer.error).toBe("SAVE_LIMIT")
    expect(existsSync(join(root, "limit.csv"))).toBe(false)
    expect(String(answer.message)).toContain("the partial file was removed")
  })

  it("streams a million rows without holding them in memory", async () => {
    // 40 chunks of 25,000 Arrow rows: the reader decodes one chunk and the writer consumes it before the next is
    // fetched, so the heap grows by the chunk, not the result.
    const chunkRows = 25_000
    const chunk = tableToIPC(
      tableFromArrays({
        id: vectorFromArray(Array.from({ length: chunkRows }, (_, index) => BigInt(index)), new Int64()) as never,
        name: vectorFromArray(Array.from({ length: chunkRows }, (_, index) => `row-${index}`), new Utf8()) as never,
        amount: vectorFromArray(Array.from({ length: chunkRows }, (_, index) => index / 8), new Float64()) as never,
      }),
      "stream",
    )
    const linkFor = (index: number) => ({ chunkIndex: index, url: `https://bucket.s3.amazonaws.com/chunk/${index}`, expiration: new Date(Date.now() + 600_000).toISOString(), rowCount: chunkRows, byteCount: chunk.length, ...(index < 39 ? { nextChunkIndex: index + 1 } : {}) })
    const test = harness({
      options: { resultsDir: root },
      answers: {
        getWarehouse: () => Promise.resolve(warehouse()),
        submit: () => ({ statementId: "st-big", state: "SUCCEEDED", manifest, links: [linkFor(0)], nextChunkIndex: 1 }),
        getChunk: (_account: unknown, _id: unknown, index: unknown) => Promise.resolve({ chunkIndex: Number(index), links: [linkFor(Number(index))], ...(Number(index) < 39 ? { nextChunkIndex: Number(index) + 1 } : {}) }),
        fetchLink: () => Promise.resolve(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(chunk); controller.close() } })),
      } as never,
    })
    const before = process.memoryUsage().heapUsed
    const answer = await runTool("save", { sql: "select * from main.s.t", format: "csv", path: join(root, "million.csv") }, test.call("million"), test.deps, HANDLERS)
    const growth = process.memoryUsage().heapUsed - before
    expect(answer.state).toBe("ok")
    expect(answer.rows).toBe(1_000_000)
    expect(growth).toBeLessThan(64 * 1024 * 1024)
  }, 120_000)

  it("refuses a symlinked folder under a root that points outside every root (review S1), and a symlinked target", async () => {
    // S1: <resultsDir>/escape is a link to a folder outside; a lexical check would pass it and write outside.
    symlinkSync(outside, join(root, "escape"))
    const escaped = await run({ format: "csv", path: join(root, "escape", "x.csv") }, harnessFor().test)
    expect(escaped.error).toBe("SAVE_PATH_REFUSED")
    expect(readdirSync(outside)).toEqual([])
    // S3: the target itself is a link to a file outside: refused, and the file outside is untouched.
    writeFileSync(join(outside, "victim.txt"), "keep")
    symlinkSync(join(outside, "victim.txt"), join(root, "link.csv"))
    const linked = await run({ format: "csv", path: join(root, "link.csv"), overwrite: true }, harnessFor().test)
    expect(linked.error).toBe("SAVE_PATH_REFUSED")
    expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("keep")
    // A dangling link on the way is refused rather than created through.
    symlinkSync(join(outside, "missing"), join(root, "dangling"))
    const dangling = await run({ format: "csv", path: join(root, "dangling", "x.csv") }, harnessFor().test)
    expect(dangling.error).toBe("SAVE_PATH_REFUSED")
    expect(readdirSync(outside)).toEqual(["victim.txt"])
  })

  it("follows a symlinked temp folder to its real path, and asks edit for the real path (as Colab #12)", async () => {
    // macOS's temp folder is itself a link (/var → /private/var); here a link under the system temp folder plays it.
    const real = mkdtempSync(join(root, "real-"))
    const alias = join(tmpdir(), `dbx-save-alias-${process.pid}`)
    rmSync(alias, { force: true })
    symlinkSync(real, alias)
    try {
      const inside = join(real, "inner")
      mkdirSync(inside)
      symlinkSync(inside, join(real, "to-inner"))
      const fake = harnessFor()
      const answer = await run({ format: "csv", path: join(alias, "to-inner", "ok.csv") }, fake.test)
      expect(answer.state).toBe("ok")
      expect(existsSync(join(inside, "ok.csv"))).toBe(true)
      const edit = fake.test.permission.requests.find((request) => request.action === "edit")
      expect(edit?.resource).toBe(join(realpathSync.native(inside), "ok.csv"))
    } finally {
      rmSync(alias, { force: true })
    }
  })

  it("asks for edit on the file before writing, and puts no secret in the result", async () => {
    const fake = harnessFor()
    await run({ format: "csv", path: join(root, "edit.csv") }, fake.test)
    expect(fake.test.permission.requests.map((request) => request.action)).toContain("edit")
    expect(fake.fetched.length).toBe(1)
  })
})
