/**
 * The function allowlist (design §5.2) and the keyword forms (review round 3, LOW 2 and LOW 3). Hand-written and
 * reviewed: the names come from src/domain/builtins.generated.ts (Databricks' reference at the pin), and this file
 * takes away the named exclusions, so a reviewer can check the list against the table in design §5.2.
 *
 * Every invocation in a read is one of:
 * - an explicit call (`functionCall`, `tableFunctionCall`, `lateralView`): its name must be an allowlisted built-in,
 *   unqualified or written `system.builtin.<name>`, or a Unity Catalog SQL scalar function named in full
 *   (`catalog.schema.function`, review #1 M2) that passes §5.4. The read path then **rewrites every allowlisted
 *   unqualified call to `system.builtin.<name>`**, so the SQL path cannot redirect it to a same-named function in a
 *   user schema (LOW 3; see PATH_RULE below). A `LATERAL VIEW` generator is the exception: Spark's AstBuilder takes at
 *   most two parts there, so it is sent unqualified and is path-sensitive, like a keyword form (review #1, M1);
 * - a keyword form (`CAST`, `EXTRACT`, `TRIM(BOTH … FROM …)`, `POSITION(… IN …)`, …): a fixed grammar node that names
 *   no function. Each one is listed in KEYWORD_FORMS with what Spark's AstBuilder makes of it. Forms that become a
 *   named function call cannot be qualified in SQL, so they are allowed only when the path is the default
 *   (`PATH_NOT_DEFAULT` otherwise);
 * - anything else that can invoke a function: refused, with a test per form.
 */
import { BUILTIN_NAMES, BUILTIN_TABLE_FUNCTIONS } from "./builtins.generated.js"
import type { Category } from "./actions.js"
import type { Code } from "./errors.js"

export interface Exclusion {
  readonly names: readonly string[]
  readonly code: Extract<Code, "SECRET_FUNCTION_REFUSED" | "FUNCTION_REFUSED" | "NEEDS_PLAN">
  /** The plan category, for NEEDS_PLAN. */
  readonly category?: Category
  readonly why: string
}

/** The built-ins that are never on the allowlist (design §5.2, plus the ones this file adds, each with its reason). */
export const EXCLUSIONS: readonly Exclusion[] = [
  { names: ["secret", "try_secret", "list_secrets"], code: "SECRET_FUNCTION_REFUSED", why: "They return secret values or keys; Databricks redacts only best-effort." },
  { names: ["reflect", "java_method", "try_reflect"], code: "FUNCTION_REFUSED", why: "They call Java methods." },
  { names: ["http_request"], code: "NEEDS_PLAN", category: "write", why: "Sends an HTTP request through a connection." },
  { names: ["remote_query"], code: "NEEDS_PLAN", category: "write", why: "Runs SQL on a remote engine through a connection." },
  { names: ["read_kafka", "read_kinesis", "read_pubsub", "read_pulsar"], code: "NEEDS_PLAN", category: "write", why: "Connect from the warehouse to any endpoint their options name." },
  { names: ["read_files", "cloud_files_state", "list_files", "read_state_metadata", "read_statestore", "event_log"], code: "NEEDS_PLAN", category: "write", why: "Read paths that no fence can check." },
  { names: ["table_changes", "data_skipping_summary"], code: "NEEDS_PLAN", category: "write", why: "Name a table in a string, which the table asserts and the fence cannot see." },
  { names: ["from_avro", "to_avro", "from_protobuf", "to_protobuf"], code: "NEEDS_PLAN", category: "write", why: "Their options can name a schema registry, a network endpoint." },
  { names: ["vector_search"], code: "NEEDS_PLAN", category: "write", why: "Billed outside the warehouse." },
]

/** `ai_*`: billed outside the warehouse (design §5.2). Matched by prefix, so a new AI function is excluded too. */
export const AI_PREFIX = "ai_"

const excluded = new Map<string, Exclusion>()
for (const exclusion of EXCLUSIONS) for (const name of exclusion.names) excluded.set(name, exclusion)

