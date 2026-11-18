// The fake Databricks server's interface (design §15.2). Package B implements it in test/fake/databricks-server.ts as
// a loopback HTTP server that replays the sanitised fixtures of test/fixtures/databricks/, so the host suites run the
// built plugin against it; every other package uses it through this interface only.
import type { ChunkAnswer, ExternalLink, FunctionInfo, HistoryQuery, RunInfo, StatementAnswer, TableInfo, Warehouse } from "../../src/ports.js"

/** One request the fake received, with the Authorization header reduced to whether it was there. */
export interface FakeRequest {
  readonly method: string
  readonly path: string
  readonly query: Readonly<Record<string, string>>
  readonly body?: unknown
  readonly authorized: boolean
  /** The statement text, for POST /api/2.0/sql/statements. */
  readonly statement?: string
}

/** Behaviours a test turns on (design §15.2). */
export interface FakeBehaviour {
  /** Added to every answer. */
  readonly latencyMs?: number
  /** Answer 429 with this Retry-After for the next N requests. */
  readonly rateLimit?: { readonly count: number; readonly retryAfterSec: number }
  /** Fail the chunk with this index once, mid-stream. */
  readonly failChunk?: number
  /** External links that expire after this many milliseconds. */
  readonly linkTtlMs?: number
  /** A stopped warehouse that a statement submit starts, as Databricks does (to prove the TOCTOU accounting). */
  readonly autoStartOnSubmit?: boolean
  /** Close the connection after a submit is received, so the answer never arrives (an ambiguous submit). */
  readonly dropSubmitAnswer?: boolean
}

export interface FakeState {
  readonly identity: { readonly id: string; readonly userName: string; readonly displayName?: string }
  readonly warehouses: Map<string, Warehouse>
  readonly tables: Map<string, TableInfo>
  readonly functions: Map<string, FunctionInfo>
  readonly history: HistoryQuery[]
  readonly runs: RunInfo[]
  /** The answer for a statement text, or a function of it; unknown text answers SUCCEEDED with no rows. */
  readonly statements: Map<string, StatementAnswer | ((statement: string) => StatementAnswer)>
  readonly links: Map<string, { readonly link: ExternalLink; readonly bytes: Uint8Array }>
  /**
   * Result chunks past the first, by `<statementId>:<chunkIndex>`. The fake's chunk route answers them in the
   * documented top-level shape (`chunk_index`, `row_count`, `next_chunk_index`, `data_array`, `external_links`), never
   * a whole statement response (review of #3, H1).
   */
  readonly chunks: Map<string, ChunkAnswer>
  // The maps below are always initialised; `startFake`'s `Partial<FakeState>` seeds them, and the fake keeps its
  // derived defaults when one is empty (review of #3, request 1).
  readonly queries: Map<string, { readonly id: string; readonly name: string; readonly owner?: string; readonly warehouseId?: string; readonly queryText: string }>
  /** Key `<catalog>.<schema>`. */
  readonly volumes: Map<string, readonly { readonly name: string; readonly volumeType: string }[]>
  /** Workspace objects by directory path. */
  readonly workspace: Map<string, readonly { readonly path: string; readonly objectType: string; readonly size?: number; readonly modifiedAt?: number }[]>
  /** Notebook source by path. */
  readonly notebooks: Map<string, string>
  /** Files API listings by directory path. */
  readonly directories: Map<string, readonly { readonly path: string; readonly isDirectory: boolean; readonly size?: number; readonly modifiedAt?: number }[]>
  /** Registered models by `<catalog>.<schema>` (`GET /api/2.1/unity-catalog/models`). */
  readonly models: Map<string, readonly { readonly name: string; readonly fullName?: string }[]>
  readonly jobs: Map<number, { readonly name: string; readonly creatorUserName?: string }>
}

export interface FakeDatabricks {
  /** `http://127.0.0.1:<port>`: the workspace host the plugin is pointed at in tests. */
  readonly origin: string
  /** The OAuth endpoints under the same origin: `/oidc/v1/authorize` and `/oidc/v1/token`. */
  readonly tokenEndpoint: string
  readonly requests: readonly FakeRequest[]
  /** Statement ids the plugin cancelled (`POST /api/2.0/sql/statements/{id}/cancel`). */
  readonly cancelled: readonly string[]
  readonly state: FakeState
  behave(behaviour: FakeBehaviour): void
  close(): Promise<void>
}

export type StartFake = (seed?: Partial<FakeState>) => Promise<FakeDatabricks>
