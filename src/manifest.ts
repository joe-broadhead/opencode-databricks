/**
 * The capabilities manifest, read from the installed package.json: the one place a consumer, the catalog and the kit
 * read what this plugin can do (contract §4). The code's method table in `src/methods.ts` is checked against it.
 */
import packageJson from "../package.json" with { type: "json" }
import type { Manifest } from "@we-the-rebel-alliance/plugin-contract/manifest"

export const manifest = packageJson.capabilities as unknown as Manifest
export const version = packageJson.version
export const packageName = packageJson.name
