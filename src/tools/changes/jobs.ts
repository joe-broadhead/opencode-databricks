/**
 * `databricks_jobs` (design §4, [29]): jobs, their runs, and one run's tasks and output. Free control-plane reads; the
 * runs themselves bill separately.
 *
 * - `{}` lists jobs from `jobs/list` (at most 100 a page, `limit` default 25), with the creator and the state of each
 *   job's most recent run. `runs/list` sorts by start time descending and takes at most 25 runs a page, so one call
 *   answers "the latest runs across every visible job"; a job with no run in that window shows no state rather than a
 *   guessed one (the design's §11.2 windowing, applied to a preview-sized read).
 * - `{ jobId }` lists that job's runs (`runs/list`), with state, start and duration.
 * - `{ runId }` reads one run (`runs/get`) with its tasks, states, durations and errors. With `output: true` it also
 *   reads `runs/get-output`, where Databricks returns at most 5 MB, and cuts it to 8 KiB: it is untrusted text
 *   (design §5.8), so it is data for the model and never an instruction.
 *
 * The `jobs` API family is an opt-in feature (design §3.3), so an account without it is `AUTH_SCOPE_MISSING` before any
 * call: without the scope, the server would refuse every one of these calls anyway.
 */
import type { RunInfo } from "../../ports.js"
import { assertTool } from "../../registry.js"
import type { Handler } from "../../tool-spec.js"
import { accountOf, requireFeature } from "./context.js"

/** The run output the model sees: Databricks returns at most 5 MB, and this is what of it is inline (design §4). */
export const OUTPUT_LIMIT = 8 * 1024

const stateOf = (run: RunInfo): string => run.state.resultState ?? run.state.lifeCycleState

const durationOf = (run: RunInfo): number | undefined => (run.endTime === undefined ? undefined : Math.max(0, run.endTime - run.startTime))

const iso = (ms: number) => new Date(ms).toISOString()

/** Text cut to a byte limit, with a marker that says so. The text is untrusted: it is cut, never interpreted. */
export function cutBytes(text: string, limit: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, "utf8")
  if (bytes.length <= limit) return { text, cut: false }
  return { text: `${bytes.subarray(0, limit).toString("utf8")}…[cut at ${limit} bytes]`, cut: true }
}

const jobs: Handler<"jobs"> = async (input, call, deps) => {
  const account = accountOf(input, deps)
  await assertTool("jobs", account, call, deps)
  requireFeature(deps, account, "jobs", "databricks_jobs")
  const limit = input.limit ?? 25

  if (input.runId !== undefined) {
    const run = await deps.databricks.getRun(account, input.runId, call.signal)
    const output = input.output
      ? cutBytes((await deps.databricks.getRunOutput(account, input.runId, call.signal)).output ?? "", OUTPUT_LIMIT)
      : undefined
    return {
      state: "ok",
      trust: "untrusted",
      run: {
        id: run.runId,
        tasks: run.tasks.map((task) => ({ key: task.taskKey, state: task.state, ...(task.durationMs === undefined ? {} : { durationMs: task.durationMs }), ...(task.error ? { error: task.error } : {}) })),
        ...(output ? { output: output.text } : {}),
      },
      ...(output?.cut ? { next: `The output was cut at ${OUTPUT_LIMIT} bytes; open the run in Databricks for all of it.` } : {}),
    }
  }

  if (input.jobId !== undefined) {
    // "The number of runs to return. This value must be greater than 0 and less than 25." (runs/list), so a caller's
    // larger limit is capped here rather than refused by Databricks.
    const page = await deps.databricks.listRuns(account, { jobId: input.jobId, limit: Math.min(limit, 25), ...(input.pageToken ? { pageToken: input.pageToken } : {}) }, call.signal)
    return {
      state: "ok",
      trust: "untrusted",
      runs: page.items.map((run) => ({
        id: run.runId,
        state: stateOf(run),
        startedAt: iso(run.startTime),
        ...(durationOf(run) === undefined ? {} : { durationMs: durationOf(run) }),
      })),
      ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
    }
  }

  const page = await deps.databricks.listJobs(account, { limit, ...(input.pageToken ? { pageToken: input.pageToken } : {}) }, call.signal)
  // One `runs/list` for every job: the newest run per job, so `{}` stays one page of calls for a list of jobs.
  const latest = await deps.databricks.listRuns(account, { limit: 25 }, call.signal)
  const lastState = new Map<number, string>()
  for (const run of latest.items) if (run.jobId !== undefined && !lastState.has(run.jobId)) lastState.set(run.jobId, stateOf(run))
  return {
    state: "ok",
    trust: "untrusted",
    jobs: page.items.map((job) => ({ id: job.jobId, name: job.name, ...(job.creatorUserName ? { creator: job.creatorUserName } : {}), ...(lastState.has(job.jobId) ? { lastRunState: lastState.get(job.jobId)! } : {}) })),
    ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
  }
}

export default jobs
