// /databricks-doctor (design §3.4, §14; review of #5 M2, M3 and the accepted enforcement decision): only the role's own grants, every
// list paged to its end with a NOT_CHECKED when a cap stops it, the workspace catalog's default schema, catalog-level
// EXECUTE over an external function, the exact role guarantee, and the command and certification.
import { describe, expect, it } from "vitest"
import { DatabricksError } from "../../../src/domain/errors.js"
import { registerDoctorCommand, formatDoctor } from "../../../src/auth/commands.js"
import { runDoctor } from "../../../src/auth/doctor.js"
import { ROLE_ENFORCEMENT_TEXT } from "../../../src/domain/contract.js"
import { readSignIn } from "../../../src/auth/credential.js"
import type { AccountInfo, AuthPort, DatabricksPort, Identity, Token } from "../../../src/ports.js"
import type { AuthContext, CommandInvocation } from "../../../src/auth/types.js"
import { fakeDatabricks } from "../../fake/ports.js"
import { loadOptions } from "../../../src/options.js"
import { DUMMY_TOKEN, FAKE_HOST, authCore, hostCredential } from "./support.js"

const NOW = 1_800_000_000_000
const signal = () => new AbortController().signal
const FINE = ["sql", "unity-catalog", "query-history", "openid", "offline_access"]
const ALL = ["all-apis", "offline_access"]

const account = (overrides: Partial<AccountInfo> = {}): AccountInfo => ({
  alias: "work",
  mode: "interactive",
  host: FAKE_HOST,
  cloud: "aws",
  features: [],
  role: { groupId: "123" },
  catalog: "main",
  warehouse: "wh",
  enforcement: "role-requested",
  ...overrides,
})

function fakeAuth(input: { readonly info?: AccountInfo; readonly token?: Token; readonly fail?: DatabricksError } = {}): AuthPort {
  const info = input.info ?? account()
  return {
    accounts: () => [info],
    account: () => info,
    token: async () => {
      if (input.fail) throw input.fail
      return input.token ?? { accessToken: DUMMY_TOKEN, expiresAt: NOW + 3_600_000, scopes: FINE, host: FAKE_HOST }
    },
  }
}

type Entries = readonly { readonly principal: string; readonly privileges: readonly string[] }[]

interface PortOptions {
  readonly catalogs?: readonly string[]
  readonly schemas?: readonly string[]
  readonly entries?: (securable: { readonly type: string; readonly fullName: string }) => Entries
  readonly functions?: readonly { readonly name: string; readonly routineBody: string }[]
  readonly connections?: readonly { readonly name: string }[]
  readonly connectionsUnavailable?: boolean
  readonly assignment?: string | undefined
  readonly groups?: readonly { readonly id: string; readonly displayName?: string }[]
}

function fakePort(options: PortOptions = {}): DatabricksPort {
  const entries =
    options.entries ??
    ((securable) => [{ principal: "readers", privileges: [securable.type === "function" ? "EXECUTE" : securable.type === "schema" ? "USE_SCHEMA" : "USE_CATALOG"] }])
  const schemas = options.schemas ?? ["default", "other"]
  return fakeDatabricks({
    me: () => ({ id: "1", userName: "ada@example.com", displayName: "Ada", ...(options.groups ? { groups: options.groups } : {}) }),
    listCatalogs: () => ({ items: (options.catalogs ?? ["main"]).map((name) => ({ name })) }),
    listSchemas: () => ({ items: schemas.map((name) => ({ name })) }),
    listFunctions: () => ({ items: options.functions ?? [] }),
    listWarehouses: () => [],
    listConnections: () => {
      if (options.connectionsUnavailable) throw new DatabricksError("NOT_IMPLEMENTED", "no connection read")
      return { items: options.connections ?? [] }
    },
    currentMetastoreAssignment: () => ({ ...(options.assignment !== undefined ? { defaultCatalogName: options.assignment } : {}) }),
    effectivePermissions: (_account: unknown, securable: unknown) => entries(securable as { type: string; fullName: string }),
  }).port
}

