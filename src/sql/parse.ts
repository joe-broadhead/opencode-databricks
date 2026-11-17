/**
 * The plugin's SQL parser (design §5.3): Spark's grammar at the pin, generated (src/sql/generated/), driven the way
 * Spark drives it:
 * - the lexer reads an upper-cased view of the text, as Spark's UpperCaseCharStream does (`Character.toUpperCase` per
 *   code point; a character whose upper case is more than one code point stays as it is, as in Java);
 * - two-stage prediction: SLL first, then full LL on a syntax error, as Spark's AbstractParser does;
 * - the behaviour flags are pinned in grammar/port.mjs.
 * Nothing here talks to the network, and nothing decides: src/sql/analyze.ts reads the tree.
 */
import {
  type ATNSimulator,
  BailErrorStrategy,
  BaseErrorListener,
  CharStreamImpl,
  CommonTokenStream,
  DefaultErrorStrategy,
  ParseCancellationException,
  PredictionMode,
  type Recognizer,
  type Token,
} from "antlr4ng"
import { SqlBaseLexer } from "./generated/SqlBaseLexer.js"
import * as Generated from "./generated/SqlBaseParser.js"
import { SqlBaseParser, type SingleStatementContext } from "./generated/SqlBaseParser.js"

/** Java's `Character.toUpperCase(int)`: the simple upper-case mapping, one code point to one. */
export function upperCodePoint(codePoint: number): number {
  if (codePoint < 0x61) return codePoint
  if (codePoint <= 0x7a) return codePoint - 32
  if (codePoint < 0x80) return codePoint
  const upper = String.fromCodePoint(codePoint).toUpperCase()
  const first = upper.codePointAt(0)!
  return upper.length === String.fromCodePoint(first).length ? first : codePoint
}

/**
 * Java's `Character.toLowerCase(int)`: the simple lower-case mapping, one code point to one. JavaScript's full mapping
 * turns U+0130 (İ) into two code points; its simple mapping is `i`.
 */
export function lowerCodePoint(codePoint: number): number {
  if (codePoint < 0x80) return codePoint >= 0x41 && codePoint <= 0x5a ? codePoint + 32 : codePoint
  if (codePoint === 0x130) return 0x69
  const lower = String.fromCodePoint(codePoint).toLowerCase()
  const first = lower.codePointAt(0)!
  return lower.length === String.fromCodePoint(first).length ? first : codePoint
}

/**
 * A name folded as Java's `String.equalsIgnoreCase` compares it: per code point, upper case then lower case. Spark
 * v4.3.0 matches `system`, `builtin` and `session` that way (`FunctionResolution.isQualifiedWithSystemNamespace`), so
 * `ſystem` (U+017F) and `buıltin` (U+0131) name the system catalog; this fold makes them `system` and `builtin`. The
 * only code points that fold to an ASCII letter are those two, U+212A (Kelvin) and U+0130, and each folds exactly.
 */
export function foldName(text: string): string {
  return Array.from(text, (character) => String.fromCodePoint(lowerCodePoint(upperCodePoint(character.codePointAt(0)!)))).join("")
}

/** Spark's UpperCaseCharStream: LA() sees upper case; the text of tokens keeps the original. */
export class UpperCaseCharStream extends CharStreamImpl {
  override LA(offset: number): number {
    const la = super.LA(offset)
    return la === 0 || la === -1 ? la : upperCodePoint(la)
  }
}

export interface SyntaxProblem {
  readonly line: number
  readonly column: number
  /** ANTLR's own message about the plugin's input: built from the input, so treated as untrusted. */
  readonly message: string
}

class Collector extends BaseErrorListener {
  readonly problems: SyntaxProblem[] = []
  override syntaxError<S extends Token, T extends ATNSimulator>(_recognizer: Recognizer<T>, _offending: S | null, line: number, column: number, message: string): void {
    this.problems.push({ line, column, message })
  }
}

export interface Lexed {
  readonly tokens: readonly Token[]
  /** An unclosed bracketed comment (the lexer's markUnclosedComment). */
  readonly unclosedComment: boolean
}

/** Every token, hidden channel included. */
export function lex(text: string): Lexed {
  const lexer = new SqlBaseLexer(new UpperCaseCharStream(text))
  lexer.removeErrorListeners()
  const stream = new CommonTokenStream(lexer)
  stream.fill()
  return { tokens: stream.getTokens(), unclosedComment: lexer.has_unclosed_bracketed_comment }
}

export interface Parsed {
  readonly ok: boolean
  readonly tree?: SingleStatementContext
  readonly tokens: readonly Token[]
  readonly unclosedComment: boolean
  readonly problems: readonly SyntaxProblem[]
}

/**
 * Parses one statement as Spark's `singleStatement`, the way Spark's AbstractParser.parse does: SLL with a bail-out
 * error strategy first; on failure the same token stream is rewound (`seek(0)`, `reset()`) and parsed again in LL
 * mode. Reusing the stream matters: a parser action changes the lexer's state (`STRUCT<>`), so re-lexing could differ.
 */
export function parseStatement(text: string): Parsed {
  const lexer = new SqlBaseLexer(new UpperCaseCharStream(text))
  lexer.removeErrorListeners()
  const lexErrors = new Collector()
  lexer.addErrorListener(lexErrors)
  const stream = new CommonTokenStream(lexer)
  const parser = new SqlBaseParser(stream)
  parser.removeErrorListeners()
  let errors = new Collector()
  parser.addErrorListener(errors)
  let tree: SingleStatementContext | undefined
  try {
    parser.errorHandler = new BailErrorStrategy()
    parser.interpreter.predictionMode = PredictionMode.SLL
    tree = parser.singleStatement()
  } catch (error) {
    if (!(error instanceof ParseCancellationException)) throw error
    stream.seek(0)
    parser.reset()
    parser.removeErrorListeners()
    errors = new Collector()
    parser.addErrorListener(errors)
    parser.errorHandler = new DefaultErrorStrategy()
    parser.interpreter.predictionMode = PredictionMode.LL
    tree = parser.singleStatement()
  }
  stream.fill()
  const problems = [...lexErrors.problems, ...errors.problems]
  const ok = problems.length === 0 && !lexer.has_unclosed_bracketed_comment
  return { ok, ...(ok && tree ? { tree } : {}), tokens: stream.getTokens(), unclosedComment: lexer.has_unclosed_bracketed_comment, problems }
}

export const Lexer = SqlBaseLexer
export const Parser = SqlBaseParser

/** The lexer's name for a token type, such as `IDENTIFIER_KW`. */
export const tokenName = (type: number) => SqlBaseLexer.symbolicNames[type] ?? (type === -1 ? "EOF" : `#${type}`)

/** Whether `word`, upper-cased, is one of the lexer's keywords (so it needs backquotes as a name part). */
export function isKeyword(word: string): boolean {
  return SqlBaseLexer.symbolicNames.includes(word.toUpperCase()) && /^[A-Z_]+$/i.test(word)
}

/**
 * Each parse-tree class to its exported name, such as `FunctionCallContext`. Built from the module's exports, whose
 * names survive minification, never from `constructor.name`, which a minified bundle renames.
 */
const CONTEXT_NAMES = new Map<unknown, string>(Object.entries(Generated).filter(([name, value]) => name.endsWith("Context") && typeof value === "function").map(([name, value]) => [value, name]))

/** The grammar name of a parse-tree node's class: its labelled alternative or rule, such as `DropTableContext`. */
export const contextName = (node: object): string => CONTEXT_NAMES.get(node.constructor) ?? "UnknownContext"
