// Unit tests for the MissionStorage abstraction. Run with: bun test
//
// Covers:
// - FileMissionStorage: round-trip persistence, missing-file → null,
//   write(null) deletes, project slug isolation
// - MetadataMissionStorage: PATCH/GET shape, merge semantics across
//   multiple keys, JSON-string round-trip, transport failure surfaces
// - createMissionStorage factory: env-driven mode selection

import { describe, expect, test, beforeEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  FileMissionStorage,
  MetadataMissionStorage,
  createMissionStorage,
  resolveStorageModeFromEnv,
  type MissionStorage,
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

// ─── FileMissionStorage ───────────────────────────────────────────────────

describe("FileMissionStorage", () => {
  let dir: string
  let storage: FileMissionStorage

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mission-storage-test-"))
    storage = new FileMissionStorage({ directory: "/tmp/proj-a", storageDir: dir })
  })

  test("read returns null when no mission exists", async () => {
    const result = await storage.read("sess_1")
    expect(result).toBeNull()
  })

  test("write then read round-trips a mission", async () => {
    const m = makeMission({ id: "mission_round_trip" })
    await storage.write("sess_1", m)
    const read = await storage.read("sess_1")
    expect(read).toEqual(m)
  })

  test("write(null) deletes the record", async () => {
    const m = makeMission()
    await storage.write("sess_1", m)
    expect(await storage.read("sess_1")).toEqual(m)
    await storage.write("sess_1", null)
    expect(await storage.read("sess_1")).toBeNull()
  })

  test("different sessions are isolated", async () => {
    const a = makeMission({ id: "mission_a", objective: "alpha" })
    const b = makeMission({ id: "mission_b", objective: "beta" })
    await storage.write("sess_a", a)
    await storage.write("sess_b", b)
    expect((await storage.read("sess_a"))?.objective).toBe("alpha")
    expect((await storage.read("sess_b"))?.objective).toBe("beta")
  })

  test("different workspaces are isolated via project slug", async () => {
    const sA = new FileMissionStorage({ directory: "/tmp/proj-a", storageDir: dir })
    const sB = new FileMissionStorage({ directory: "/tmp/proj-b", storageDir: dir })
    const mA = makeMission({ objective: "alpha" })
    const mB = makeMission({ objective: "beta" })
    await sA.write("sess_1", mA)
    await sB.write("sess_1", mB)
    expect((await sA.read("sess_1"))?.objective).toBe("alpha")
    expect((await sB.read("sess_1"))?.objective).toBe("beta")
    rmSync(dir, { recursive: true, force: true })
  })

  test("mode label is 'file'", () => {
    expect(storage.mode).toBe("file")
  })
})

// ─── MetadataMissionStorage ───────────────────────────────────────────────

interface FetchCall {
  url: string
  method: string
  body?: any
  responseStatus: number
  responseBody: any
}

function makeFakeFetch(calls: FetchCall[]): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url
    const method = init?.method ?? "GET"
    // Find next call matching this method+url
    const idx = calls.findIndex((c) => c.url === url && c.method === method)
    if (idx < 0) {
      return new Response("not found", { status: 404 })
    }
    const call = calls[idx]
    // Consume one matching call (FIFO within a single request shape)
    calls.splice(idx, 1)
    let body: any = undefined
    if (init?.body) {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    return new Response(JSON.stringify(call.responseBody), {
      status: call.responseStatus,
      headers: { "Content-Type": "application/json" },
    })
  }) as any
}

