/** `saved_list`: the `databricks.saved` snapshot's bind-time suggestion (contract §7 `scope.suggest`). */
import { savedList } from "./sources/saved.js"
import type { Handler } from "./types.js"

const handler: Handler<"saved_list"> = async (input, call, deps) => {
  const account = input.account ?? Object.keys(deps.options.accounts ?? {})[0] ?? "default"
  return savedList(deps, { account }, call)
}

export default handler