/** The allowlist: every built-in at the pin, minus the exclusions and every `ai_*` function. */
export const ALLOWLIST: ReadonlySet<string> = new Set(BUILTIN_NAMES.filter((name) => !excluded.has(name) && !name.startsWith(AI_PREFIX)))

/** Built-ins allowed in a table position (`FROM f(…)`, `TABLE(f(…))`, `LATERAL VIEW f(…)`). */
export const TABLE_ALLOWLIST: ReadonlySet<string> = new Set(BUILTIN_TABLE_FUNCTIONS.filter((name) => ALLOWLIST.has(name)))

export type FunctionDecision =
  | { readonly kind: "builtin"; readonly name: string }
  | { readonly kind: "refused"; readonly name: string; readonly code: Exclusion["code"]; readonly category?: Category; readonly why: string }
  /** A name the allowlist does not hold: a Unity Catalog function (§5.4 decides), or a built-in added after the pin. */
  | { readonly kind: "unknown"; readonly name: string }

/**
 * The decision for one call's name parts, lower-cased and unquoted. A built-in is unqualified or exactly
 * `system.builtin.<name>`. `system.ai.*` is NEEDS_PLAN (run), and `session.*` / `system.session.*` are refused: a
 * statement sent alone has no temporary functions. `builtin.<name>` is a two-part name Databricks qualifies with
 * current_catalog(), but open-source Spark also tries `system.builtin.<name>` for it, so the exclusions apply to it
 * exactly as to `system.builtin.<name>` (review #1, LOW 1); otherwise it is `unknown`. Any other `system.*` name is
 * NEEDS_PLAN (`notAllowlisted`). Anything else is `unknown`. Parts arrive folded (`foldName`, src/sql/parse.ts).
 */
export function decideFunction(parts: readonly string[], position: "scalar" | "table"): FunctionDecision {
  const name = parts.join(".")
  const builtin = parts.length === 1 ? parts[0]! : parts.length === 3 && parts[0] === "system" && parts[1] === "builtin" ? parts[2]! : undefined
  if (parts.length === 3 && parts[0] === "system" && parts[1] === "ai") return { kind: "refused", name, code: "NEEDS_PLAN", category: "run", why: "system.ai routines run code." }
  if ((parts.length === 2 && parts[0] === "session") || (parts.length === 3 && parts[0] === "system" && parts[1] === "session")) {
    return { kind: "refused", name, code: "FUNCTION_REFUSED", why: "A statement sent alone has no temporary functions." }
  }
  const excludable = builtin ?? (parts.length === 2 && parts[0] === "builtin" ? parts[1]! : undefined)
  if (excludable !== undefined) {
    const exclusion = excluded.get(excludable)
    if (exclusion) return { kind: "refused", name, code: exclusion.code, ...(exclusion.category ? { category: exclusion.category } : {}), why: exclusion.why }
    if (excludable.startsWith(AI_PREFIX)) return { kind: "refused", name, code: "NEEDS_PLAN", category: "write", why: "AI functions are billed outside the warehouse." }
  }
  if (builtin === undefined) return parts[0] === "system" ? notAllowlisted(name) : { kind: "unknown", name }
  if (position === "table" ? TABLE_ALLOWLIST.has(builtin) : ALLOWLIST.has(builtin)) return { kind: "builtin", name: builtin }
  return parts.length === 3 ? notAllowlisted(name) : { kind: "unknown", name }
}

/**
 * A `system.*` routine that is not an allowlisted built-in: a built-in added after the pin (`system.builtin.newfn`),
 * one allowlisted only in another position, or another system schema. Databricks' own, with no Unity Catalog body for
 * §5.4 to check, so Day 0 decides it: NEEDS_PLAN, as design §5.2 says of "any built-in added after the pin", and never
 * a user function for package C (review of #1, round 2, LOW 2).
 */
