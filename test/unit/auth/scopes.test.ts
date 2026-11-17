// The scope sets (design §3.3) and the pre-call check that turns a missing family into AUTH_SCOPE_MISSING.
import { describe, expect, it } from "vitest"
import { BASE_SCOPES, featureOfScope, missingScopes, requestedScopes, widerThanFeatures } from "../../../src/auth/scopes.js"

describe("the scopes a sign-in requests", () => {
  it("requests the base families and identity claims with fine-grained scopes", () => {
    expect(requestedScopes([], "fine")).toEqual([...BASE_SCOPES])
    expect(requestedScopes([], "fine")).toEqual(["sql", "unity-catalog", "query-history", "openid", "email", "profile", "offline_access"])
  })

  it("adds one scope per feature, in the sheet's order, without duplicates", () => {
    expect(requestedScopes(["files", "jobs", "jobs"], "fine").slice(-2)).toEqual(["jobs", "files"])
  })

  it("requests all-apis with offline_access for an app made with All APIs", () => {
    expect(requestedScopes(["jobs"], "all-apis")).toEqual(["all-apis", "offline_access"])
  })
})

describe("the check before a call", () => {
  it("is satisfied by the exact scope, by any for SCIM Me, and by all-apis", () => {
    expect(missingScopes(["sql", "unity-catalog"], ["sql"])).toEqual([])
    expect(missingScopes([], ["any"])).toEqual([])
    expect(missingScopes(["all-apis"], ["sql", "jobs"])).toEqual([])
  })

  it("names every scope the sign-in does not carry", () => {
    expect(missingScopes(["sql"], ["sql", "jobs", "unity-catalog"])).toEqual(["jobs", "unity-catalog"])
    expect(missingScopes([], ["jobs"])).toEqual(["jobs"])
  })

  it("recognises a feature's scope and a sign-in wider than the features", () => {
    expect(featureOfScope("jobs")).toBe("jobs")
    expect(featureOfScope("sql")).toBeUndefined()
    expect(widerThanFeatures(["all-apis"], [])).toBe(true)
    expect(widerThanFeatures(["all-apis"], ["jobs"])).toBe(false)
    expect(widerThanFeatures(["sql", "jobs"], [])).toBe(true)
    expect(widerThanFeatures(["sql", "jobs"], ["jobs"])).toBe(false)
  })
})