const options = (raw: Record<string, unknown> = { accounts: { work: { role: "123", catalog: "main", warehouse: "wh" } } }) => loadOptions(raw)

const byId = (checks: readonly { id: string }[], id: string) => checks.find((item) => item.id === id) as Record<string, unknown> | undefined

describe("M2: the role's own principals", () => {
  it("counts the role group's grants, not another principal's ALL_PRIVILEGES", async () => {
    const entries = (securable: { type: string; fullName: string }): Entries =>
      securable.type === "catalog"
        ? [
            { principal: "readers", privileges: ["USE_CATALOG", "CREATE_SCHEMA"] },
            { principal: "admins", privileges: ["ALL_PRIVILEGES"] },
          ]
        : [{ principal: "readers", privileges: ["USE_SCHEMA"] }]
    const [report] = await runDoctor({ options: options(), auth: fakeAuth(), databricks: fakePort({ entries, groups: [{ id: "123", displayName: "readers" }] }), signal: signal(), now: () => NOW, families: cleanFamilies() })
    const catalog = byId(report!.checks, "privileges:catalog:main") as { status: string; detail: string }
    expect(catalog.status).toBe("ROLE_CAN_WRITE")
    expect(catalog.detail).toContain("CREATE_SCHEMA")
    expect(catalog.detail).not.toContain("ALL_PRIVILEGES")
  }, 30_000)

  it("falls back to the union when SCIM does not name the role group, and says so", async () => {
    const entries = (securable: { type: string; fullName: string }): Entries =>
      securable.type === "catalog"
        ? [
            { principal: "readers", privileges: ["USE_CATALOG"] },
            { principal: "admins", privileges: ["ALL_PRIVILEGES"] },
          ]
        : [{ principal: "readers", privileges: ["USE_SCHEMA"] }]
    const [report] = await runDoctor({ options: options(), auth: fakeAuth(), databricks: fakePort({ entries }), signal: signal(), now: () => NOW, families: cleanFamilies() })
    const catalog = byId(report!.checks, "privileges:catalog:main") as { status: string; detail: string }
    expect(catalog.status).toBe("ROLE_CAN_WRITE")
    expect(catalog.detail).toContain("ALL_PRIVILEGES")
    expect(catalog.detail).toContain("every principal's grants were counted")
  }, 30_000)

  it("R2-M1: always counts account users and users, even when SCIM does not list them", async () => {
    const asked: string[] = []
    const port = fakeDatabricks({
      me: () => ({ id: "1", userName: "ada@example.com", groups: [{ id: "123", displayName: "readers" }] }),
      listCatalogs: () => ({ items: [{ name: "main" }] }),
      listSchemas: () => ({ items: [{ name: "default" }] }),
      listFunctions: () => ({ items: [] }),
      listWarehouses: () => [],
      listConnections: () => ({ items: [] }),
      currentMetastoreAssignment: () => ({ defaultCatalogName: "main" }),
      // A port that honours `principal`, as the contract's does: only the asked principal's entries come back.
      effectivePermissions: (_account: unknown, securable: unknown, _signal: unknown, principal: unknown) => {
        const name = typeof principal === "string" ? principal : "readers"
        asked.push(name)
        const scope = securable as { type: string; fullName: string }
        if (scope.type === "catalog") return [{ principal: "readers", privileges: ["USE_CATALOG"] }]
        if (scope.type === "schema") {
          if (name === "account users") return [{ principal: "account users", privileges: ["USE_SCHEMA", "CREATE_TABLE"] }]
          return name === "readers" ? [{ principal: "readers", privileges: ["USE_SCHEMA"] }] : []
        }
        return []
      },
    }).port
    const [report] = await runDoctor({ options: options(), auth: fakeAuth(), databricks: port, signal: signal(), now: () => NOW, families: cleanFamilies() })
    expect(asked).toEqual(expect.arrayContaining(["readers", "users", "account users"]))
    expect(byId(report!.checks, "privileges:default-schema:main.default")).toMatchObject({ status: "ROLE_CAN_WRITE" })
    expect(report!.enforcement).toBe("role-requested")
  }, 30_000)

  it("R2-M1: a write grant held only by users is counted too", async () => {
    const port = fakeDatabricks({
      me: () => ({ id: "1", userName: "ada@example.com", groups: [{ id: "123", displayName: "readers" }] }),
      listCatalogs: () => ({ items: [{ name: "main" }] }),
      listSchemas: () => ({ items: [{ name: "default" }] }),
      listFunctions: () => ({ items: [] }),
      listWarehouses: () => [],
      listConnections: () => ({ items: [] }),
      currentMetastoreAssignment: () => ({ defaultCatalogName: "main" }),
      effectivePermissions: (_account: unknown, securable: unknown, _signal: unknown, principal: unknown) => {
        const scope = securable as { type: string; fullName: string }
        if (scope.type === "catalog") return [{ principal: "readers", privileges: ["USE_CATALOG"] }]
        if (scope.type === "schema") {
          if (principal === "users") return [{ principal: "users", privileges: ["USE_SCHEMA", "CREATE_TABLE"] }]
          return principal === "readers" ? [{ principal: "readers", privileges: ["USE_SCHEMA"] }] : []
        }
        return []
      },
    }).port
    const [report] = await runDoctor({ options: options(), auth: fakeAuth(), databricks: port, signal: signal(), now: () => NOW, families: cleanFamilies() })
    expect(byId(report!.checks, "privileges:default-schema:main.default")).toMatchObject({ status: "ROLE_CAN_WRITE" })
  }, 30_000)

  it("reads the role's name and the inherited groups from SCIM Me when they are returned", async () => {
    const port = fakePort({ groups: [{ id: "123", displayName: "readers" }], entries: () => [] })
    const [report] = await runDoctor({ options: options(), auth: fakeAuth(), databricks: port, signal: signal(), now: () => NOW, families: cleanFamilies() })
    expect(report!.checks.filter((item) => item.id.startsWith("privileges:catalog:")).every((item) => item.status === "OK")).toBe(true)
    // The role's display name comes from SCIM Me, and is for display only.
    expect(report!.role).toEqual({ groupId: "123", name: "readers" })
  }, 30_000)
})

