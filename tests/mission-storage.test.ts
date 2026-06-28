// Unit tests for the MissionStorage abstraction. Run with: bun test
//
// Covers MetadataMissionStorage using the V2 SDK's session.get() /
// session.update() API. The session is mocked to capture update
// calls and return canned get responses.

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
  /** If true, update() throws. */
  updateThrows?: boolean
  /** Capture every update() call here. */
  capture?: UpdateCall[]
}

interface UpdateCall {
  sessionID: string
  metadata: Record<string, unknown>
}

/**
 * Simulates the V2 SDK's Session2 interface.
 * get() returns { data: { id, metadata } } (the V2 SDK default wrapper).
 * update() captures the call and resolves.
 */
function makeMockSession(opts: MockSessionOptions = {}): {
  session: { get: (p: { sessionID: string }) => Promise<any>; update: (p: { sessionID: string; metadata?: Record<string, unknown> }) => Promise<any> }
  updates: UpdateCall[]
} {
  const updates = opts.capture ?? []
  return {
    session: {
      async get({ sessionID: _sid }: { sessionID: string }) {
        if (opts.getThrows) throw new Error("get failed")
        if (opts.metadata === null || opts.metadata === undefined) {
          return { data: null }
        }
        return { data: { id: _sid, metadata: opts.metadata } }
      },
      async update({ sessionID, metadata }: { sessionID: string; metadata?: Record<string, unknown> }) {
        if (opts.updateThrows) throw new Error("update failed")
        updates.push({ sessionID, metadata: metadata ?? {} })
        return { data: { id: sessionID, metadata } }
      },
    },
    updates,
  }
}

// ─── MetadataMissionStorage ──────────────────────────────────────────────

describe("MetadataMissionStorage", () => {
  test("read returns null when GET has no metadata mission key", async () => {
    const { session } = makeMockSession({ metadata: {} })
    const s = new MetadataMissionStorage({ session })
    expect(await s.read("ses_x")).toBeNull()
  })

  test("read parses a JSON-string mission (defensive round-trip)", async () => {
    const m = makeMission()
    const { session } = makeMockSession({
      metadata: { mission: JSON.stringify(m) },
    })
    const s = new MetadataMissionStorage({ session })
    const got = await s.read("ses_x")
    expect(got?.id).toBe(m.id)
    expect(got?.status).toBe("active")
  })

  test("read returns null when GET returns null (session missing)", async () => {
    const { session } = makeMockSession({ metadata: null })
    const s = new MetadataMissionStorage({ session })
    expect(await s.read("ses_x")).toBeNull()
  })

  test("read returns null on transport failure (safe degradation)", async () => {
    const { session } = makeMockSession({ getThrows: true })
    const s = new MetadataMissionStorage({ session })
    expect(await s.read("ses_x")).toBeNull()
  })

  test("write updates metadata with merged keys (preserves siblings)", async () => {
    const { session, updates } = makeMockSession({
      metadata: { otherKey: "keep-me", count: 7 },
      capture: [],
    })
    const s = new MetadataMissionStorage({ session })
    await s.write("ses_x", makeMission())
    expect(updates).toHaveLength(1)
    const call = updates[0]
    expect(call.sessionID).toBe("ses_x")
    expect(call.metadata.otherKey).toBe("keep-me")
    expect(call.metadata.count).toBe(7)
    expect((call.metadata.mission as Mission).id).toBe("mission_test_1")
  })

  test("write(null) deletes the mission key but preserves siblings", async () => {
    const { session, updates } = makeMockSession({
      metadata: { mission: { id: "old" }, otherKey: "keep" },
      capture: [],
    })
    const s = new MetadataMissionStorage({ session })
    await s.write("ses_x", null)
    const body = updates[0].metadata
    expect(body.mission).toBeUndefined()
    expect(body.otherKey).toBe("keep")
  })

  test("write throws when update() throws", async () => {
    const { session } = makeMockSession({
      metadata: {},
      updateThrows: true,
    })
    const s = new MetadataMissionStorage({ session })
    await expect(s.write("ses_x", makeMission())).rejects.toThrow(/PATCH session\/ses_x failed/)
  })

  test("mode label is 'metadata'", () => {
    const { session } = makeMockSession()
    const s = new MetadataMissionStorage({ session })
    expect(s.mode).toBe("metadata")
  })
})

// ─── Factory ────────────────────────────────────────────────────────────

describe("createMissionStorage factory", () => {
  test("returns MetadataMissionStorage with session", () => {
    const { session } = makeMockSession()
    const s = createMissionStorage({ session })
    expect(s).toBeInstanceOf(MetadataMissionStorage)
    expect(s.mode).toBe("metadata")
  })
})
