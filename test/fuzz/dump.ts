// The TypeScript side of the differential fuzz: the plugin's generated parser, through src/provider/sql/parse.ts, printing the
// same line per input as test/fuzz/Harness.java prints from Spark's own parser, then a fifth field: whether the read
// path's local rules refuse the input (a difference is excused only then). Reads base64 lines from the file named on
// the command line; writes to stdout.
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { type ParseTree, TerminalNode } from "antlr4ng"
import { stripTrailingSemicolon, textRules } from "../../src/provider/sql/analyze.js"
import { contextName, parseStatement } from "../../src/provider/sql/parse.js"

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64")

function preorder(node: ParseTree, kinds: string[], calls: string[]) {
  if (node instanceof TerminalNode) return
  const name = contextName(node)
  kinds.push(name)
  if (name === "FunctionCallContext" || name === "TableFunctionCallContext" || name === "LateralViewContext") {
    let target: ParseTree | undefined
    for (let index = 0; index < node.getChildCount(); index++) {
      const child = contextName(node.getChild(index)!)
      if (child === "FunctionNameContext" || child === "QualifiedNameContext") {
        target = node.getChild(index)!
        break
      }
    }
    calls.push(`${name}:${target ? b64(target.getText()) : ""}`)
  }
  for (let index = 0; index < node.getChildCount(); index++) preorder(node.getChild(index)!, kinds, calls)
}

const lines: string[] = []
// One input per line; an empty line is the empty input. The file ends with a line break.
for (const line of readFileSync(process.argv[2]!, "utf8").split("\n").slice(0, -1)) {
  const text = Buffer.from(line, "base64").toString("utf8")
  const parsed = parseStatement(text)
  const tokens = parsed.tokens.map((token) => `${token.type}.${token.channel}:${b64(token.text ?? "")},`).join("")
  let kind = "ERROR"
  let digest = ""
  let calls = ""
  if (parsed.ok && parsed.tree) {
    const kinds: string[] = []
    const found: string[] = []
    preorder(parsed.tree, kinds, found)
    kind = contextName(parsed.tree.getChild(0)!)
    digest = createHash("sha256").update(kinds.map((item) => `${item},`).join("")).digest("hex")
    calls = found.join(" ")
  }
  const refused = textRules(stripTrailingSemicolon(text)) !== undefined
  lines.push(`${tokens}\t${kind}\t${digest}\t${calls}\t${refused ? "refused" : "open"}`)
}
process.stdout.write(`${lines.join("\n")}\n`)