describe("M3: every check either runs completely or blocks the claim", () => {
  it("treats catalog-level EXECUTE over an external function as ROLE_CAN_WRITE", async () => {
    const entries = (securable: { type: string; fullName: string }): Entries =>
      securable.type === "catalog" ? [{ principal: "readers", privileges: ["USE_CATALOG", "EXECUTE"] }] : [{ principal: "readers", privileges: ["USE_SCHEMA"] }]
    const port = fakePort({ entries, functions: [{ name: "py_udf", routineBody: "EXTERNAL" }] })
    const [report] = await runDoctor({ options: options(), auth: fakeAuth(), databricks: port, signal: signal(), now: () => NOW, families: cleanFamilies() })
    const catalog = byId(report!.checks, "privileges:catalog:main") as { status: string; detail: string }
    expect(catalog.status).toBe("ROLE_CAN_WRITE")
    expect(catalog.detail).toContain("py_udf")
    expect(report!.enforcement).toBe("role-requested")
  }, 30_000)

  it("keeps catalog-level EXECUTE safe when every function beneath is SQL", async () => {
    const entries = (securable: { type: string; fullName: string }): Entries =>
      securable.type === "catalog" ? [{ principal: "readers", privileges: ["USE_CATALOG", "EXECUTE"] }] : [{ principal: "readers", privileges: ["USE_SCHEMA"] }]
    const port = fakePort({ entries, functions: [{ name: "safe_udf", routineBody: "SQL" }] })
    const [report] = await runDoctor({ options: options(), auth: fakeAuth(), databricks: port, signal: signal(), now: () => NOW, families: cleanFamilies() })
    expect(byId(report!.checks, "privileges:catalog:main")).toMatchObject({ status: "OK" })
  }, 30_000)

  it("treats schema-level EXECUTE over an external function as ROLE_CAN_WRITE", async () => {
    const entries = (securable: { type: string; fullName: string }): Entries => {
      if (securable.type === "schema") return [{ principal: "readers", privileges: ["USE_SCHEMA", "EXECUTE"] }]
      if (securable.type === "catalog") return [{ principal: "readers", privileges: ["USE_CATALOG"] }]
      return [{ principal: "readers", privileges: ["USE_SCHEMA"] }]
    }
    const port = fakePort({ entries, functions: [{ name: "py_udf", routineBody: "EXTERNAL" }] })
    const [report] = await runDoctor({ options: options(), auth: fakeAuth(), databricks: port, signal: signal(), now: () => NOW, families: cleanFamilies() })
    expect(byId(report!.checks, "privileges:default-schema:main.default")).toMatchObject({ status: "ROLE_CAN_WRITE" })
  }, 30_000)

  it("recognises ALL_PRIVILEGES at function level", async () => {
    const entries = (securable: { type: string; fullName: string }): Entries =>
      securable.type === "function" ? [{ principal: "readers", privileges: ["ALL_PRIVILEGES"] }] : [{ principal: "readers", privileges: [securable.type === "catalog" ? "USE_CATALOG" : "USE_SCHEMA"] }]
    const port = fakePort({ entries, functions: [{ name: "py_udf", routineBody: "EXTERNAL" }] })
    const [report] = await runDoctor({ options: options(), auth: fakeAuth(), databricks: port, signal: signal(), now: () => NOW, families: cleanFamilies() })
    expect(byId(report!.checks, "privileges:function:main.default.py_udf")).toMatchObject({ status: "ROLE_CAN_WRITE" })
  }, 30_000)

  it("blocks role when a catalog page cap stops the walk", async () => {
    let page = 0
    const port = fakeDatabricks({
      me: () => ({ id: "1", userName: "ada@example.com" }),
      // Every page is empty but carries a next token, so the walk ends at its cap with nothing checked.
      listCatalogs: () => {
        page += 1
        return { items: [], nextPageToken: page < 200 ? "more" : undefined }
      },
      listSchemas: () => ({ items: [] }),
      listFunctions: () => ({ items: [] }),
      listWarehouses: () => [],
      listConnections: () => ({ items: [] }),
      effectivePermissions: () => [],
    }).port
    const [report] = await runDoctor({ options: options(), auth: fakeAuth(), databricks: port, signal: signal(), now: () => NOW, families: cleanFamilies() })
    expect(report!.checks.some((item) => item.id === "privileges:catalogs:truncated" && item.status === "NOT_CHECKED")).toBe(true)
    expect(report!.enforcement).toBe("role-requested")
  }, 30_000)

  it("pages every catalog list to its end, so a second page is still checked", async () => {
    let page = 0
    const port = fakeDatabricks({
      me: () => ({ id: "1", userName: "ada@example.com" }),
      listCatalogs: () => {
        page += 1
        return page === 1 ? { items: [{ name: "main" }], nextPageToken: "p2" } : { items: [{ name: "samples" }] }
      },
      listSchemas: () => ({ items: [{ name: "default" }] }),
      listFunctions: () => ({ items: [] }),
      listWarehouses: () => [],
      listConnections: () => ({ items: [] }),
      effectivePermissions: () => [{ principal: "readers", privileges: ["USE_CATALOG"] }],
    }).port
    const [report] = await runDoctor({ options: options(), auth: fakeAuth(), databricks: port, signal: signal(), now: () => NOW, families: cleanFamilies() })
    expect(report!.checks.some((item) => item.id === "privileges:catalog:main")).toBe(true)
    expect(report!.checks.some((item) => item.id === "privileges:catalog:samples")).toBe(true)
  }, 30_000)

  it("uses UC's workspace catalog for the default schema, not the statement's catalog option", async () => {
    const entries = (securable: { type: string; fullName: string }): Entries =>
      securable.type === "schema" && securable.fullName === "main.default"
        ? [{ principal: "readers", privileges: ["USE_SCHEMA", "CREATE_TABLE"] }]
        : [{ principal: "readers", privileges: [securable.type === "catalog" ? "USE_CATALOG" : "USE_SCHEMA"] }]
    const port = fakePort({ assignment: "main", catalogs: ["main", "samples"], entries })
    const [report] = await runDoctor({ options: options(), auth: fakeAuth(), databricks: port, signal: signal(), now: () => NOW, families: cleanFamilies() })
    expect(byId(report!.checks, "privileges:default-schema:main.default")).toMatchObject({ status: "ROLE_CAN_WRITE" })
    expect(report!.checks.some((item) => item.id === "privileges:default-schema:samples.default")).toBe(false)
  }, 30_000)

  it("falls back to every catalog's default schema when UC does not name one", async () => {
    const entries = (securable: { type: string; fullName: string }): Entries =>
      securable.type === "schema" && securable.fullName === "samples.default"
        ? [{ principal: "readers", privileges: ["USE_SCHEMA", "CREATE_TABLE"] }]
        : [{ principal: "readers", privileges: [securable.type === "catalog" ? "USE_CATALOG" : "USE_SCHEMA"] }]
    const port = fakePort({ assignment: undefined, catalogs: ["main", "samples"], entries })
    const [report] = await runDoctor({ options: options(), auth: fakeAuth(), databricks: port, signal: signal(), now: () => NOW, families: cleanFamilies() })
    expect(byId(report!.checks, "privileges:default-schema:main.default")).toMatchObject({ status: "OK" })
    expect(byId(report!.checks, "privileges:default-schema:samples.default")).toMatchObject({ status: "ROLE_CAN_WRITE" })
  }, 30_000)

  it("says NOT_CHECKED when no default schema is visible, and does not certify", async () => {
    const port = fakePort({ schemas: ["other"] })
    const [report] = await runDoctor({ options: options(), auth: fakeAuth(), databricks: port, signal: signal(), now: () => NOW, families: cleanFamilies() })
    expect(byId(report!.checks, "privileges:default-schema")).toMatchObject({ status: "NOT_CHECKED" })
    expect(report!.enforcement).toBe("role-requested")
  }, 30_000)
})

