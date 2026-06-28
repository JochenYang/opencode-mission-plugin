// Unit tests for the MissionStorage abstraction. Run with: bun test
//
// Covers MetadataMissionStorage using the V2 SDK: session.get returns the
// current metadata, session.update writes the merged result; missing
// session returns null; PATCH failure surfaces; factory wiring.

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

interface MockUpdateCall {
  sessionID: string
  metadata: Record<string, unknown>
}

interface MockV2Client {
  session: {
    get: (params: { sessionID: string }) => Promise<{
      data: { id?: string; parentID?: string; metadata?: Record<string, unknown> } | null
    }>
    update: (params: { sessionID: string; metadata: Record<string, unknown> }) => Promise<{
      data: unknown
      error: { message: string } | null
    }>
  }
}

function makeMockV2Client(opts: {
  /** Static metadata to return from session.get (or null to mimic 404). */
  metadata?: Record<string, unknown> | null
  /** Append every update call to this array. */
  captureUpdates?: MockUpdateCall[]
  /** Override the result of session.update. */
  updateResult?: { error: { message: string } | null }
} = {}): MockV2Client {
  const getResult = opts.metadata === null
    ? null
    : { id: "ses_x", parentID: undefined, metadata: opts.metadata ?? {} }
  return {
    session: {
      get: async () => ({ data: getResult }),
      update: async (params) => {
        opts.captureUpdates?.push({ sessionID: params.sessionID, metadata: params.metadata })
        return { data: null, error: opts.updateResult?.error ?? null }
      },
    },
  }
}

// ─── MetadataMissionStorage ──────────────────────────────────────────────

describe("MetadataMissionStorage", () => {
  test("read returns null when metadata has no mission key", async () => {
    const v2 = makeMockV2Client({ metadata: {} })
    const s = new MetadataMissionStorage({ v2Client: v2 as any })
    expect(await s.read("ses_x")).toBeNull()
  })

  test("read parses a JSON-string mission (defensive round-trip)", async () => {
    const m = makeMission()
    const v2 = makeMockV2Client({
      metadata: { mission: JSON.stringify(m) },
    })
    const s = new MetadataMissionStorage({ v2Client: v2 as any })
    const got = await s.read("ses_x")
    expect(got?.id).toBe(m.id)
    expect(got?.status).toBe("active")
  })

  test("read returns null when session.get returns no data", async () => {
    const v2 = makeMockV2Client({ metadata: null })
    const s = new MetadataMissionStorage({ v2Client: v2 as any })
    expect(await s.read("ses_x")).toBeNull()
  })

  test("read returns null on transport failure (safe degradation)", async () => {
    const v2: MockV2Client = {
      session: {
        get: async () => {
          throw new Error("network down")
        },
        update: async () => ({ data: null, error: null }),
      },
    }
    const s = new MetadataMissionStorage({ v2Client: v2 as any })
    expect(await s.read("ses_x")).toBeNull()
  })

  test("write PATCHes metadata with merged keys (preserves siblings)", async () => {
    const captured: MockUpdateCall[] = []
    const v2 = makeMockV2Client({
      metadata: { otherKey: "keep-me", count: 7 },
      captureUpdates: captured,
    })
    const s = new MetadataMissionStorage({ v2Client: v2 as any })
    await s.write("ses_x", makeMission())
    expect(captured).toHaveLength(1)
    const call = captured[0]
    expect(call.sessionID).toBe("ses_x")
    expect((call.metadata.otherKey as string)).toBe("keep-me")
    expect((call.metadata.count as number)).toBe(7)
    expect(((call.metadata.mission) as Mission).id).toBe("mission_test_1")
  })

  test("write(null) deletes the mission key but preserves siblings", async () => {
    const captured: MockUpdateCall[] = []
    const v2 = makeMockV2Client({
      metadata: { mission: { id: "old" }, otherKey: "keep" },
      captureUpdates: captured,
    })
    const s = new MetadataMissionStorage({ v2Client: v2 as any })
    await s.write("ses_x", null)
    const call = captured[0]
    expect(call.metadata.mission).toBeUndefined()
    expect((call.metadata.otherKey as string)).toBe("keep")
  })

  test("write throws when V2 SDK update returns an error", async () => {
    const v2 = makeMockV2Client({
      metadata: {},
      updateResult: { error: { message: "boom" } },
    })
    const s = new MetadataMissionStorage({ v2Client: v2 as any })
    await expect(s.write("ses_x", makeMission())).rejects.toThrow(
      /session\.update failed for ses_x: boom/,
    )
  })

  test("write throws when V2 SDK update throws", async () => {
    const v2: MockV2Client = {
      session: {
        get: async () => ({ data: { metadata: {} } }),
        update: async () => {
          throw new Error("network down")
        },
      },
    }
    const s = new MetadataMissionStorage({ v2Client: v2 as any })
    await expect(s.write("ses_x", makeMission())).rejects.toThrow(/network down/)
  })

  test("mode label is 'metadata'", () => {
    const v2 = makeMockV2Client()
    const s = new MetadataMissionStorage({ v2Client: v2 as any })
    expect(s.mode).toBe("metadata")
  })
})

// ─── Factory ────────────────────────────────────────────────────────────

describe("createMissionStorage factory", () => {
  test("returns MetadataMissionStorage with v2Client", () => {
    const v2 = makeMockV2Client()
    const s = createMissionStorage({ v2Client: v2 as any })
    expect(s).toBeInstanceOf(MetadataMissionStorage)
    expect(s.mode).toBe("metadata")
  })
})
