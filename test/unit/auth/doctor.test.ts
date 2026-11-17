// /databricks-doctor (design §3.4, §14): ROLE_CAN_WRITE names the grant, a clean report earns enforcement role, and the
// families the port cannot read stay NOT_CHECKED rather than being assumed clean. The command posts a synthetic message
// with no token in it.
import { describe, expect, it } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import { registerDoctorCommand, formatDoctor } from "../../../src/auth/commands.js"
import { runDoctor } from "../../../src/auth/doctor.js"
import type { AccountInfo, AuthPort, DatabricksPort, Token } from "../../../src/ports.js"
import type { AuthContext, CommandInvocation } from "../../../src/auth/types.js"
import { fakeDatabricks } from "../../fake/ports.js"
import { loadOptions } from "../../../src/options.js"
import { DUMMY_TOKEN, FAKE_HOST } from "./support.js"

const NOW = 1_800_000_000_000
const signal = () => new AbortController().signal

const account = (overrides: Partial<AccountInfo> = {}): AccountInfo => ({
  alias: "work",
  mode: "interactive",
  host: FAKE_HOST,
  cloud: "aws",
  features: [],
  role: { groupId: "123" },
  catalog: "main",
  warehouse: "wh",
  ...overrides,
})

function fakeAuth(input: { readonly info?: AccountInfo; readonly token?: Token; readonly fail?: DatabricksError } = {}): AuthPort {
  const info = input.info ?? account()
  return {
    accounts: () => [info],
    account: () => info,
    token: async () => {
      if (input.fail) throw input.fail
      return input.token ?? { accessToken: DUMMY_TOKEN, expiresAt: NOW + 3_600_000, scopes: ["sql", "unity-catalog", "query-history", "offline_access"] }
    },
  }
}

function fakePort(input: { readonly catalogs?: readonly string[]; readonly privileges?: (securable: { type: string; fullName: string }) => readonly string[] } = {}): DatabricksPort {
  const catalogs = input.catalogs ?? ["main", "samples"]
  const privileges =
    input.privileges ??
    ((securable) => {
      if (securable.type === "catalog" && securable.fullName === "main") return ["USE_CATALOG", "CREATE_SCHEMA"]
      if (securable.type === "catalog") return ["USE_CATALOG"]
      if (securable.type === "schema") return ["USE_SCHEMA", "CREATE_TABLE"]
      if (securable.type === "function") return ["EXECUTE"]
      return []
    })
  return fakeDatabricks({
    me: () => ({ id: "1", userName: "ada@example.com", displayName: "Ada" }),
    listCatalogs: () => ({ items: catalogs.map((name) => ({ name })) }),
    effectivePermissions: (_account, securable) => privileges(securable as { type: string; fullName: string }).map((privilege) => ({ principal: "role", privileges: [privilege] })),
    listFunctions: () => ({ items: [{ name: "py_udf", routineBody: "EXTERNAL" }, { name: "safe", routineBody: "SQL" }] }),
    listWarehouses: () => [
      { id: "wh-1", name: "always", state: "STOPPED", warehouseType: "PRO", serverless: true, clusterSize: "Small", autoStopMins: 0, minNumClusters: 1, maxNumClusters: 1 },
      { id: "wh-2", name: "slow", state: "RUNNING", warehouseType: "PRO", serverless: true, clusterSize: "Small", autoStopMins: 45, minNumClusters: 1, maxNumClusters: 1, statementTimeoutSeconds: 600 },
    ],
  }).port
}

const options = (raw: Record<string, unknown> = { accounts: { work: { role: "123", catalog: "main", warehouse: "wh" } } }) => loadOptions(raw)