describe("the accepted enforcement decision", () => {
  const clean = (): DatabricksPort => fakePort({ entries: () => [{ principal: "readers", privileges: ["USE_CATALOG"] }] })

  it("earns role under fine scopes over the UC and connection checks, with the exact guarantee", async () => {
    const [report] = await runDoctor({ options: options(), auth: fakeAuth({ token: { accessToken: DUMMY_TOKEN, expiresAt: NOW, scopes: FINE, host: FAKE_HOST } }), databricks: clean(), signal: signal(), now: () => NOW })
    expect(report!.enforcement).toBe("role")
    expect(report!.claim).toBe(ROLE_ENFORCEMENT_TEXT)
    expect(ROLE_ENFORCEMENT_TEXT).toBe("SQL writes refused on what doctor checked; secret scopes and serving endpoints not checked; job runs use each job's Run as identity")
    expect(byId(report!.checks, "role:jobs")).toMatchObject({ status: "OK" })
    expect(byId(report!.checks, "role:secret-scopes")).toMatchObject({ status: "NOT_CHECKED" })
    expect(byId(report!.checks, "role:serving")).toMatchObject({ status: "NOT_CHECKED" })
    expect(byId(report!.checks, "role:connections")).toMatchObject({ status: "OK" })
  }, 30_000)

  it("keeps jobs OK without the jobs scope and NOT_CHECKED with it, and still certifies under fine scopes", async () => {
    const withJobs = { accessToken: DUMMY_TOKEN, expiresAt: NOW, scopes: [...FINE, "jobs"], host: FAKE_HOST }
    const [report] = await runDoctor({ options: options({ accounts: { work: { role: "123", catalog: "main", features: ["jobs"] } } }), auth: fakeAuth({ token: withJobs }), databricks: clean(), signal: signal(), now: () => NOW })
    expect(byId(report!.checks, "role:jobs")).toMatchObject({ status: "NOT_CHECKED" })
    expect(report!.enforcement).toBe("role")
  }, 30_000)

  it("does not certify an all-apis sign-in, which reaches secret scopes and serving endpoints", async () => {
    const [report] = await runDoctor({ options: options(), auth: fakeAuth({ token: { accessToken: DUMMY_TOKEN, expiresAt: NOW, scopes: ALL, host: FAKE_HOST } }), databricks: clean(), signal: signal(), now: () => NOW })
    expect(report!.enforcement).toBe("role-requested")
    expect(report!.claim).toBeUndefined()
    expect(byId(report!.checks, "role:secret-scopes")).toMatchObject({ status: "NOT_CHECKED" })
  }, 30_000)

  it("treats USE_CONNECTION as a write vector", async () => {
    const entries = (securable: { type: string; fullName: string }): Entries =>
      securable.type === "connection" ? [{ principal: "readers", privileges: ["USE_CONNECTION"] }] : [{ principal: "readers", privileges: [securable.type === "catalog" ? "USE_CATALOG" : "USE_SCHEMA"] }]
    const [report] = await runDoctor({ options: options(), auth: fakeAuth({ token: { accessToken: DUMMY_TOKEN, expiresAt: NOW, scopes: FINE, host: FAKE_HOST } }), databricks: fakePort({ entries, connections: [{ name: "http-conn" }] }), signal: signal(), now: () => NOW })
    expect(byId(report!.checks, "role:connections")).toMatchObject({ status: "ROLE_CAN_WRITE" })
    expect(String((byId(report!.checks, "role:connections") as { detail: string }).detail)).toContain("http-conn")
    expect(report!.enforcement).toBe("role-requested")
  }, 30_000)

  it("says NOT_CHECKED, and does not certify, when the port cannot read connections", async () => {
    const [report] = await runDoctor({ options: options(), auth: fakeAuth({ token: { accessToken: DUMMY_TOKEN, expiresAt: NOW, scopes: FINE, host: FAKE_HOST } }), databricks: fakePort({ connectionsUnavailable: true }), signal: signal(), now: () => NOW })
    expect(byId(report!.checks, "role:connections")).toMatchObject({ status: "NOT_CHECKED" })
    expect(report!.enforcement).toBe("role-requested")
  }, 30_000)
})