const notAllowlisted = (name: string): FunctionDecision => ({ kind: "refused", name, code: "NEEDS_PLAN", category: "run", why: "A system routine that is not on the built-in allowlist, such as a built-in added after the pin." })

/**
 * How Databricks resolves a routine name (LOW 3), from its docs, fetched 17 Nov 2026:
 * - "If the name is fully qualified with three parts: `catalog.schema.routine`, it is unique." Built-in scalar and
 *   table functions live in `system.builtin` (sql-ref-name-resolution, "Function and procedure resolution").
 * - An unqualified name is looked up along PATH; the default is `system.session, system.builtin, system.ai,
 *   CURRENT_SCHEMA`, and a workspace admin can change the default (parameters/path: "Workspace: Use SQL configuration
 *   parameters (parameter name `path`) or the SQL Warehouse API").
 * - `SET PATH` changes it per session; the read path refuses `SET` and `SET PATH` (SESSION_STATEMENT_REFUSED), and
 *   with no `;` a read is one statement, so no read can change its own path.
 * So explicit calls are qualified as `system.builtin.<name>` before they are sent (holds under any path), and keyword
 * forms that become a named call need the default path's order (PATH_RULE).
 */
export const PATH_RULE = {
  qualifier: "system.builtin",
  /** The path is safe when no user schema comes before system.builtin: only these may precede it. */
  mayPrecede: ["system.session"],
  sources: [
    "https://docs.databricks.com/aws/en/sql/language-manual/sql-ref-name-resolution",
    "https://docs.databricks.com/aws/en/sql/language-manual/parameters/path",
  ],
} as const

/**
 * Whether `current_path()`'s answer keeps system.builtin before every user schema. In a statement sent alone through
 * the Statement Execution API no temporary function exists (the plugin never creates one), so `system.session`
 * before it is harmless.
 */
export function pathIsSafe(currentPath: string): boolean {
  const entries = currentPath.split(",").map((entry) => entry.trim().replaceAll("`", "").toLowerCase()).filter(Boolean)
  const at = entries.indexOf(PATH_RULE.qualifier)
  if (at === -1) return false
  return entries.slice(0, at).every((entry) => (PATH_RULE.mayPrecede as readonly string[]).includes(entry))
}

/**
 * The keyword forms: grammar nodes that look like or become function calls without a `functionName`. For each, what
 * Spark's AstBuilder (v4.3.0) makes of it (`builds`), and how the read path treats it (`kind`):
 * - `expression`: a fixed expression class, no name lookup at all;
 * - `named`: path-sensitive, allowed only with the default path (PATH_NOT_DEFAULT otherwise). In v4.3.0 only
 *   `EXTRACT` and `BETWEEN` resolve by name; the rest build a fixed class in open-source Spark and are `named` here
 *   **conservatively**, because Databricks' builder is closed (review #1, LOW 2);
 * - `refused`: refused locally, with the code.
 * Keys are the parser's context class names (labelled alternatives); `Between` is the walker's name for a `predicate`
 * whose kind is BETWEEN. test/unit/functions.test.ts checks that every `primaryExpression`, `relationPrimary` and
 * `sampleMethod` alternative of the generated parser is either here or known to invoke nothing, with a test per form.
 */
