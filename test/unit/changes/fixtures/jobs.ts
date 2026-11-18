/**
 * Fixtures for the Jobs API 2.2 calls package D makes, copied from Databricks' REST reference on 17 Nov 2026. Every
 * body below is the reference page's own example, trimmed to the fields this plugin reads or sends — no field, value or
 * constraint here is invented, and each block names the page it came from.
 *
 * These are the shapes `src/tools/changes/jobs.ts`, `commit.ts` and `plan.ts` rely on: a run's `run_id`, a run's
 * `state.life_cycle_state` / `result_state`, a task's `task_key` and `state`, `idempotency_token`'s 64-character limit, and
 * `timeout_seconds`'s documented default of `0` ("no timeout"). `fixtures/api.ts` validates every request against the
 * field lists here, and answers with the bodies here.
 */

/** One documented endpoint: its method, path template, request field sets and the page it came from. */
export interface Fixture {
  readonly method: "GET" | "POST"
  readonly path: string
  readonly cite: string
  /** Body fields the reference marks required. */
  readonly required?: readonly string[]
  /** Every body field the reference documents. */
  readonly optional?: readonly string[]
  /** Query parameters the reference documents, and the required ones. */
  readonly query?: readonly string[]
  readonly queryRequired?: readonly string[]
}

/**
 * `POST /api/2.2/jobs/run-now`: "Run a job and return the `run_id` of the triggered run."
 * Body: `job_id` (required), `job_parameters`, `idempotency_token`, `queue`, `only`, `performance_target`,
 * `pipeline_params`. "This token must have at most 64 characters." Response: `run_id`, `number_in_job` (deprecated).
 * https://docs.databricks.com/api/jobs/v2/run-now.md
 */
export const RUN_NOW: Fixture = {
  method: "POST",
  path: "/api/2.2/jobs/run-now",
  cite: "https://docs.databricks.com/api/jobs/v2/run-now.md",
  required: ["job_id"],
  optional: ["job_parameters", "idempotency_token", "queue", "only", "performance_target", "pipeline_params"],
}
export const RUN_NOW_RESPONSE = { run_id: 455644833, number_in_job: 455644833 } as const
/** The reference's request example, verbatim. */
export const RUN_NOW_REQUEST = {
  job_id: 11223344,
  job_parameters: {},
  idempotency_token: "8f018174-4792-40d5-bcbc-3e6a527352c8",
  queue: { enabled: true },
  only: ["notebook_task_1"],
  performance_target: "PERFORMANCE_OPTIMIZED",
} as const
/** "This token must have at most 64 characters." */
export const IDEMPOTENCY_TOKEN_MAX = 64

/**
 * `POST /api/2.2/jobs/runs/submit`: "Submit a one-time run." Response: `run_id`.
 * `timeout_seconds`: "An optional timeout applied to each run of this job. A value of `0` means no timeout."
 * Default: `0`. `idempotency_token`: "If a run with the provided token already exists, the request does not create a
 * new run but returns the ID of the existing run instead."
 * https://docs.databricks.com/api/jobs/v2/submit-run.md
 */
export const SUBMIT_RUN: Fixture = {
  method: "POST",
  path: "/api/2.2/jobs/runs/submit",
  cite: "https://docs.databricks.com/api/jobs/v2/submit-run.md",
  required: [],
  optional: ["access_control_list", "queue", "run_as", "run_name", "timeout_seconds", "health", "idempotency_token", "tasks"],
}
export const SUBMIT_RUN_RESPONSE = { run_id: 455644833 } as const
/** The task fields the reference documents (`tasks`, "Constraints: <= 100 items"). */
export const SUBMIT_RUN_TASK_FIELDS = [
  "task_key",
  "description",
  "depends_on",
  "run_if",
  "timeout_seconds",
  "email_notifications",
  "health",
  "notification_settings",
  "webhook_notifications",
  "environment_key",
  "disabled",
  "compute",
  "environment_variables_key",
  "notebook_task",
  "spark_jar_task",
  "spark_python_task",
  "spark_submit_task",
  "pipeline_task",
  "python_wheel_task",
  "dbt_task",
  "sql_task",
  "run_job_task",
  "condition_task",
  "for_each_task",
] as const
/** `notebook_task`'s documented fields. */
export const NOTEBOOK_TASK_FIELDS = ["notebook_path", "base_parameters", "source", "warehouse_id"] as const
export const SUBMIT_RUN_TASKS_MAX = 100

/**
 * `GET /api/2.2/jobs/runs/get`: "Retrieves the metadata of a run."
 * Query: `run_id` (required), `include_history`, `include_resolved_values`, `page_token`.
 * Response (the reference's example, trimmed to what the plugin reads): `run_id`, `job_id`, `run_name`, `run_type`,
 * `state.life_cycle_state`, `state.result_state`, `start_time`, `end_time`, and `tasks[]` with `task_key`, `state`,
 * `start_time`, `end_time`, `run_duration`.
 * https://docs.databricks.com/api/jobs/v2/get-run.md
 */