describe("the rest of the report", () => {
  it("stops at a sign-in that cannot carry the scopes, and points at the fix", async () => {
    const failure = new DatabricksError("AUTH_SCOPE_MISSING", "The sign-in does not carry the jobs scope. Databricks was not called.", "Add jobs to the account's features, then sign in again.")
    const [report] = await runDoctor({ options: options(), auth: fakeAuth({ fail: failure }), databricks: fakePort(), signal: signal(), now: () => NOW })
    expect(byId(report!.checks, "sign-in")).toMatchObject({ status: "AUTH_SCOPE_MISSING" })
    expect(byId(report!.checks, "identity")).toMatchObject({ status: "NOT_CHECKED" })
    expect(report!.nextStep).toBe(failure.nextStep)
  }, 30_000)

  it("reports the person's own grants without a role, and a service principal for m2m", async () => {
    const [identity] = await runDoctor({ options: options({ accounts: { work: { catalog: "main" } } }), auth: fakeAuth({ info: account({ role: undefined }) }), databricks: fakePort(), signal: signal(), now: () => NOW })
    expect(identity!.enforcement).toBe("identity")
    expect(byId(identity!.checks, "privileges:catalog:main")).toMatchObject({ status: "OK" })
    expect(String((byId(identity!.checks, "privileges:catalog:main") as { detail: string }).detail)).toContain("identity")

    const [service] = await runDoctor({ options: options({ accounts: { ci: { mode: "m2m", host: FAKE_HOST, clientId: "7f3e2a10-5c4b-4d8e-9a1f-2b6c8d0e4f12", clientSecretEnv: "DBX_CLIENT_SECRET" } } }), auth: fakeAuth({ info: account({ alias: "ci", mode: "m2m", role: undefined }) }), databricks: fakePort(), signal: signal(), now: () => NOW })
    expect(service!.enforcement).toBe("service-principal")
  }, 30_000)

  it("reports the warehouse cost warnings", async () => {
    const port = fakeDatabricks({
      me: () => ({ id: "1", userName: "ada@example.com" }),
      listCatalogs: () => ({ items: [] }),
      listSchemas: () => ({ items: [] }),
      listFunctions: () => ({ items: [] }),
      listConnections: () => ({ items: [] }),
      listWarehouses: () => [
        { id: "wh-1", name: "always", state: "STOPPED", warehouseType: "PRO", serverless: true, clusterSize: "Small", autoStopMins: 0, minNumClusters: 1, maxNumClusters: 1 },
        { id: "wh-2", name: "slow", state: "RUNNING", warehouseType: "PRO", serverless: true, clusterSize: "Small", autoStopMins: 45, minNumClusters: 1, maxNumClusters: 1, statementTimeoutSeconds: 600 },
      ],
      effectivePermissions: () => [],
    }).port
    const [report] = await runDoctor({ options: options(), auth: fakeAuth(), databricks: port, signal: signal(), now: () => NOW, families: cleanFamilies() })
    expect(report!.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(["AUTO_STOP_OFF", "AUTO_STOP_LONG"]))
    expect(byId(report!.checks, "warehouses")).toMatchObject({ status: "OK" })
  }, 30_000)

  it("lists no catalog as OK rather than a failure", async () => {
    const port = fakePort({ catalogs: [], schemas: [] })
    const [report] = await runDoctor({ options: options(), auth: fakeAuth(), databricks: port, signal: signal(), now: () => NOW, families: cleanFamilies() })
    expect(byId(report!.checks, "privileges:catalogs")).toMatchObject({ status: "OK" })
  }, 30_000)
})

