// ─────────────────────────────────────────────────────────────────────────────
//  MissionStorage
//
// Single implementation: MetadataMissionStorage. Stores Mission records
// inside the opencode session's typed metadata JSON column via raw
// fetch against the canonical PATCH /api/session/:sessionID endpoint.
//
// Why raw fetch (not the V2 SDK's session.update):
//
//   - The V2 SDK generated for opencode 1.17.11 sends a request body
//     that the server's payload validator rejects with "Expected
//     object, got undefined" (verified empirically — the SDK appears
//     to emit an empty body even when metadata is set).
//   - session-http.ts already uses raw fetch against /api/session/
//     for sub-agent parent lookups, and that path works in the user's
//     sandboxed plugin process.
//   - We reuse the V1 client's fetch (passed in by the plugin
//     runtime) instead of `globalThis.fetch`, because the V1 fetch
//     routes through the opencode-trusted transport and is not
//     blocked by the plugin sandbox.
//
// Requires opencode >= 1.17.11 (the PATCH endpoint has shipped there).
// A PATCH failure surfaces as a hard error so the user notices —
// silent fallback would hide a misconfiguration.
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
   * The opencode-trusted fetch implementation. In practice this is
   * `v1Client.getConfig().fetch` from the plugin runtime — using
   * `globalThis.fetch` directly is blocked by the plugin sandbox.
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
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string
  private readonly key: string
  private readonly timeoutMs: number

  constructor(opts: MetadataMissionStorageOptions) {
    this.fetchImpl = opts.fetchImpl
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "")
    this.key = opts.metadataKey ?? DEFAULT_METADATA_KEY
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private sessionUrl(sessionID: string): string {
    return `${this.baseUrl}/api/session/${encodeURIComponent(sessionID)}`
  }

  private isHtmlResponse(text: string): boolean {
    const head = text.trimStart().slice(0, 64).toLowerCase()
    return head.startsWith("<!doctype") || head.startsWith("<html")
  }

  private async getSessionMetadata(
    sessionID: string,
  ): Promise<Record<string, unknown> | null> {
    const url = this.sessionUrl(sessionID)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.timeoutMs)
    try {
      const resp = await this.fetchImpl(url, {
        method: "GET",
        headers: this.v1Headers(),
        signal: ac.signal,
      })
      if (!resp.ok) return null
      const text = await resp.text()
      if (this.isHtmlResponse(text)) return null // HTML guard (SPA fallback)
      const data = JSON.parse(text)
      return (data?.metadata ?? {}) as Record<string, unknown>
    } catch (err: any) {
      log(
        `GET FAIL sessionID=${sessionID} err=${err?.message ?? String(err)}`,
      )
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  // The V1 client injects its own auth/cookie headers; we accept them
  // in headers() for clean injection.
  private v1Headers(): Record<string, string> {
    return {}
  }

  async read(sessionID: string): Promise<Mission | null> {
    const metadata = await this.getSessionMetadata(sessionID)
    if (!metadata) return null
    const raw = metadata[this.key]
    if (raw == null) return null
    // The server returns parsed JSON, but be defensive: some intermediate
    // layers may round-trip as a string. Handle both.
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw) as Mission
      } catch {
        return null
      }
    }
    return raw as Mission
  }

  async write(sessionID: string, mission: Mission | null): Promise<void> {
    // PATCH semantics on opencode metadata: the server REPLACES the
    // metadata object with the one we send. To preserve other keys
    // (third-party plugins may also use metadata), we GET first and
    // merge. The round-trip is acceptable because mission writes are
    // rare events (state transitions), not a hot loop.
    const current = (await this.getSessionMetadata(sessionID)) ?? {}
    const next: Record<string, unknown> = { ...current }
    if (mission === null) {
      delete next[this.key]
    } else {
      next[this.key] = mission
    }
    const url = this.sessionUrl(sessionID)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.timeoutMs)
    let status = 0
    let body = ""
    try {
      const resp = await this.fetchImpl(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...this.v1Headers() },
        body: JSON.stringify({ metadata: next }),
        signal: ac.signal,
      })
      status = resp.status
      body = await resp.text()
      if (!resp.ok) {
        throw new Error(
          `MetadataMissionStorage: PATCH /api/session/${sessionID} ` +
            `returned status ${status}: ${body.slice(0, 200)}`,
        )
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.fetchImpl(`${this.baseUrl}/api/session`, {
        method: "GET",
        headers: this.v1Headers(),
      })
      return { ok: true, detail: this.baseUrl }
    } catch (err: any) {
      return { ok: false, detail: err?.message ?? String(err) }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Factory
// ─────────────────────────────────────────────────────────────────────────────

export interface StorageConfig {
  baseUrl: string
  fetchImpl: typeof fetch
}

export function createMissionStorage(config: StorageConfig): MissionStorage {
  return new MetadataMissionStorage({
    baseUrl: config.baseUrl,
    fetchImpl: config.fetchImpl,
  })
}
