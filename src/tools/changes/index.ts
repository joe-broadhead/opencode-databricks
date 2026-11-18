/**
 * Package D's tools (design §16): `databricks_plan` beyond SQL, the six commit tools, `_cancel`, `_stop`, `_jobs` and
 * `_workspace`, over `src/drift.ts` and the Day 0 plan store. `src/registry.ts` wires them into `HANDLERS`; the read
 * tools stay package C's, and the tools RPC (§4) exposes none of these, because a change is never a script's method.
 *
 * The six commit tools are one handler with the category as its parameter: they differ only in the plan they accept
 * (`CATEGORY_MISMATCH` names the right one) and the tool whose dotted action they assert.
 */
import type { Handlers } from "../../tool-spec.js"
import cancel from "./cancel.js"
import { commitTool } from "./commit.js"
import jobs from "./jobs.js"
import plan from "./plan.js"
import stop from "./stop.js"
import workspace from "./workspace.js"

export const CHANGE_HANDLERS = {
  jobs,
  workspace,
  plan,
  write: commitTool("write"),
  delete: commitTool("delete"),
  share: commitTool("share"),
  export: commitTool("export"),
  run: commitTool("run"),
  admin: commitTool("admin"),
  cancel,
  stop,
} as const satisfies Partial<Handlers>

export { cancel, commitTool, jobs, plan, stop, workspace }
