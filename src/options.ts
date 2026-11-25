// Plugin options (design §13). Strict: an option that is not listed here is refused with OPTIONS_INVALID rather than
// ignored, so a typo cannot silently leave the plugin more open than the user meant. No option holds a secret:
// `tokenEnv` and `clientSecretEnv` name environment variables, and `profile` names a CLI profile.
import * as z from "zod"
import { ACCESS_VALUES } from "./constants.js"
import { SIZES } from "./provider/cost.js"
import { DatabricksError } from "./domain/errors.js"

const Pattern = z.string().min(1).max(767)
const ByteSize = z.union([z.number().int().positive(), z.string().regex(/^\d+(?:KiB|MiB|GiB)?$/u, 'a size such as "32KiB" or "256MiB"')])

export const AccountSchema = z.strictObject({
  host: z.string().max(2048).optional(),
  mode: z.enum(["interactive", "pat", "m2m", "cli"]).default("interactive"),
  clientId: z.string().max(256).optional(),
  role: z.string().max(256).optional(),
  warehouse: z.string().max(64).optional(),
  catalog: z.string().max(255).optional(),
  schema: z.string().max(255).optional(),
  scopes: z.enum(["fine", "all-apis"]).default("fine"),
  features: z.array(z.enum(["jobs", "workspace", "files"])).default([]),
  fence: z.strictObject({ allow: z.array(Pattern).optional(), deny: z.array(Pattern).optional() }).optional(),
  inline: z.strictObject({ deny: z.array(Pattern).optional(), piiTags: z.array(z.string().max(255)).optional() }).optional(),
  tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/u, "an environment variable name").optional(),
  clientSecretEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/u, "an environment variable name").optional(),
  profile: z.string().max(128).optional(),
})

const BudgetLimit = z.strictObject({ starts: z.number().int().min(0).optional(), dbuHours: z.number().min(0).optional() })

export const OptionsSchema = z.strictObject({
  access: z.enum(ACCESS_VALUES).default("all"),
  accounts: z.record(z.string().regex(/^[a-z][a-z0-9]{0,31}$/u, "an alias: lower-case letters and digits, starting with a letter"), AccountSchema).optional(),
  redirectUri: z.string().url().optional(),
  callbackPort: z.number().int().min(1024).max(65535).default(8765),
  allowCustomHost: z.boolean().default(false),
  maxStartSize: z.enum(SIZES as [string, ...string[]]).default("Small"),
  maxStartAutoStopMinutes: z.number().int().min(1).max(10080).default(15),
  maxRunSize: z.enum(SIZES as [string, ...string[]]).optional(),
  maxRunSeconds: z.number().int().min(51).max(172800).default(600),
  wait: z.number().int().min(0).max(600).default(50),
  budget: z.strictObject({ daily: BudgetLimit.optional(), session: BudgetLimit.optional(), action: z.enum(["warn", "refuse"]) }).optional(),
  usdPerDbu: z.strictObject({ serverless: z.number().min(0), pro: z.number().min(0), classic: z.number().min(0) }).default({ serverless: 0.7, pro: 0.55, classic: 0.22 }),
  maxRows: z.number().int().min(1).max(500).default(50),
  maxInlineBytes: ByteSize.default("32KiB"),
  maxSaveRows: z.number().int().min(1).max(10_000_000).default(1_000_000),
  maxSaveBytes: ByteSize.default("256MiB"),
  resultsDir: z.string().max(4096).default(".databricks/results"),
  inlinePii: z.enum(["warn", "save-only"]).default("warn"),
  dependencyDepth: z.number().int().min(1).max(10).default(4),
  runTimeoutSeconds: z.number().int().min(60).max(172800).default(3600),
  admin: z.strictObject({ enabled: z.boolean().default(true), requireReason: z.boolean().default(true) }).default({ enabled: true, requireReason: true }),
  allowUntestedHost: z.boolean().default(false),
})

export type Options = z.output<typeof OptionsSchema>
export type AccountOptions = z.output<typeof AccountSchema>

const EXAMPLE = `"plugins": [{ "package": "github:we-the-rebel-alliance/databricks-plugin#v0.0.0", "options": { "access": "ask-changes" } }]`

/** Bytes for a size option: a number, or "32KiB", "256MiB", "1GiB". */
export function bytesOf(value: number | string): number {
  if (typeof value === "number") return value
  const match = /^(\d+)(KiB|MiB|GiB)?$/u.exec(value)!
  const unit = match[2] === "KiB" ? 1024 : match[2] === "MiB" ? 1024 ** 2 : match[2] === "GiB" ? 1024 ** 3 : 1
  return Number(match[1]) * unit
}

export function loadOptions(raw: unknown): Options {
  const result = OptionsSchema.safeParse(raw ?? {})
  if (result.success) return result.data
  const issue = result.error.issues[0]
  const path = issue?.code === "unrecognized_keys" ? [...issue.path, issue.keys[0]].join(".") : issue?.path.join(".")
  const message = issue?.code === "unrecognized_keys" ? "this option does not exist" : (issue?.message ?? "invalid value")
  throw new DatabricksError("OPTIONS_INVALID", path ? `Invalid plugin option "${path}": ${message}.` : `Invalid plugin options: ${message}.`, `Fix the plugin's options in opencode.json, for example ${EXAMPLE}.`)
}
