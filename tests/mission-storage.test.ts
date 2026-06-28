// Unit tests for the MissionStorage abstraction. Run with: bun test
//
// Covers MetadataMissionStorage using raw fetch against
// /api/session/:sessionID. The fetch is mocked to capture PATCH
// requests and return canned GET responses.

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

interface MockFetchOptions {
  /** Body returned by GET /api/session/:id (parsed as JSON, sent to res.json). */
  metadata?: Record<string, unknown> | null
  /** Status returned by GET (default 200). */
  getStatus?: number
  /** Status returned by PATCH (default 200). */
  patchStatus?: number
  /** Capture every PATCH call here. */
  capture?: PatchCall[]
  /** Throws on every call (e.g. network down). */
  throwOnCall?: boolean
}

interface PatchCall {
  url: string
  method: string
  body: string
  headers: Record<string, string>
}

function makeMockFetch(opts: MockFetchOptions = {}): {
  fetch: typeof fetch
  patches: PatchCall[]
} {
  // Use the caller-provided capture array (or a fresh one) so the
  // caller can observe captured PATCH calls by inspecting the same
  // reference we push into.
  const patches = opts.capture ?? []
  const headersToObj = (h: HeadersInit | undefined): Record<string, string> => {
    const out: Record<string, string> = {}
    if (!h) return out
    if (h instanceof Headers) {
      h.forEach((v, k) => {
        out[k] = v
      })
    } else {
      Object.assign(out, h)
    }
    return out
  }

  const fetchImpl: typeof fetch = async (input: any, init?: any) => {
    if (opts.throwOnCall) throw new Error("network down")
    const url: string =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : typeof input.url === "string"
            ? input.url
            : String(input.url)
    const method: string =
      (init?.method as string | undefined) ??
      (input && typeof input === "object" ? (input as any).method : undefined) ??
      "GET"
    const isPatch = method.toUpperCase() === "PATCH"
    const isGet = method.toUpperCase() === "GET"
    const body =
      typeof init?.body === "string"
        ? init.body
        : input && typeof input === "object" && typeof (input as any).body === "string"
          ? ((input as any).body as string)
          : ""

    if (isPatch) {
      patches.push({
        url,
        method,
        body,
        headers: headersToObj(init?.headers ?? (input && (input as any).headers)),
      })
    }

    if (isGet) {
      const status = opts.getStatus ?? 200
      if (opts.metadata === null || opts.metadata === undefined) {
        return new Response("not found", { status: 404 }) as any
      }
      return new Response(
        JSON.stringify({ id: "ses_x", metadata: opts.metadata }),
        { status, headers: { "content-type": "application/json" } },
      ) as any
    }
    if (isPatch) {
      return new Response("", { status: opts.patchStatus ?? 200 }) as any
    }
    return new Response("", { status: 200 }) as any
  }
  return { fetch: fetchImpl, patches }
}

// ─── MetadataMissionStorage ──────────────────────────────────────────────

describe("MetadataMissionStorage", () => {
  test("read returns null when GET has no metadata mission key", async () => {
    const { fetch } = makeMockFetch({ metadata: {} })
    const s = new MetadataMissionStorage({
      baseUrl: "https://api.example.com",
      fetchImpl: fetch,
    })
    expect(await s.read("ses_x")).toBeNull()
  })

  test("read parses a JSON-string mission (defensive round-trip)", async () => {
    const m = makeMission()
    const { fetch } = makeMockFetch({
      metadata: { mission: JSON.stringify(m) },
    })
    const s = new MetadataMissionStorage({
      baseUrl: "https://api.example.com",
      fetchImpl: fetch,
    })
    const got = await s.read("ses_x")
    expect(got?.id).toBe(m.id)
    expect(got?.status).toBe("active")
  })

  test("read returns null when GET 404s (session missing)", async () => {
    const { fetch } = makeMockFetch({ metadata: null })
    const s = new MetadataMissionStorage({
      baseUrl: "https://api.example.com",
      fetchImpl: fetch,
    })
    expect(await s.read("ses_x")).toBeNull()
  })

  test("read returns null on transport failure (safe degradation)", async () => {
    const { fetch } = makeMockFetch({ throwOnCall: true })
    const s = new MetadataMissionStorage({
      baseUrl: "https://api.example.com",
      fetchImpl: fetch,
    })
    expect(await s.read("ses_x")).toBeNull()
  })

  test("write PATCHes metadata with merged keys (preserves siblings)", async () => {
    const { fetch, patches } = makeMockFetch({
      metadata: { otherKey: "keep-me", count: 7 },
      capture: [],
    })
    const s = new MetadataMissionStorage({
      baseUrl: "https://api.example.com",
      fetchImpl: fetch,
    })
    await s.write("ses_x", makeMission())
    expect(patches).toHaveLength(1)
    const call = patches[0]
    expect(call.url).toBe("https://api.example.com/api/session/ses_x")
    expect(call.method).toBe("PATCH")
    const body = JSON.parse(call.body)
    expect(body.metadata.otherKey).toBe("keep-me")
    expect(body.metadata.count).toBe(7)
    expect((body.metadata.mission as Mission).id).toBe("mission_test_1")
    expect(call.headers["Content-Type"]).toBe("application/json")
  })

  test("write(null) deletes the mission key but preserves siblings", async () => {
    const { fetch, patches } = makeMockFetch({
      metadata: { mission: { id: "old" }, otherKey: "keep" },
      capture: [],
    })
    const s = new MetadataMissionStorage({
      baseUrl: "https://api.example.com",
      fetchImpl: fetch,
    })
    await s.write("ses_x", null)
    const body = JSON.parse(patches[0].body)
    expect(body.metadata.mission).toBeUndefined()
    expect(body.metadata.otherKey).toBe("keep")
  })

  test("write throws when PATCH returns non-2xx", async () => {
    const { fetch } = makeMockFetch({
      metadata: {},
      patchStatus: 500,
    })
    const s = new MetadataMissionStorage({
      baseUrl: "https://api.example.com",
      fetchImpl: fetch,
    })
    await expect(s.write("ses_x", makeMission())).rejects.toThrow(
      /PATCH \/api\/session\/ses_x returned status 500/,
    )
  })

  test("write throws when fetchImpl throws", async () => {
    const { fetch } = makeMockFetch({ throwOnCall: true })
    const s = new MetadataMissionStorage({
      baseUrl: "https://api.example.com",
      fetchImpl: fetch,
    })
    await expect(s.write("ses_x", makeMission())).rejects.toThrow(/network down/)
  })

  test("mode label is 'metadata'", () => {
    const { fetch } = makeMockFetch()
    const s = new MetadataMissionStorage({
      baseUrl: "https://api.example.com",
      fetchImpl: fetch,
    })
    expect(s.mode).toBe("metadata")
  })
})

// ─── Factory ────────────────────────────────────────────────────────────

describe("createMissionStorage factory", () => {
  test("returns MetadataMissionStorage with baseUrl + fetchImpl", () => {
    const { fetch } = makeMockFetch()
    const s = createMissionStorage({ baseUrl: "https://api.example.com", fetchImpl: fetch })
    expect(s).toBeInstanceOf(MetadataMissionStorage)
    expect(s.mode).toBe("metadata")
  })
})
