import { describe, expect, it } from "vitest"
import { queryString } from "../../src/provider/http.js"

describe("the query-string serialiser", () => {
  it("sends a camelCase page cursor as the API's snake_case field", () => {
    expect(queryString({ job_id: 7, pageToken: "abc", max_results: 100 })).toBe("?job_id=7&page_token=abc&max_results=100")
  })

  it("passes existing snake_case keys through unchanged", () => {
    expect(queryString({ catalog_name: "main", schema_name: "default", entity_type: "TABLE" })).toBe("?catalog_name=main&schema_name=default&entity_type=TABLE")
  })

  it("repeats an array key and drops undefined and null", () => {
    expect(queryString({ ids: ["a", "b"], missing: undefined, empty: null })).toBe("?ids=a&ids=b")
  })
})
