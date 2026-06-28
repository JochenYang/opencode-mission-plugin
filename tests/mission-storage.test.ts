// Unit tests for the MissionStorage abstraction. Run with: bun test
//
// Primary: FileMissionStorage (local JSON file, atomic tmp+rename writes).
// Legacy: MetadataMissionStorage (V2 SDK session metadata PATCH).
//
// File mission storage is the default. It stores missions in a shared JSON
// file at a configurable directory path (or by default in the global config
// dir). The tests use a temporary directory per suite.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import {
  FileMissionStorage,
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

/** Create a temporary directory for file-based storage tests. */
function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "mission-storage-test-"))
}

/** Read the raw storage file for assertion. */
function readStorageFile(dir: string): any {
  const p = join(dir, ".opencode", "missions.json")
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, "utf-8"))
}

interface MockSessionOptions {
  /** The metadata object returned by get() (session.metadata). */
  metadata?: Record<string, unknown> | null
  /** If true, get() throws. */
  getThrows?: boolean
  /** Capture every update() call here. */
  capture?: UpdateCall[]
  /** If true, update() throws. */
  updateThrows?: boolean
  /** Update response (default: { data: { id, metadata } }). */
  updateResponse?: any
}

interface UpdateCall {
  sessionID: string
  metadata: Record<string, unknown>
}

/**
 * Simulates the V2 SDK's Session2 interface.
 * get() returns { data: { id, metadata } } (the V2 SDK default wrapper).
 * update() captures the call and returns a success response.
 */
function makeMockSession(opts: MockSessionOptions = {}): {
  session: {
    get: (p: { sessionID: string }) => Promise<any>
    update: (p: { sessionID: string; metadata?: Record<string, unknown> }) => Promise<any>
  }
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
        if (opts.updateResponse) return opts.updateResponse
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

  test("read returns null when V2 SDK returns error result", async () => {
    const { session } = makeMockSession()
    // Override session.get to return an error result
    ;(session as any).get = async () => ({ error: new Error("network fail") })
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
    expect(updates).toHaveLength(1)
    const body = updates[0].metadata
    expect(body.mission).toBeUndefined()
    expect(body.otherKey).toBe("keep")
  })

  test("write throws when update throws", async () => {
    const { session } = makeMockSession({ updateThrows: true })
    const s = new MetadataMissionStorage({ session })
    await expect(s.write("ses_x", makeMission())).rejects.toThrow(/PATCH session\/ses_x failed/)
  })

  test("write throws when V2 SDK update returns error result", async () => {
    const { session } = makeMockSession({})
    ;(session as any).update = async () => ({
      error: { message: "BadRequest: Expected object, got undefined" },
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

// ─── FileMissionStorage ───────────────────────────────────────────────

describe("FileMissionStorage", () => {
  test("read returns null when no file exists", async () => {
    const dir = tmpDir()
    try {
      const s = new FileMissionStorage({ directory: dir })
      expect(await s.read("ses_x")).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("write then read round-trips a mission", async () => {
    const dir = tmpDir()
    try {
      const s = new FileMissionStorage({ directory: dir })
      const m = makeMission({ id: "mission_abc" })
      await s.write("ses_1", m)
      const got = await s.read("ses_1")
      expect(got?.id).toBe("mission_abc")
      expect(got?.status).toBe("active")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("write(null) deletes the mission", async () => {
    const dir = tmpDir()
    try {
      const s = new FileMissionStorage({ directory: dir })
      await s.write("ses_1", makeMission())
      expect(await s.read("ses_1")).not.toBeNull()
      await s.write("ses_1", null)
      expect(await s.read("ses_1")).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("sessions are isolated (write ses_1 does not affect ses_2)", async () => {
    const dir = tmpDir()
    try {
      const s = new FileMissionStorage({ directory: dir })
      await s.write("ses_1", makeMission({ id: "m1" }))
      await s.write("ses_2", makeMission({ id: "m2" }))
      const g1 = await s.read("ses_1")
      const g2 = await s.read("ses_2")
      expect(g1?.id).toBe("m1")
      expect(g2?.id).toBe("m2")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("write(null) on non-existent key is no-op", async () => {
    const dir = tmpDir()
    try {
      const s = new FileMissionStorage({ directory: dir })
      await s.write("ses_none", null) // should not throw
      expect(await s.read("ses_none")).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("atomic write: no .tmp file left behind", async () => {
    const dir = tmpDir()
    try {
      const s = new FileMissionStorage({ directory: dir })
      await s.write("ses_1", makeMission())
      const storageDir = join(dir, ".opencode")
      const files = readdirSync(storageDir)
      const tmpFiles = files.filter((f: string) => f.endsWith(".tmp"))
      expect(tmpFiles).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("concurrent writes are serialized", async () => {
    const dir = tmpDir()
    try {
      const s = new FileMissionStorage({ directory: dir })
      const promises = [1, 2, 3].map((i) => s.write(`ses_${i}`, makeMission({ id: `m${i}` })))
      await Promise.all(promises)
      const g1 = await s.read("ses_1")
      const g2 = await s.read("ses_2")
      const g3 = await s.read("ses_3")
      expect(g1?.id).toBe("m1")
      expect(g2?.id).toBe("m2")
      expect(g3?.id).toBe("m3")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("healthCheck returns ok when dir is writable", async () => {
    const dir = tmpDir()
    try {
      const s = new FileMissionStorage({ directory: dir })
      const h = await s.healthCheck!()
      expect(h.ok).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("mode label is 'file'", () => {
    const s = new FileMissionStorage()
    expect(s.mode).toBe("file")
  })
})

// ─── Factory ────────────────────────────────────────────────────────────

describe("createMissionStorage factory", () => {
  test("returns FileMissionStorage without directory", () => {
    const s = createMissionStorage()
    expect(s).toBeInstanceOf(FileMissionStorage)
    expect(s.mode).toBe("file")
  })

  test("returns FileMissionStorage with directory", () => {
    const dir = tmpDir()
    try {
      const s = createMissionStorage({ directory: dir })
      expect(s).toBeInstanceOf(FileMissionStorage)
      expect(s.mode).toBe("file")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
