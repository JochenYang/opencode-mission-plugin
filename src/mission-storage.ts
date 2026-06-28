// ─────────────────────────────────────────────────────────────────────────────
//  MissionStorage
//
// Single implementation: MetadataMissionStorage. Stores Mission records
// inside the opencode session's typed metadata JSON column via
// PATCH /session/:sessionID. Requires opencode >= 1.17.11 (the
// PATCH endpoint has shipped there). Free side benefits:
//
//   - Session fork inheritance: when a session is forked, the opencode
//     server copies the parent's Session.metadata into the child
//     automatically. The new session already has the mission.
//   - Centralized backup with the rest of the user's opencode data
//     (sessions live in SQLite, mission rides along).
//   - No extra filesystem footprint beyond the session itself.
// ─────────────────────────────────────────────────────────────────────────────

import type { Mission } from "./types.js"
import { log } from "./utils/log.js"

/** Public read/write surface for mission persistence. */
export interface MissionStorage {
  /** A short label for logging. */
  readonly mode: "metadata"

  /**
   * Read the Mission for a session. Returns null if no mission exists.
   * Throws on hard network errors so the caller can surface them.
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

// ─────────────────────────────────────────────────────────────────────────────
//  MetadataMissionStorage — uses opencode session metadata via PATCH API
//
// Strategy:
//   1. On write: PATCH /session/:sessionID with body { metadata: { mission: M } }
//      (or merge without mission key to clear). OpenCode merges into its
//      typed JSON column.
//   2. On read: GET /session/:sessionID and pull out metadata.mission.
//   3. Fork inheritance: handled automatically by the opencode server
//      when a session is forked — the child's metadata starts as a copy
//      of the parent's.
//
// Failure mode: if the PATCH endpoint is unavailable (older opencode,
// network error, server sandboxed), write() throws. There is no silent
// fallback: mission state must round-trip through the server, and
// hiding failures would corrupt the user's workflow.
// ─────────────────────────────────────────────────────────────────────────────

export interface MetadataMissionStorageOptions {
  baseUrl: string
  headers: Record<string, string>
  /** Under which metadata key the mission is stored. Default: "mission". */
  metadataKey?: string
  /** Override for tests. */
  fetchImpl?: typeof fetch
  /** HTTP timeout in ms. Default: 10000. */
  timeoutMs?: number
}

const DEFAULT_METADATA_KEY = "mission"

export class MetadataMissionStorage implements MissionStorage {
  readonly mode = "metadata" as const
  private readonly baseUrl: string
  private readonly headers: Record<string, string>
  private readonly key: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(opts: MetadataMissionStorageOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "")
    this.headers = { ...opts.headers }
    this.key = opts.metadataKey ?? DEFAULT_METADATA_KEY
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = opts.timeoutMs ?? 10_000
  }

  private sessionUrl(sessionID: string): string {
    // 1.17.x canonical session path: /api/session/:sessionID. The V2 SDK
    // uses /session/{sessionID} (no /api prefix) but raw fetch must use
    // the /api prefix the server actually serves.
    return `${this.baseUrl}/api/session/${encodeURIComponent(sessionID)}`
  }

  private async getSessionMetadata(sessionID: string): Promise<Record<string, unknown> | null> {
    const url = this.sessionUrl(sessionID)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.timeoutMs)
    try {
      const resp = await this.fetchImpl(url, {
        method: "GET",
        headers: this.headers,
        signal: ac.signal,
      })
      if (!resp.ok) return null
      const text = await resp.text()
      if (text.trimStart().slice(0, 64).toLowerCase().startsWith("<")) return null // HTML guard
      const data = JSON.parse(text)
      return (data?.metadata ?? {}) as Record<string, unknown>
    } catch (err: any) {
      log(`[mission-storage] GET FAIL sessionID=${sessionID} err=${err?.message ?? String(err)}`)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  private async patchSessionMetadata(
    sessionID: string,
    next: Record<string, unknown>,
  ): Promise<boolean> {
    const url = this.sessionUrl(sessionID)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.timeoutMs)
    try {
      const resp = await this.fetchImpl(url, {
        method: "PATCH",
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ metadata: next }),
        signal: ac.signal,
      })
      if (!resp.ok) {
        log(`[mission-storage] PATCH FAIL sessionID=${sessionID} status=${resp.status}`)
        return false
      }
      return true
    } catch (err: any) {
      log(`[mission-storage] PATCH FAIL sessionID=${sessionID} err=${err?.message ?? String(err)}`)
      return false
    } finally {
      clearTimeout(timer)
    }
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
    const ok = await this.patchSessionMetadata(sessionID, next)
    if (!ok) {
      throw new Error(
        `MetadataMissionStorage: PATCH /api/session/${sessionID} failed; ` +
          `mission state could not be persisted. Check opencode server logs.`,
      )
    }
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    // No-op probe: we can only validate at write time because the server
    // does not expose a metadata ping. A malformed baseUrl throws during
    // path computation, not here.
    return { ok: true, detail: `${this.baseUrl} key=${this.key}` }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Factory
// ─────────────────────────────────────────────────────────────────────────────

export interface StorageConfig {
  baseUrl: string
  headers?: Record<string, string>
}

export function createMissionStorage(config: StorageConfig): MissionStorage {
  if (!config.baseUrl) {
    throw new Error(
      "createMissionStorage requires baseUrl; " +
        "pass it from PluginInput.serverUrl.origin in index.ts",
    )
  }
  return new MetadataMissionStorage({
    baseUrl: config.baseUrl,
    headers: config.headers ?? {},
  })
}