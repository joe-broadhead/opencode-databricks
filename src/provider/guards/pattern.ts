/**
 * The `catalog.schema.table` patterns the fence and the inline rules share (design §5.6, §5.7): a person writes them in
 * `accounts.<alias>.fence: { allow, deny }` and `accounts.<alias>.inline: { deny }`, and each pattern is a glob over
 * the dotted name, compared case-insensitively because a Unity Catalog name resolves case-insensitively.
 *
 * - `*` stands for any run of characters, and a pattern matches the whole name: `*.hr.*` matches `work.hr.orders` and
 *   `main.x.hr.salaries`, but not `work.hrx.orders`.
 * - Only `*` is special. Everything else, dots included, is literal, so `main.sales.*` does not reach `main.salesx.t`.
 * - An empty pattern list matches nothing.
 *
 * The fence is advisory (design §5.6): it is the plugin's check over what Unity Catalog resolved, and the guarantee is
 * still the identity's privileges.
 */
const source = (pattern: string): string =>
  `^${pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*")}$`

const compiled = new Map<string, RegExp>()

/** Whether `name` matches one pattern, case-insensitively. */
export function patternMatches(pattern: string, name: string): boolean {
  let regex = compiled.get(pattern)
  if (!regex) {
    regex = new RegExp(source(pattern), "iu")
    compiled.set(pattern, regex)
  }
  return regex.test(name)
}

/** Whether any of `patterns` matches `name`. */
export function matchesAny(patterns: readonly string[] | undefined, name: string): boolean {
  return (patterns ?? []).some((pattern) => patternMatches(pattern, name))
}

/** The pattern that first matches `name`, or undefined: for a message that names the person's own rule. */
export function firstMatch(patterns: readonly string[] | undefined, name: string): string | undefined {
  return (patterns ?? []).find((pattern) => patternMatches(pattern, name))
}

/**
 * A Databricks value made safe for the plugin's own words (design §5.8): control characters (newlines and tabs
 * included) become spaces, so nothing can start a new line of instructions, and the text is cut to `limit` characters.
 * Unity Catalog and warehouse names are other people's writing.
 */
export function safeText(text: string, limit = 120): string {
  const flat = text.replace(/\p{Cc}|[\u2028\u2029]/gu, " ").trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/** A validated identifier for the plugin's own words: backquoted, escaped, cut to 120 characters (design §5.8). */
export function quoted(name: string, limit = 120): string {
  return `\`${safeText(name, limit).replaceAll("`", "``")}\``
}