describe("R2-L1: a certification is bound to the credential the report checked", () => {
  const clean = (): DatabricksPort => fakePort({ entries: () => [{ principal: "readers", privileges: ["USE_CATALOG"] }], groups: [{ id: "123", displayName: "readers" }] })

  it("does not certify a sign-in that landed while the doctor ran", async () => {
    const credential = hostCredential({ roleGroupId: "123", grantedScopes: [...FINE] })
    const { core } = authCore({ accounts: { work: { role: "123", warehouse: "wh" } } }, { credential, now: () => NOW })
    await core.load()
    await core.token("work", ["sql"], signal())
    const [report] = await runDoctor({ options: options({ accounts: { work: { role: "123", warehouse: "wh" } } }), auth: core.port, databricks: clean(), signal: signal(), now: () => NOW })
    expect(report!.enforcement).toBe("role")
    expect(report!.binding).toEqual({ host: FAKE_HOST, roleGroupId: "123", grantedScopes: FINE })
    // The person's browser completes a new sign-in before the command stores the report.
    await core.remember("work", hostCredential({ roleGroupId: "123", grantedScopes: [...FINE, "jobs"] }), "sign-in")
    core.certify(report!)
    expect(core.account("work").enforcement).toBe("role-requested")
  }, 30_000)

  it("never says role when the account has no role, even after a report", async () => {
    const credential = hostCredential({ roleGroupId: "123", grantedScopes: [...FINE] })
    const { core } = authCore({ accounts: { work: { role: "123", warehouse: "wh" } } }, { credential, now: () => NOW })
    await core.load()
    await core.token("work", ["sql"], signal())
    const [report] = await runDoctor({ options: options({ accounts: { work: { role: "123", warehouse: "wh" } } }), auth: core.port, databricks: clean(), signal: signal(), now: () => NOW })
    expect(report!.enforcement).toBe("role")
    await core.remember("work", hostCredential({ grantedScopes: [...FINE] }), "sign-in")
    core.certify(report!)
    expect(core.account("work").role).toBeUndefined()
    expect(core.account("work").enforcement).not.toBe("role")
  }, 30_000)

  it("certifies the credential the report ran against, as a positive control", async () => {
    const credential = hostCredential({ roleGroupId: "123", grantedScopes: [...FINE] })
    const { core } = authCore({ accounts: { work: { role: "123", warehouse: "wh" } } }, { credential, now: () => NOW })
    await core.load()
    await core.token("work", ["sql"], signal())
    const [report] = await runDoctor({ options: options({ accounts: { work: { role: "123", warehouse: "wh" } } }), auth: core.port, databricks: clean(), signal: signal(), now: () => NOW })
    core.certify(report!)
    expect(core.account("work").enforcement).toBe("role")
  }, 30_000)
})

