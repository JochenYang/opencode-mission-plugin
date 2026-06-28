// Unit tests for the MissionStorage abstraction. Run with: bun test
//
// Covers MetadataMissionStorage using the hybrid transport:
//   - READS via V2 SDK session.get() (clean response, no v[0] wrap).
//   - WRITES via raw fetch against /session/{id} (the V2 SDK has an
//     empty-body bug on session.update; raw fetch uses the V1 client's
//     fetch to route through the opencode-trusted transport).

import { describe, expect, test } from "bun:test"
import {
  MetadataMissionStorage,
  createMissionStorage,
} from "../src/mission-storage.js"
import type { Mission } from "../src/types.js"

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "mission_test_1",
    objective: "Test objective",
    completionCriterion: "Test criterion",
    status: "active",
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    createdBy: "model",
    updatedBy: "model",
    continuationCount: 0,
    budget: {
      turnLimit: 10,
      tokenLimit: 1000,
      wallClockLimitMs: 60_000,
      turnsUsed: 0,
      tokensUsed: 0,
      wallClockMs: 0,
      wallClockStartedAt: 1_000_000,
      totalPausedMs: 0,
    },
    consecutiveBlockAttempts: 0,
    judgeReactAttempts: 0,
    ...overrides,
  }
}

interface MockSessionOptions {
  /** The metadata object returned by get() (session.metadata). */
  metadata?: Record<string, unknown> | null
  /** If true, get() throws. */
  getThrows?: boolean
  /** Capture every fetchImpl PATCH call here. */
  capture?: FetchCall[]
  /** If set, PATCH response will return this status (default 200). */
  patchStatus?: number
  /** If true, PATCH throws. */
  patchThrows?: boolean
}

interface FetchCall {
  url: string
  method: string
  body: string
  headers: Record<string, string>
}

/**
 * Simulates the V2 SDK session.get + a raw fetch PATCH.
 * The V2 SDK's session.get() returns { data: { id, metadata } } on success.
 * The V1 client's fetch is mocked to capture PATCH calls and return a
 * configured response.
 */
function makeMockTransport(opts: MockSessionOptions = {}): {
  session: { get: (p: { sessionID: string }) => Promise<any> }
  fetchImpl: (url: string, init?: any) => Promise<any>
  patches: FetchCall[]
} {
  const patches = opts.capture ?? []
  return {
    session: {
      async get({ sessionID: _sid }: { sessionID: string }) {
        if (opts.getThrows) throw new Error("get failed")
        if (opts.metadata === null || opts.metadata === undefined) {
          return { data: null }
        }
        return { data: { id: _sid, metadata: opts.metadata } }
      },
    },
    async fetchImpl(url: string, init?: any) {
      if (opts.patchThrows) throw new Error("patch failed")
      patches.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ?? "",
        headers: init?.headers ?? {},
      })
      const status = opts.patchStatus ?? 200
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? "OK" : "Error",
        async text() {
          return status === 200
            ? JSON.stringify({ id: "ses_x", metadata: opts.metadata })
            : "patch failed"
        },
      }
    },
    patches,
  }
}

function buildStorage(opts: MockSessionOptions = {}) {
  const { session, fetchImpl, patches } = makeMockTransport(opts)
  const s = new MetadataMissionStorage({
    session,
    fetchImpl,
    baseUrl: "http://localhost:4096",
  })
  return { s, session, fetchImpl, patches }
}

// ─── MetadataMissionStorage ──────────────────────────────────────────────