describe("MetadataMissionStorage", () => {
  test("read returns null when metadata has no mission key", async () => {
    const fetchImpl = makeFakeFetch([
      {
        url: "http://test/session/sess_1",
        method: "GET",
        responseStatus: 200,
        responseBody: { id: "sess_1", metadata: { other: "value" } },
      },
    ])
    const storage = new MetadataMissionStorage({
      baseUrl: "http://test",
      headers: { "x-test": "1" },
      fetchImpl,
    })
    expect(await storage.read("sess_1")).toBeNull()
  })

  test("read parses a JSON-string mission (defensive round-trip)", async () => {
    const m = makeMission()
    const fetchImpl = makeFakeFetch([
      {
        url: "http://test/session/sess_1",
        method: "GET",
        responseStatus: 200,
        responseBody: { id: "sess_1", metadata: { mission: JSON.stringify(m) } },
      },
    ])
    const storage = new MetadataMissionStorage({
      baseUrl: "http://test",
      headers: {},
      fetchImpl,
    })
    const read = await storage.read("sess_1")
    expect(read).toEqual(m)
  })

  test("write PATCHes metadata with merged keys (preserves siblings)", async () => {
    const m = makeMission({ objective: "merged" })
    let capturedBody: any = null
    const fetchImpl = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url
      if (init?.method === "GET") {
        return new Response(
          JSON.stringify({
            id: "sess_1",
            metadata: { sibling: "keep-me", mission: makeMission({ objective: "old" }) },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }
      // PATCH
      capturedBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as any

    const storage = new MetadataMissionStorage({
      baseUrl: "http://test",
      headers: {},
      fetchImpl,
    })
    await storage.write("sess_1", m)
    expect(capturedBody.metadata.sibling).toBe("keep-me")
    expect(capturedBody.metadata.mission.objective).toBe("merged")
  })

  test("write(null) deletes the mission key but preserves siblings", async () => {
    let capturedBody: any = null
    const fetchImpl = (async (input: any, init?: any) => {
      if (init?.method === "GET") {
        return new Response(
          JSON.stringify({
            id: "sess_1",
            metadata: { sibling: "keep-me", mission: makeMission() },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }
      capturedBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as any
    const storage = new MetadataMissionStorage({
      baseUrl: "http://test",
      headers: {},
      fetchImpl,
    })
    await storage.write("sess_1", null)
    expect(capturedBody.metadata.sibling).toBe("keep-me")
    expect("mission" in capturedBody.metadata).toBe(false)
  })

  test("write throws when PATCH fails", async () => {
    const fetchImpl = (async (input: any, init?: any) => {
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ id: "sess_1", metadata: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response("server error", { status: 500 })
    }) as any
    const storage = new MetadataMissionStorage({
      baseUrl: "http://test",
      headers: {},
      fetchImpl,
    })
    await expect(storage.write("sess_1", makeMission())).rejects.toThrow(/PATCH.*failed/)
  })

  test("read returns null on transport failure (safe degradation)", async () => {
    const fetchImpl = (async () => new Response("network error", { status: 502 })) as any
    const storage = new MetadataMissionStorage({
      baseUrl: "http://test",
      headers: {},
      fetchImpl,
    })
    expect(await storage.read("sess_1")).toBeNull()
  })

  test("HTML response on read is treated as missing metadata", async () => {
    const fetchImpl = (async () =>
      new Response("<!doctype html><html></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })) as any
    const storage = new MetadataMissionStorage({
      baseUrl: "http://test",
      headers: {},
      fetchImpl,
    })
    expect(await storage.read("sess_1")).toBeNull()
  })

  test("mode label is 'metadata'", () => {
    const fetchImpl = makeFakeFetch([])
    const storage = new MetadataMissionStorage({
      baseUrl: "http://test",
      headers: {},
      fetchImpl,
    })
    expect(storage.mode).toBe("metadata")
  })
})

// ─── Factory / env resolver ───────────────────────────────────────────────

describe("resolveStorageModeFromEnv", () => {
  test("defaults to 'file' when env unset", () => {
    const prev = process.env.OPENCODE_MISSION_STORAGE
    delete process.env.OPENCODE_MISSION_STORAGE
    expect(resolveStorageModeFromEnv()).toBe("file")
    if (prev !== undefined) process.env.OPENCODE_MISSION_STORAGE = prev
  })

  test("respects OPENCODE_MISSION_STORAGE=metadata", () => {
    process.env.OPENCODE_MISSION_STORAGE = "metadata"
    expect(resolveStorageModeFromEnv()).toBe("metadata")
  })

  test("falls back to 'file' on unknown value", () => {
    process.env.OPENCODE_MISSION_STORAGE = "garbage"
    expect(resolveStorageModeFromEnv()).toBe("file")
  })
})

describe("createMissionStorage factory", () => {
  test("returns FileMissionStorage for mode=file", () => {
    const s = createMissionStorage({ mode: "file", directory: "/tmp" })
    expect(s.mode).toBe("file")
  })

  test("returns MetadataMissionStorage for mode=metadata with baseUrl", () => {
    const s = createMissionStorage({ mode: "metadata", baseUrl: "http://x", headers: {} })
    expect(s.mode).toBe("metadata")
  })

  test("throws if mode=metadata without baseUrl", () => {
    expect(() => createMissionStorage({ mode: "metadata" })).toThrow(/baseUrl/)
  })
})