describe("the doctor's checks", () => {
  it("names every grant beyond reading as ROLE_CAN_WRITE, with the grant in the next step", async () => {
    const [report] = await runDoctor({ options: options(), auth: fakeAuth(), databricks: fakePort(), signal: signal(), now: () => NOW })
    expect(report!.enforcement).toBe("role-requested")
    const byId = new Map(report!.checks.map((item) => [item.id, item]))
    expect(byId.get("sign-in")?.status).toBe("OK")
    expect(byId.get("identity")?.detail).toContain("Ada")
    expect(byId.get("privileges:catalog:main")).toMatchObject({ status: "ROLE_CAN_WRITE" })
    expect(byId.get("privileges:catalog:main")?.detail).toContain("CREATE_SCHEMA")
    expect(byId.get("privileges:catalog:main")?.next).toContain("revoke CREATE_SCHEMA")
    expect(byId.get("privileges:catalog:samples")?.status).toBe("OK")
    expect(byId.get("privileges:default-schema")).toMatchObject({ status: "ROLE_CAN_WRITE" })
    expect(byId.get("privileges:default-schema")?.detail).toContain("CREATE_TABLE")
    expect(byId.get("privileges:function:main.default.py_udf")).toMatchObject({ status: "ROLE_CAN_WRITE" })
    expect(byId.get("privileges:function:main.default.py_udf")?.detail).toContain("external function")
    expect(byId.get("warehouses")?.status).toBe("OK")
    expect(report!.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(["AUTO_STOP_OFF", "AUTO_STOP_LONG", "ROLE_CAN_WRITE"]))
    expect(byId.get("role:connections")?.status).toBe("NOT_CHECKED")
    expect(byId.get("role:secret-scopes")?.status).toBe("NOT_CHECKED")
    expect(byId.get("role:serving")?.status).toBe("NOT_CHECKED")
    expect(byId.get("role:jobs")?.status).toBe("NOT_CHECKED")
    expect(JSON.stringify(report)).not.toContain(DUMMY_TOKEN)
    expect(report!.nextStep).toContain("CREATE_SCHEMA")
  })

  it("earns enforcement role only when every check ran and passed, including the injected role families", async () => {
    const clean = fakePort({ privileges: () => ["USE_CATALOG"] })
    const families = ["connections", "secret-scopes", "serving", "jobs"].map((id) => ({
      id: `role:${id}`,
      label: id,
      run: async () => ({ id: `role:${id}`, status: "OK" as const, detail: "checked" }),
    }))
    const [report] = await runDoctor({ options: options(), auth: fakeAuth(), databricks: clean, signal: signal(), now: () => NOW, families })
    expect(report!.enforcement).toBe("role")
    expect(report!.checks.every((item) => item.status === "OK")).toBe(true)
  })

  it("does not certify a role when one check did not run", async () => {
    const families = ["connections", "secret-scopes", "serving", "jobs"].map((id, index) => ({
      id: `role:${id}`,
      label: id,
      run: async () => (index === 3 ? { id: `role:${id}`, status: "NOT_CHECKED" as const, detail: "not run" } : { id: `role:${id}`, status: "OK" as const, detail: "checked" }),
    }))
    const [report] = await runDoctor({ options: options(), auth: fakeAuth(), databricks: fakePort({ privileges: () => ["USE_CATALOG"] }), signal: signal(), now: () => NOW, families })
    expect(report!.enforcement).toBe("role-requested")
    expect(report!.checks.find((item) => item.id === "role:jobs")?.status).toBe("NOT_CHECKED")
  })

  it("reports the person's own grants without a role, and a service principal for m2m, role or not", async () => {
    const [identity] = await runDoctor({ options: options({ accounts: { work: { catalog: "main", warehouse: "wh" } } }), auth: fakeAuth({ info: account({ role: undefined }) }), databricks: fakePort(), signal: signal(), now: () => NOW })
    expect(identity!.enforcement).toBe("identity")
    expect(identity!.checks.find((item) => item.id === "privileges:catalog:main")?.detail).toContain("no role is bound")
    expect(identity!.warnings.some((warning) => warning.code === "ROLE_CAN_WRITE")).toBe(false)

    for (const role of [undefined, { groupId: "1234567890123456" }]) {
      const [service] = await runDoctor({
        options: options({ accounts: { ci: { mode: "m2m", host: FAKE_HOST, clientId: "7f3e2a10-5c4b-4d8e-9a1f-2b6c8d0e4f12", clientSecretEnv: "DBX_CLIENT_SECRET", ...(role ? { role: role.groupId } : {}) } } }),
        auth: fakeAuth({ info: account({ alias: "ci", mode: "m2m", role, catalog: undefined }) }),
        databricks: fakePort(),
        signal: signal(),
        now: () => NOW,
      })
      expect(service!.enforcement).toBe("service-principal")
    }
  })

  it("stops at a sign-in that cannot carry the scopes, and points at the fix", async () => {
    const failure = new DatabricksError("AUTH_SCOPE_MISSING", "The sign-in does not carry the jobs scope. Databricks was not called.", "Add jobs to the account's features, then sign in again.")
    const [report] = await runDoctor({ options: options(), auth: fakeAuth({ fail: failure }), databricks: fakePort(), signal: signal(), now: () => NOW })
    expect(report!.checks.find((item) => item.id === "sign-in")).toMatchObject({ status: "AUTH_SCOPE_MISSING" })
    expect(report!.checks.find((item) => item.id === "identity")?.status).toBe("NOT_CHECKED")
    expect(report!.nextStep).toBe(failure.nextStep)
  })

  it("says plainly what it did not check: an unset catalog option, and a role family with no port call", async () => {
    const [report] = await runDoctor({ options: options({ accounts: { work: { role: "123", warehouse: "wh" } } }), auth: fakeAuth(), databricks: fakePort(), signal: signal(), now: () => NOW })
    expect(report!.checks.find((item) => item.id === "privileges:default-schema")?.status).toBe("NOT_CHECKED")
    expect(report!.checks.find((item) => item.id === "privileges:default-schema")?.detail).toContain("catalog is not set")
    expect(report!.checks.find((item) => item.id === "role:connections")?.detail).toContain("port")
  })

  it("reports no catalog as OK rather than as a failure", async () => {
    const [report] = await runDoctor({ options: options(), auth: fakeAuth(), databricks: fakePort({ catalogs: [] }), signal: signal(), now: () => NOW })
    expect(report!.checks.find((item) => item.id === "privileges:catalogs")).toMatchObject({ status: "OK" })
  })
})

