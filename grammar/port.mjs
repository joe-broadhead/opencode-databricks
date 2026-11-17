// The hand port of Spark's grammar actions from Java to TypeScript, reviewed with each pin (grammar/spark/PIN.json).
//
// Spark's SqlBaseLexer.g4 and SqlBaseParser.g4 are not action-free: they hold `@header` Java imports, `@members` Java
// code, semantic predicates (`{…}?`) and actions (`{…;}`). The ANTLR TypeScript target copies those verbatim, so each one
// is replaced here by its TypeScript equivalent before generation. Every replacement names the exact Java text and how
// many times it must occur: a grammar change at a new pin that adds, removes or edits an action fails the generator
// until a person ports it here. Nothing else in the grammar is touched.
//
// The behaviour flags are pinned to a SQL warehouse's defaults (design §5.3): SQL_standard_keyword_behavior (ANSI
// reserved keywords) on, double_quoted_identifiers off, legacy_setops_precedence_enabled off,
// legacy_exponent_literal_as_decimal_enabled off, and Spark's own defaults for the rest. The differential fuzz
// (test/fuzz) sets the same values on Spark's JVM parser.

/** The flags, as the generated parser's fields start. The JVM harness sets the same values. */
export const FLAGS = {
  legacy_setops_precedence_enabled: false,
  legacy_exponent_literal_as_decimal_enabled: false,
  SQL_standard_keyword_behavior: true,
  double_quoted_identifiers: false,
  parameter_substitution_enabled: true,
  legacy_identifier_clause_only: false,
  single_character_pipe_operator_enabled: true,
}

const LEXER_MEMBERS = `@members {
  /** When true, the parser reports an unclosed bracketed comment. */
  public has_unclosed_bracketed_comment = false;

  /** A decimal token is valid when the character after it is not a letter, a digit or an underscore (upper-cased stream). */
  public isValidDecimal(): boolean {
    const nextChar = this.inputStream.LA(1);
    return !((nextChar >= 65 && nextChar <= 90) || (nextChar >= 48 && nextChar <= 57) || nextChar === 95);
  }

  /** At \`/*\`: whether the next character is \`+\`, which makes it a hint rather than a comment. */
  public isHint(): boolean {
    return this.inputStream.LA(1) === 43;
  }

  /** Called when the input ends inside a bracketed comment. */
  public markUnclosedComment(): void {
    this.has_unclosed_bracketed_comment = true;
  }

  /** The open dollar-quote tags, innermost last. */
  private tags: string[] = [];

  /** Above zero while inside ARRAY<…>, MAP<…> or STRUCT<…>. */
  public complex_type_level_counter = 0;

  public incComplexTypeLevelCounter(): void {
    this.complex_type_level_counter++;
  }

  public decComplexTypeLevelCounter(): void {
    if (this.complex_type_level_counter > 0) this.complex_type_level_counter--;
  }

  public isShiftRightOperator(): boolean {
    return this.complex_type_level_counter === 0;
  }

  public topTag(): string | undefined {
    return this.tags[this.tags.length - 1];
  }
}`

const PARSER_MEMBERS = `@members {
  public legacy_setops_precedence_enabled = ${FLAGS.legacy_setops_precedence_enabled};
  public legacy_exponent_literal_as_decimal_enabled = ${FLAGS.legacy_exponent_literal_as_decimal_enabled};
  public SQL_standard_keyword_behavior = ${FLAGS.SQL_standard_keyword_behavior};
  public double_quoted_identifiers = ${FLAGS.double_quoted_identifiers};
  public parameter_substitution_enabled = ${FLAGS.parameter_substitution_enabled};
  public legacy_identifier_clause_only = ${FLAGS.legacy_identifier_clause_only};
  public single_character_pipe_operator_enabled = ${FLAGS.single_character_pipe_operator_enabled};

  /** After a PIPE: whether the token after it starts a pipe operator's right side. */
  public isOperatorPipeStart(): boolean {
    if (!this.single_character_pipe_operator_enabled) return false;
    const la = this.tokenStream.LA(2);
    return la === SqlBaseParser.SELECT || la === SqlBaseParser.EXTEND || la === SqlBaseParser.SET || la === SqlBaseParser.DROP ||
      la === SqlBaseParser.AS || la === SqlBaseParser.WHERE || la === SqlBaseParser.PIVOT || la === SqlBaseParser.UNPIVOT ||
      la === SqlBaseParser.TABLESAMPLE || la === SqlBaseParser.INNER || la === SqlBaseParser.CROSS || la === SqlBaseParser.LEFT ||
      la === SqlBaseParser.RIGHT || la === SqlBaseParser.FULL || la === SqlBaseParser.NATURAL || la === SqlBaseParser.SEMI ||
      la === SqlBaseParser.ANTI || la === SqlBaseParser.ASOF || la === SqlBaseParser.JOIN || la === SqlBaseParser.UNION || la === SqlBaseParser.EXCEPT ||
      la === SqlBaseParser.SETMINUS || la === SqlBaseParser.INTERSECT || la === SqlBaseParser.ORDER || la === SqlBaseParser.CLUSTER ||
      la === SqlBaseParser.DISTRIBUTE || la === SqlBaseParser.SORT || la === SqlBaseParser.LIMIT || la === SqlBaseParser.OFFSET ||
      la === SqlBaseParser.AGGREGATE || la === SqlBaseParser.WINDOW || la === SqlBaseParser.LATERAL || la === SqlBaseParser.BIN;
  }
}`

