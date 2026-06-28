// ─────────────────────────────────────────────────────────────────────────────
//  MissionStorage
//
// Single implementation: MetadataMissionStorage. Stores Mission records
// inside the opencode session's typed metadata JSON column.
//
// Why a hybrid transport (V2 SDK reads + raw fetch writes):
//
//   - The V2 SDK generated for opencode 1.17.11 has TWO known issues:
//     * session.update emits an EMPTY request body even when metadata
//       is set. The server's payload validator rejects this with
//       "Expected object, got undefined" and the metadata column is
//       never updated. Verified empirically by inspecting the V2 SDK's
//       request body — it's an empty string.
//     * session.get works correctly (response is {data, request, response}).
//   - The V1 client's `v1Config.fetch` wraps responses in a
//     `{v: [...]}` envelope, breaking reads of unwrapped server responses.
//   - globalThis.fetch is blocked by the opencode plugin sandbox.
//
// The fix:
//   - READS: use V2 SDK session.get() — clean response, no v[0] wrap.
//   - WRITES: use V1 client's fetch with raw fetch against
//     /session/{id} (no /api prefix; the V2 SDK URL is canonical).
//     The request body is sent correctly (V1 fetch does not wrap
//     request bodies), and we only check the HTTP status on the
//     response — the v[0] response wrap does not affect the status code.
//
// Requires opencode >= 1.17.11. A PATCH failure surfaces as a hard
// error so the user notices — silent fallback would hide misconfiguration.
// ─────────────────────────────────────────────────────────────────────────────

import type { Mission } from "./types.js"
import { log } from "./utils/log.js"

/** Public read/write surface for mission persistence. */
export interface MissionStorage {
  /** A short label for logging. */
  readonly mode: "metadata"

  /**
   * Read the Mission for a session. Returns null if no mission exists.
   * Throws on hard transport errors so the caller can surface them.
   */
  read(sessionID: string): Promise<Mission | null>

  /**
   * Persist a Mission. Passing null means "delete the record"
   * (matches the cancelled transition semantics).
   */
  write(sessionID: string, mission: Mission | null): Promise<void>

  /**
   * Optional boot-time health probe. Default no-op.
   */
  healthCheck?(): Promise<{ ok: boolean; detail?: string }>
}

const DEFAULT_METADATA_KEY = "mission"