describe("the command", () => {
  it("posts one synthetic message with the whole report, no token and resume false", async () => {
    const definitions: { name: string; execute: (input: CommandInvocation) => Promise<void> }[] = []
    const messages: { text: string; description: string; resume: boolean }[] = []
    const ctx = {
      command: {
        transform: async (callback: (editor: { add: (definition: { name: string; execute: (input: CommandInvocation) => Promise<void> }) => void }) => void) => {
          callback({ add: (definition) => definitions.push(definition) })
          return { dispose: async () => undefined }
        },
      },
      session: {
        synthetic: async (message: { text: string; description: string; resume: boolean }) => {
          messages.push(message)
        },
      },
    } as unknown as Pick<AuthContext, "command" | "session">
    const registration = await registerDoctorCommand(ctx, { options: options(), auth: fakeAuth(), databricks: () => fakePort() })
    expect(definitions.map((definition) => definition.name)).toEqual(["databricks-doctor"])
    await definitions[0]!.execute({ sessionID: "ses_1", delivery: "steer" })
    expect(messages).toHaveLength(1)
    expect(messages[0]!.resume).toBe(false)
    expect(messages[0]!.text).toContain("Databricks doctor")
    expect(messages[0]!.text).toContain("work (interactive")
    expect(messages[0]!.text).toContain("ROLE_CAN_WRITE")
    expect(messages[0]!.text).toContain("Next step:")
    expect(messages[0]!.text).not.toContain(DUMMY_TOKEN)
    expect(messages[0]!.description).toContain("Databricks doctor")
    await registration.dispose()
  })

  it("formats a report deterministically", async () => {
    const [report] = await runDoctor({ options: options(), auth: fakeAuth(), databricks: fakePort(), signal: signal(), now: () => NOW })
    const text = formatDoctor([report!])
    expect(text.split("\n")[0]).toBe("Databricks doctor")
    expect(text).toContain(`work (interactive, ${FAKE_HOST}, aws): enforcement role-requested`)
    expect(text).toContain("- sign-in: OK")
    expect(text).not.toContain(DUMMY_TOKEN)
  })
})