describe("MetadataMissionStorage", () => {
  test("read returns null when GET has no metadata mission key", async () => {
    const { s } = buildStorage({ metadata: {} })
    expect(await s.read("ses_x")).toBeNull()
  })

  test("read parses a JSON-string mission (defensive round-trip)", async () => {
    const m = makeMission()
    const { s } = buildStorage({ metadata: { mission: JSON.stringify(m) } })
    const got = await s.read("ses_x")
    expect(got?.id).toBe(m.id)
    expect(got?.status).toBe("active")
  })

  test("read returns null when GET returns null (session missing)", async () => {
    const { s } = buildStorage({ metadata: null })
    expect(await s.read("ses_x")).toBeNull()
  })

  test("read returns null on transport failure (safe degradation)", async () => {
    const { s } = buildStorage({ getThrows: true })
    expect(await s.read("ses_x")).toBeNull()
  })

  test("read returns null when V2 SDK returns error result", async () => {
    const { s, session } = buildStorage({})
    // Override session.get to return an error result
    ;(session as any).get = async () => ({ error: new Error("network fail") })
    expect(await s.read("ses_x")).toBeNull()
  })

  test("write PATCHes /session/{id} with merged metadata (preserves siblings)", async () => {
    const { s, patches } = buildStorage({
      metadata: { otherKey: "keep-me", count: 7 },
      capture: [],
    })
    await s.write("ses_x", makeMission())
    expect(patches).toHaveLength(1)
    const call = patches[0]
    expect(call.method).toBe("PATCH")
    expect(call.url).toBe("http://localhost:4096/session/ses_x")
    expect(call.headers["content-type"]).toBe("application/json")
    const body = JSON.parse(call.body)
    expect(body.metadata.otherKey).toBe("keep-me")
    expect(body.metadata.count).toBe(7)
    expect(body.metadata.mission.id).toBe("mission_test_1")
  })

  test("write(null) deletes the mission key but preserves siblings", async () => {
    const { s, patches } = buildStorage({
      metadata: { mission: { id: "old" }, otherKey: "keep" },
      capture: [],
    })
    await s.write("ses_x", null)
    expect(patches).toHaveLength(1)
    const body = JSON.parse(patches[0].body)
    expect(body.metadata.mission).toBeUndefined()
    expect(body.metadata.otherKey).toBe("keep")
  })

  test("write throws when PATCH returns non-2xx", async () => {
    const { s } = buildStorage({ metadata: {}, patchStatus: 400 })
    await expect(s.write("ses_x", makeMission())).rejects.toThrow(
      /PATCH session\/ses_x failed: 400/,
    )
  })

  test("write throws when fetch throws", async () => {
    const { s } = buildStorage({ patchThrows: true })
    await expect(s.write("ses_x", makeMission())).rejects.toThrow(/patch failed/)
  })

  test("write throws when PATCH returns HTML (SPA fallback)", async () => {
    const { session, fetchImpl } = makeMockTransport({ metadata: {} })
    // Override fetchImpl to return HTML body
    const htmlFetch: any = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      async text() {
        return "<!doctype html><html><body>SPA</body></html>"
      },
    })
    const s = new MetadataMissionStorage({
      session,
      fetchImpl: htmlFetch,
      baseUrl: "http://localhost:4096",
    })
    await expect(s.write("ses_x", makeMission())).rejects.toThrow(/returned HTML/)
  })

  test("write does not use V2 SDK session.update (avoids empty-body bug)", async () => {
    const { s, session } = buildStorage({ metadata: {} })
    let updateCalled = false
    ;(session as any).update = async () => {
      updateCalled = true
      return { data: null }
    }
    await s.write("ses_x", makeMission())
    expect(updateCalled).toBe(false)
  })

  test("mode label is 'metadata'", () => {
    const { s } = buildStorage()
    expect(s.mode).toBe("metadata")
  })
})

// ─── Factory ────────────────────────────────────────────────────────────

describe("createMissionStorage factory", () => {
  test("returns MetadataMissionStorage with all deps", () => {
    const { session, fetchImpl } = makeMockTransport()
    const s = createMissionStorage({
      session,
      fetchImpl,
      baseUrl: "http://localhost:4096",
    })
    expect(s).toBeInstanceOf(MetadataMissionStorage)
    expect(s.mode).toBe("metadata")
  })
})
