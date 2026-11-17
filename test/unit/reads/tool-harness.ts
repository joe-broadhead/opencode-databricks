// What the read tools' tests share beyond `harness.ts`: a query-shaped harness (a running warehouse and `main.s.t`) and
// the first row of a result.
import { harness, submitFor, tableOf } from "./harness.js"

/** A harness whose warehouse is running, whose `main.s.t` resolves, and whose answers are the test's. */
export function queryHarness(input: { options?: Record<string, unknown>; submit?: () => unknown } = {}) {
  const options = input.options ? { accounts: { work: { warehouse: "wh-small" } }, ...input.options } : undefined
  return harness({
    ...(options ? { options } : {}),
    answers: {
      getTable: () => Promise.resolve(tableOf({ fullName: "main.s.t" })),
      submit: submitFor(input.submit ? () => input.submit!() : undefined),
    } as never,
  })
}

/** The first row of a result, as an array. */
export function cells(result: Record<string, unknown>): unknown[] {
  const rows = result.rows as unknown[][] | undefined
  return rows?.[0] ?? []
}

export { asserted, harness, readRequests, requestsSent, statementsSent, submitFor, tableOf, runningWarehouse } from "./harness.js"
