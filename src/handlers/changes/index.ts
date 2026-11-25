/**
 * The plan, commit, cancel, stop and start methods. Each class has its own plan, because the contract binds one plan
 * method to exactly one commit method (`plans` and `commits`); the six plans share the classifier and refuse a change of
 * another class.
 */
import type { Handlers } from "../types.js"
import cancel from "./cancel.js"
import { commitTool } from "./commit.js"
import jobs from "./jobs.js"
import { planAdmin, planDelete, planExport, planRun, planShare, planWrite } from "./plan.js"
import start from "../start.js"
import stop from "./stop.js"
import workspace from "./workspace.js"

export const CHANGE_HANDLERS = {
  jobs,
  workspace,
  plan_write: planWrite,
  plan_delete: planDelete,
  plan_share: planShare,
  plan_export: planExport,
  plan_run: planRun,
  plan_admin: planAdmin,
  write: commitTool("write"),
  delete: commitTool("delete"),
  share: commitTool("share"),
  export: commitTool("export"),
  run: commitTool("run"),
  admin: commitTool("admin"),
  cancel,
  stop,
  start,
} as const satisfies Partial<Handlers>

export { cancel, commitTool, jobs, start, stop, workspace }
