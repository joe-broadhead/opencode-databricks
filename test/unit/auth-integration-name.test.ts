import { describe, expect, it } from "vitest"
import { integrationIdFor } from "../../src/auth/form.js"

describe("the integration name of an alias", () => {
  it("uses bare databricks for default and databricks-<alias> otherwise", () => {
    expect(integrationIdFor("default")).toBe("databricks")
    expect(integrationIdFor("work")).toBe("databricks-work")
    expect(integrationIdFor("personal")).toBe("databricks-personal")
  })
})