export const KEYWORD_FORMS = {
  CastContext: { kind: "expression", example: "CAST(x AS INT)", builds: "Cast / TryCast" },
  CastByColonContext: { kind: "expression", example: "x::INT", builds: "Cast" },
  CurrentLikeContext: { kind: "named", names: ["current_date", "current_timestamp", "current_user", "user", "session_user", "current_time", "current_path", "localtime"], example: "current_date", builds: "CurrentDate, CurrentTimestamp, CurrentUser and the like (fixed classes; named here conservatively)" },
  TimestampaddContext: { kind: "named", names: ["timestampadd", "dateadd", "date_add"], example: "TIMESTAMPADD(HOUR, 1, ts)", builds: "TimestampAdd (a fixed class; named here conservatively)" },
  TimestampdiffContext: { kind: "named", names: ["timestampdiff", "datediff", "date_diff", "timediff"], example: "TIMESTAMPDIFF(HOUR, a, b)", builds: "TimestampDiff (a fixed class; named here conservatively)" },
  ExtractContext: { kind: "named", names: ["extract"], example: "EXTRACT(YEAR FROM d)", builds: "UnresolvedFunction(extract)" },
  SubstringContext: { kind: "named", names: ["substring", "substr"], example: "SUBSTRING(s FROM 2 FOR 3)", builds: "Substring (a fixed class; named here conservatively)" },
  TrimContext: { kind: "named", names: ["trim", "btrim", "ltrim", "rtrim"], example: "TRIM(BOTH 'x' FROM s)", builds: "StringTrim, StringTrimLeft, StringTrimRight (fixed classes; named here conservatively)" },
  PositionContext: { kind: "named", names: ["position", "locate"], example: "POSITION('a' IN s)", builds: "StringLocate (a fixed class; named here conservatively)" },
  OverlayContext: { kind: "named", names: ["overlay"], example: "OVERLAY(s PLACING 'x' FROM 2)", builds: "Overlay (a fixed class; named here conservatively)" },
  FirstContext: { kind: "named", names: ["first"], example: "FIRST(x IGNORE NULLS)", builds: "First (a fixed class; named here conservatively)" },
  LastContext: { kind: "named", names: ["last"], example: "LAST(x IGNORE NULLS)", builds: "Last (a fixed class; named here conservatively)" },
  Any_valueContext: { kind: "named", names: ["any_value"], example: "ANY_VALUE(x IGNORE NULLS)", builds: "AnyValue (a fixed class; named here conservatively)" },
  StructContext: { kind: "expression", example: "STRUCT(a, b)", builds: "CreateStruct" },
  SearchedCaseContext: { kind: "expression", example: "CASE WHEN a THEN b END", builds: "CaseWhen" },
  SimpleCaseContext: { kind: "expression", example: "CASE a WHEN 1 THEN b END", builds: "CaseWhen" },
  CollateContext: { kind: "expression", example: "s COLLATE UTF8_LCASE", builds: "Collate" },
  SemiStructuredExtractContext: { kind: "expression", example: "v:a.b", builds: "VariantGet" },
  LambdaContext: { kind: "expression", example: "x -> x + 1", builds: "LambdaFunction (its body is walked)" },
  /** BETWEEN in a predicate; AstBuilder builds the built-in `between`. */
  Between: { kind: "named", names: ["between"], example: "x BETWEEN 1 AND 2", builds: "UnresolvedFunction(between)" },
  /** `TABLESAMPLE (BUCKET x OUT OF y ON f())`: Spark rejects it at parse time; refused locally for a clear message. */
  SampleByBucketContext: { kind: "refused", code: "FUNCTION_REFUSED", example: "TABLESAMPLE (BUCKET 1 OUT OF 2 ON f())", builds: "an error in AstBuilder" },
  /** `SELECT TRANSFORM(…) USING '<cmd>'` runs a command (design §5.1). */
  TransformClauseContext: { kind: "refused", code: "FUNCTION_REFUSED", example: "SELECT TRANSFORM(a) USING 'cat' FROM t", builds: "ScriptTransformation" },
} as const satisfies Record<string, { readonly kind: "expression" | "named" | "refused"; readonly example: string; readonly builds: string; readonly names?: readonly string[]; readonly code?: Code }>

/**
 * The niladic forms Databricks resolves before the path: "If the identifier is unqualified and matches `current_user`,
 * `current_date`, or `current_timestamp`: Resolve it as one of these functions" (sql-ref-name-resolution, rule 1.2).
 * The other niladic forms (`user`, `session_user`, `current_time`, `current_path`, `localtime`) follow PATH_RULE.
 */
export const NILADIC_FIXED: ReadonlySet<string> = new Set(["current_date", "current_timestamp", "current_user"])
