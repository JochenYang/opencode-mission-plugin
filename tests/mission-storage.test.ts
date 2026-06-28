// Unit tests for the MissionStorage abstraction. Run with: bun test
//
// Covers MetadataMissionStorage: PATCH/GET shape, merge semantics
// across multiple keys, JSON-string round-trip, transport failure
// surfaces, HTML guard, and the factory.

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

// ─── MetadataMissionStorage ──────────────────────────────────────────────

describe("MetadataMissionStorage", () => {
  test("read returns null when metadata has no mission key", async () => {
    const fetchImpl = mockFetch({
      "GET /session/ses_x": { metadata: {} },
    })
    const s = new MetadataMissionStorage({
      baseUrl: "https://api.example.com",
      headers: {},
      fetchImpl,
    })
    expect(await s.read("ses_x")).toBeNull()
  })

  test("read parses a JSON-string mission (defensive round-trip)", async () => {
    const m = makeMission()
    const fetchImpl = mockFetch({
      "GET /session/ses_x": {
        metadata: { mission: JSON.stringify(m) },
      },
    })
    const s = new MetadataMissionStorage({
      baseUrl: "https://api.example.com",
      headers: {},
      fetchImpl,
    })
    const got = await s.read("ses_x")
    expect(got?.id).toBe(m.id)
    expect(got?.status).toBe("active")
  })

  test("write PATCHes metadata with merged keys (preserves siblings)", async () => {
    const patches: any[] = []
    const fetchImpl = mockFetch(
      {
        "GET /session/ses_x": {
          metadata: { otherKey: "keep-me", count: 7 },
        },
        "PATCH /session/ses_x": { ok: true, capture: patches },
      },
      patches,
    )
    const s = new MetadataMissionStorage({
      baseUrl: "https://api.example.com",
      headers: { auth: "x" },
      fetchImpl,
    })
    await s.write("ses_x", makeMission())
    expect(patches).toHaveLength(1)
    const body = JSON.parse(patches[0].body)
    expect(body.metadata.otherKey).toBe("keep-me")
    expect(body.metadata.count).toBe(7)
    expect(body.metadata.mission.id).toBe("mission_test_1")
    expect(patches[0].headers["Content-Type"]).toBe("application/json")
    expect(patches[0].headers.auth).toBe("x")
  })

  test("write(null) deletes the mission key but preserves siblings", async () => {
    const patches: any[] = []
    const fetchImpl = mockFetch(
      {
        "GET /session/ses_x": {
          metadata: { mission: { id: "old" }, otherKey: "keep" },
        },
        "PATCH /session/ses_x": { ok: true, capture: patches },
      },
      patches,
    )
    const s = new MetadataMissionStorage({
      baseUrl: "https://api.example.com",
      headers: {},
      fetchImpl,
    })
    await s.write("ses_x", null)
    const body = JSON.parse(patches[0].body)
    expect(body.metadata.mission).toBeUndefined()
    expect(body.metadata.otherKey).toBe("keep")
  })

  test("write throws when PATCH fails", async () => {
    const fetchImpl = mockFetch({
      "GET /session/ses_x": { metadata: {} },
      "PATCH /session/ses_x": { ok: false, status: 500 },
    })
    const s = new MetadataMissionStorage({
      baseUrl: "https://api.example.com",
      headers: {},
      fetchImpl,
    })
    await expect(s.write("ses_x", makeMission())).rejects.toThrow(
      /PATCH \/session\/ses_x failed/,
    )
  })

  test("read returns null on transport failure (safe degradation)", async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.reject(new Error("network down")) as any
    const s = new MetadataMissionStorage({
      baseUrl: "https://api.example.com",
      headers: {},
      fetchImpl,
    })
    expect(await s.read("ses_x")).toBeNull()
  })

  test("HTML response on read is treated as missing metadata", async () => {
    const fetchImpl = mockFetch({
      "GET /session/ses_x": { metadata: {}, rawBody: "<!doctype html>" },
    })
    const s = new MetadataMissionStorage({
      baseUrl: "https://api.example.com",
      headers: {},
      fetchImpl,
    })
    expect(await s.read("ses_x")).toBeNull()
  })

  test("mode label is 'metadata'", () => {
    const s = new MetadataMissionStorage({
      baseUrl: "https://api.example.com",
      headers: {},
    })
    expect(s.mode).toBe("metadata")
  })
})

// ─── Factory ────────────────────────────────────────────────────────────

describe("createMissionStorage factory", () => {
  test("returns MetadataMissionStorage with baseUrl", () => {
    const s = createMissionStorage({ baseUrl: "https://api.example.com" })
    expect(s).toBeInstanceOf(MetadataMissionStorage)
    expect(s.mode).toBe("metadata")
  })

  test("throws if baseUrl is missing", () => {
    // @ts-expect-error — intentionally invalid input
    expect(() => createMissionStorage({})).toThrow(/requires baseUrl/)
  })
})

// ─── Test helpers ────────────────────────────────────────────────────────

interface MockOptions {
  rawBody?: string
  ok?: boolean
  status?: number
  capture?: any[]
}

function mockFetch(
  routes: Record<string, any>,
  patches?: any[],
): typeof fetch {
  return (async (input: any, init?: any) => {
    // Support both call signatures:
    //   fetch(url, options)
    //   fetch(Request)
    const isRequest = input && typeof input === "object" && typeof input.url === "string"
    const urlStr: string = isRequest ? input.url : String(input)
    const method: string = (
      (init?.method as string | undefined) ??
      (isRequest ? (input as any).method : undefined) ??
      "GET"
    ).toUpperCase()
    const headersIn = init?.headers ?? (isRequest ? (input as any).headers : undefined)
    const body: string =
      typeof init?.body === "string"
        ? init.body
        : isRequest && typeof (input as any).body === "string"
          ? ((input as any).body as string)
          : ""
    // Strip base URL so route keys are "METHOD /session/..." instead of
    // "METHOD https://api.example.com/session/...".
    const path = urlStr.replace(/^https?:\/\/[^/]+/, "")
    const key = `${method} ${path}`
    const route = routes[key]
    if (!route) {
      return new Response("not found", { status: 404 }) as any
    }
    if (method === "PATCH" && patches !== undefined) {
      const headers: Record<string, string> = {}
      if (headersIn) {
        if (headersIn instanceof Headers) {
          headersIn.forEach((v: string, k: string) => {
            headers[k] = v
          })
        } else {
          Object.assign(headers, headersIn)
        }
      }
      patches.push({ url: urlStr, body, headers })
    }
    const rawBody = route.rawBody ?? ""
    const bodyOut = rawBody || JSON.stringify(route)
    const status = route.status ?? (route.ok === false ? 500 : 200)
    const headersOut = rawBody
      ? { "content-type": "text/html" }
      : { "content-type": "application/json" }
    return new Response(bodyOut, { status, headers: headersOut }) as any
  }) as typeof fetch
}