export const GET_RUN: Fixture = {
  method: "GET",
  path: "/api/2.2/jobs/runs/get",
  cite: "https://docs.databricks.com/api/jobs/v2/get-run.md",
  query: ["run_id", "include_history", "include_resolved_values", "page_token"],
  queryRequired: ["run_id"],
}
/** The reference's run object, with the values the plugin reads (the example's own `state` and task shape). */
export const GET_RUN_RESPONSE = {
  job_id: 11223344,
  run_id: 455644833,
  creator_user_name: "user.name@databricks.com",
  state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS", state_message: "string", user_cancelled_or_timedout: false },
  run_name: "A multitask job run",
  run_type: "JOB_RUN",
  trigger: "PERIODIC",
  start_time: 1625060460483,
  end_time: 1625060863413,
  tasks: [
    {
      run_id: 99887766,
      task_key: "Orders_Ingest",
      state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" },
      start_time: 1625060460483,
      end_time: 1625060863413,
      run_duration: 110183,
    },
  ],
} as const

/**
 * `POST /api/2.2/jobs/runs/cancel`: "Cancels a job run or a task run. The run is canceled asynchronously, so it may
 * still be running when this request completes." Body: `run_id` (required). Response: `{}`.
 * https://docs.databricks.com/api/jobs/v2/cancel-run.md
 */
export const CANCEL_RUN: Fixture = { method: "POST", path: "/api/2.2/jobs/runs/cancel", cite: "https://docs.databricks.com/api/jobs/v2/cancel-run.md", required: ["run_id"] }
export const CANCEL_RUN_RESPONSE = {} as const

/**
 * `GET /api/2.2/jobs/list`: "Retrieves a list of jobs." Query: `limit` ("must be greater than 0 and less or equal to
 * 100", default 20), `expand_tasks`, `name`, `page_token`. Response: `jobs[]` with `job_id`, `creator_user_name`,
 * `settings{}`, and `next_page_token` / `prev_page_token`.
 * https://docs.databricks.com/api/jobs/v2/list-jobs.md
 */
export const LIST_JOBS: Fixture = {
  method: "GET",
  path: "/api/2.2/jobs/list",
  cite: "https://docs.databricks.com/api/jobs/v2/list-jobs.md",
  query: ["limit", "expand_tasks", "name", "page_token"],
}
export const LIST_JOBS_RESPONSE = {
  jobs: [{ job_id: 11223344, creator_user_name: "user.name@databricks.com", settings: { name: "A multitask job" } }],
  next_page_token: "CAEomPuciYcxMKbM9JvMlwU=",
  prev_page_token: "CAAos-uriYcxMN7_rt_v7B4=",
} as const
export const LIST_JOBS_LIMIT_MAX = 100

/**
 * `GET /api/2.2/jobs/runs/list`: "List runs in descending order by start time." Query: `job_id`, `active_only`,
 * `completed_only`, `limit` ("greater than 0 and less than 25", default 20, `[1..25]`), `run_type`, `expand_tasks`,
 * `start_time_from`, `start_time_to`, `page_token`. Response: `runs[]` (the reference's example, trimmed) and
 * `next_page_token`.
 * https://docs.databricks.com/api/jobs/v2/list-runs.md
 */
export const LIST_RUNS: Fixture = {
  method: "GET",
  path: "/api/2.2/jobs/runs/list",
  cite: "https://docs.databricks.com/api/jobs/v2/list-runs.md",
  query: ["job_id", "active_only", "completed_only", "limit", "run_type", "expand_tasks", "start_time_from", "start_time_to", "page_token"],
}
export const LIST_RUNS_RESPONSE = {
  runs: [
    {
      job_id: 11223344,
      run_id: 455644833,
      creator_user_name: "user.name@databricks.com",
      state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" },
      run_name: "A multitask job run",
      run_type: "JOB_RUN",
      trigger: "PERIODIC",
      start_time: 1625060460483,
      end_time: 1625060863413,
    },
  ],
  next_page_token: "CAEomPSriYcxMPWM_IiIxvEB",
  has_more: true,
} as const
export const LIST_RUNS_LIMIT_MAX = 25

/**
 * `GET /api/2.2/jobs/runs/get-output`: "Retrieve the output and metadata of a single task run." Query: `run_id`
 * (required). Response: `output` (the run's output; the reference says at most the first 5 MB), `error`,
 * `error_trace`, `logs`, `logs_truncated`, `metadata`. The design's cut to 8 KiB is the plugin's, not the API's.
 * https://docs.databricks.com/api/jobs/v2/get-run-output.md
 */
export const GET_RUN_OUTPUT: Fixture = {
  method: "GET",
  path: "/api/2.2/jobs/runs/get-output",
  cite: "https://docs.databricks.com/api/jobs/v2/get-run-output.md",
  query: ["run_id"],
  queryRequired: ["run_id"],
}
export const GET_RUN_OUTPUT_RESPONSE = { output: "Cell 1: 2 rows", metadata: { task_key: "Orders_Ingest" }, logs_truncated: false } as const