/** A block from its opening line to the first line that is exactly `}` after it. */
const block = (start) => new RegExp(`${start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n[\\s\\S]*?\\n\\}\\n`)

/**
 * Each entry: the file, the Java text (a string, or a RegExp for a whole block), the TypeScript text, and how many
 * times the Java text must occur.
 */
export const PORT = [
  { file: "SqlBaseLexer.g4", java: block("@header {"), ts: "", count: 1, why: "Java imports" },
  { file: "SqlBaseLexer.g4", java: block("@members {"), ts: `${LEXER_MEMBERS}\n`, count: 1, why: "lexer members" },
  { file: "SqlBaseLexer.g4", java: "{incComplexTypeLevelCounter();}", ts: "{this.incComplexTypeLevelCounter();}", count: 3, why: "ARRAY, MAP, STRUCT" },
  { file: "SqlBaseLexer.g4", java: "{decComplexTypeLevelCounter();}", ts: "{this.decComplexTypeLevelCounter();}", count: 1, why: "GT" },
  { file: "SqlBaseLexer.g4", java: "{isShiftRightOperator()}?", ts: "{this.isShiftRightOperator()}?", count: 2, why: ">> and >>>" },
  { file: "SqlBaseLexer.g4", java: "{tags.push(getText());}", ts: "{this.tags.push(this.text);}", count: 1, why: "dollar-quote open" },
  { file: "SqlBaseLexer.g4", java: "{isValidDecimal()}?", ts: "{this.isValidDecimal()}?", count: 5, why: "decimal literals" },
  { file: "SqlBaseLexer.g4", java: "{!isHint()}?", ts: "{!this.isHint()}?", count: 1, why: "bracketed comment vs hint" },
  { file: "SqlBaseLexer.g4", java: "{markUnclosedComment();}", ts: "{this.markUnclosedComment();}", count: 1, why: "unclosed comment" },
  { file: "SqlBaseLexer.g4", java: "{getText().equals(tags.peek())}? {tags.pop();}", ts: "{this.text === this.topTag()}? {this.tags.pop();}", count: 1, why: "dollar-quote close" },
  { file: "SqlBaseParser.g4", java: block("@members {"), ts: `${PARSER_MEMBERS}\n`, count: 1, why: "parser members" },
  { file: "SqlBaseParser.g4", java: "{legacy_setops_precedence_enabled}?", ts: "{this.legacy_setops_precedence_enabled}?", count: 1, why: "set operations" },
  { file: "SqlBaseParser.g4", java: "{!legacy_setops_precedence_enabled}?", ts: "{!this.legacy_setops_precedence_enabled}?", count: 2, why: "set operations" },
  { file: "SqlBaseParser.g4", java: "{isOperatorPipeStart()}?", ts: "{this.isOperatorPipeStart()}?", count: 1, why: "pipe statement" },
  { file: "SqlBaseParser.g4", java: "{!isOperatorPipeStart()}?", ts: "{!this.isOperatorPipeStart()}?", count: 1, why: "bitwise or" },
  { file: "SqlBaseParser.g4", java: "{!SQL_standard_keyword_behavior}?", ts: "{!this.SQL_standard_keyword_behavior}?", count: 4, why: "non-reserved keywords" },
  { file: "SqlBaseParser.g4", java: "{SQL_standard_keyword_behavior}?", ts: "{this.SQL_standard_keyword_behavior}?", count: 2, why: "ANSI non-reserved keywords" },
  { file: "SqlBaseParser.g4", java: "{!legacy_identifier_clause_only}?", ts: "{!this.legacy_identifier_clause_only}?", count: 1, why: "IDENTIFIER('literal')" },
  { file: "SqlBaseParser.g4", java: "{double_quoted_identifiers}?", ts: "{this.double_quoted_identifiers}?", count: 1, why: "double-quoted identifiers" },
  { file: "SqlBaseParser.g4", java: "{!double_quoted_identifiers}?", ts: "{!this.double_quoted_identifiers}?", count: 1, why: "double-quoted strings" },
  { file: "SqlBaseParser.g4", java: "{!legacy_exponent_literal_as_decimal_enabled}?", ts: "{!this.legacy_exponent_literal_as_decimal_enabled}?", count: 2, why: "exponent literals" },
  { file: "SqlBaseParser.g4", java: "{legacy_exponent_literal_as_decimal_enabled}?", ts: "{this.legacy_exponent_literal_as_decimal_enabled}?", count: 1, why: "legacy decimal literals" },
  { file: "SqlBaseParser.g4", java: "{parameter_substitution_enabled}?", ts: "{this.parameter_substitution_enabled}?", count: 2, why: "parameter markers" },
  {
    file: "SqlBaseParser.g4",
    java: "{((SqlBaseLexer) getTokenStream().getTokenSource()).decComplexTypeLevelCounter();}",
    ts: "{(this.tokenStream.tokenSource as unknown as { decComplexTypeLevelCounter(): void }).decComplexTypeLevelCounter();}",
    count: 1,
    why: "STRUCT<> closes a complex type in the lexer",
  },
]

/** After the port, no Java may remain: these fragments mean a predicate or action the table missed. */
export const LEFTOVER_JAVA = [
  /\{\s*!?[A-Za-z_]\w*(\(\))?\s*\}\?/,
  /\{\s*[a-z]\w*\([^)]*\);\s*\}/,
  /getText\(\)/,
  /getTokenStream\(\)/,
  /\(\(\s*[A-Z]\w*\s*\)/,
  /\bpublic (?:boolean|void|int)\b/,
  /\bimport java\./,
  /\.equals\(/,
]