describe("the command and the certification", () => {
  it("posts one synthetic message with the whole report and the guarantee, no token and resume false", async () => {
    const definitions: { name: string; execute: (input: CommandInvocation) => Promise<void> }[] = []
    const messages: { text: string; description: string; resume: boolean }[] = []
    const reports: unknown[] = []
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
    const registration = await registerDoctorCommand(ctx, {
      options: options(),
      auth: fakeAuth({ token: { accessToken: DUMMY_TOKEN, expiresAt: NOW, scopes: FINE, host: FAKE_HOST } }),
      databricks: () => fakePort({ entries: () => [{ principal: "readers", privileges: ["USE_CATALOG"] }] }),
      onReport: (report) => reports.push(report),
    })
    await definitions[0]!.execute({ sessionID: "ses_1", delivery: "steer" })
    expect(messages).toHaveLength(1)
    expect(messages[0]!.resume).toBe(false)
    expect(messages[0]!.text).toContain("Databricks doctor")
    expect(messages[0]!.text).toContain(`Guarantee: ${ROLE_ENFORCEMENT_TEXT}`)
    expect(messages[0]!.text).not.toContain(DUMMY_TOKEN)
    expect(reports).toHaveLength(1)
    await registration.dispose()
  }, 30_000)

  it("raises account().enforcement to role after a clean report, and clears it when the credential changes", async () => {
    const credential = hostCredential({ roleGroupId: "123", grantedScopes: ["sql", "unity-catalog", "query-history", "offline_access"] })
    const { core } = authCore({ accounts: { work: { role: "123", warehouse: "wh" } } }, { credential, now: () => NOW })
    await core.load()
    await core.token("work", ["sql"], signal())
    expect(core.account("work").enforcement).toBe("role-requested")
    const [report] = await runDoctor({
      options: options({ accounts: { work: { role: "123", warehouse: "wh" } } }),
      auth: core.port,
      databricks: fakePort({ entries: () => [{ principal: "readers", privileges: ["USE_CATALOG"] }], groups: [{ id: "123", displayName: "readers" }] }),
      signal: signal(),
      now: () => NOW,
    })
    expect(report!.enforcement).toBe("role")
    core.certify(report!)
    expect(core.account("work").enforcement).toBe("role")
    expect(core.account("work").role?.name).toBe("readers")
    // A new sign-in with another grant is a different credential: the certification no longer applies.
    const changed = hostCredential({ roleGroupId: "123", grantedScopes: ["sql", "unity-catalog", "query-history", "jobs", "offline_access"] })
    await core.remember("work", changed, "sign-in")
    expect(core.account("work").enforcement).toBe("role-requested")
    expect(readSignIn(changed.metadata)?.grantedScopes).toContain("jobs")
  }, 30_000)

  it("formats a report deterministically", async () => {
    const [report] = await runDoctor({ options: options(), auth: fakeAuth(), databricks: fakePort(), signal: signal(), now: () => NOW, families: cleanFamilies() })
    const text = formatDoctor([report!])
    expect(text.split("\n")[0]).toBe("Databricks doctor")
    expect(text).toContain(`work (interactive, ${FAKE_HOST}, aws): enforcement`)
    expect(text).toContain("- sign-in: OK")
    expect(text).not.toContain(DUMMY_TOKEN)
  }, 30_000)
})

/** Four clean injected families: the certification path, without the built-in connection/job/secret/serving checks. */
function cleanFamilies(): readonly { id: string; label: string; run: () => Promise<{ id: string; status: "OK"; detail: string }> }[] {
  return ["connections", "jobs", "secret-scopes", "serving"].map((id) => ({ id: `role:${id}`, label: id, run: async () => ({ id: `role:${id}`, status: "OK" as const, detail: "checked" }) }))
}