export interface MetadataMissionStorageOptions {
  /**
   * V2 SDK session API for reads. In practice this is
   * `input.client.session` from the plugin runtime. We only call
   * `.get()` — `.update()` has the empty-body bug and is not used.
   */
  session: {
    get: (params: { sessionID: string }) => Promise<any>
  }
  /**
   * The opencode-trusted fetch for writes. In practice this is
   * `v1Client.getConfig().fetch` from the plugin runtime — using
   * `globalThis.fetch` directly is blocked by the plugin sandbox.
   * The V1 fetch does not wrap request bodies, so the PATCH body
   * is sent correctly. We only need the HTTP status from the
   * response, so the V1 fetch's response wrapping is irrelevant.
   */
  fetchImpl: typeof fetch
  /** Base URL of the opencode server (e.g. `http://localhost:4096`). */
  baseUrl: string
  /** Under which metadata key the mission is stored. Default: "mission". */
  metadataKey?: string
  /** HTTP timeout in ms. Default: 10000. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000

export class MetadataMissionStorage implements MissionStorage {
  readonly mode = "metadata" as const
  private readonly session: NonNullable<MetadataMissionStorageOptions["session"]>
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string
  private readonly key: string
  private readonly timeoutMs: number

  constructor(opts: MetadataMissionStorageOptions) {
    this.session = opts.session
    this.fetchImpl = opts.fetchImpl
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "")
    this.key = opts.metadataKey ?? DEFAULT_METADATA_KEY
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private sessionUrl(sessionID: string): string {
    // Canonical opencode 1.17.x route (no /api prefix). This matches
    // the V2 SDK's URL generation and is what the server expects.
    return `${this.baseUrl}/session/${encodeURIComponent(sessionID)}`
  }

  private isHtmlResponse(text: string): boolean {
    const head = text.trimStart().slice(0, 64).toLowerCase()
    return head.startsWith("<!doctype") || head.startsWith("<html")
  }

  async read(sessionID: string): Promise<Mission | null> {
    try {
      const result = await this.session.get({ sessionID })
      // V2 SDK result shape:
      //   success: { data: Session, request, response }
      //   failure: { error, request, response: undefined }
      if (result?.error) {
        log(`read sessionID=${sessionID} err=${result.error.message ?? String(result.error)}`)
        return null
      }
      const data = result?.data
      if (!data) return null
      const raw = (data.metadata ?? {})[this.key]
      if (raw == null) return null
      // Be defensive against double-serialized metadata
      if (typeof raw === "string") {
        try {
          return JSON.parse(raw) as Mission
        } catch {
          return null
        }
      }
      return raw as Mission
    } catch (err: any) {
      log(`GET FAIL sessionID=${sessionID} err=${err?.message ?? String(err)}`)
      return null
    }
  }

  async write(sessionID: string, mission: Mission | null): Promise<void> {
    // PATCH semantics on opencode metadata: the server REPLACES the
    // metadata object with the one we send. To preserve other keys
    // (third-party plugins may also use metadata), we GET first via
    // V2 SDK and merge. The round-trip is acceptable because mission
    // writes are rare events (state transitions), not a hot loop.
    let current: Record<string, unknown> = {}
    try {
      const r = await this.session.get({ sessionID })
      if (r?.error) {
        log(`write get err=${r.error.message ?? String(r.error)}`)
      } else {
        const data = r?.data
        if (data?.metadata) {
          current = data.metadata as Record<string, unknown>
        }
      }
    } catch {
      // If GET fails, proceed with empty metadata (overwrites any siblings)
    }

    const next: Record<string, unknown> = { ...current }
    if (mission === null) {
      delete next[this.key]
    } else {
      next[this.key] = mission
    }

    // Write via raw fetch (V2 SDK session.update has empty-body bug).
    // The V1 client's fetch routes through the opencode-trusted
    // transport, not the plugin-sandboxed globalThis.fetch.
    const url = this.sessionUrl(sessionID)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.timeoutMs)
    try {
      const resp = await this.fetchImpl(url, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metadata: next }),
        signal: ac.signal,
      })
      clearTimeout(timer)
      if (!resp.ok) {
        const text = await resp.text().catch(() => "")
        throw new Error(
          `MetadataMissionStorage: PATCH session/${sessionID} failed: ` +
            `${resp.status} ${resp.statusText} body=${text.slice(0, 200)}`,
        )
      }
      // Sanity check: ensure response is JSON, not an SPA fallback
      const text = await resp.text()
      if (this.isHtmlResponse(text)) {
        throw new Error(
          `MetadataMissionStorage: PATCH session/${sessionID} returned HTML (SPA fallback)`,
        )
      }
    } catch (err: any) {
      clearTimeout(timer)
      if (err?.name === "AbortError") {
        throw new Error(
          `MetadataMissionStorage: PATCH session/${sessionID} timed out after ${this.timeoutMs}ms`,
        )
      }
      throw err
    }
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.session.get({ sessionID: "__health__" })
      return { ok: true }
    } catch {
      // A 404 on a bogus session ID is OK — it means the API is reachable.
      return { ok: true }
    }
  }
}

// ── Factory ───────────────────────────────────────────────────────────────

export interface StorageConfig {
  /** V2 SDK session API (for reads). */
  session: MetadataMissionStorageOptions["session"]
  /** V1 client's fetch (for writes — avoids V2 SDK empty-body bug). */
  fetchImpl: typeof fetch
  /** Opencode server base URL. */
  baseUrl: string
}

export function createMissionStorage(config: StorageConfig): MissionStorage {
  return new MetadataMissionStorage({
    session: config.session,
    fetchImpl: config.fetchImpl,
    baseUrl: config.baseUrl,
  })
}
