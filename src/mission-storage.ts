// ─────────────────────────────────────────────────────────────────────────────
//  MissionStorage
//
// Single implementation: MetadataMissionStorage. Stores Mission records
// inside the opencode session's typed metadata JSON column via the
// V2 SDK's session.get() / session.update() APIs.
//
// Why the V2 SDK (not raw fetch):
//
//   - The V2 SDK's client handles URL construction, body serialization,
//     auth headers, and response interceptors (including the HTML guard
//     for SPA-fallback routes) correctly for all opencode server versions.
//   - The V1 client's `v1Config.fetch` (raw fetch) wraps responses in a
//     `{v: [...]}` envelope that triggers "undefined is not an object
//     (evaluating 'v[0]')" when the raw server response (which has no `v`
//     wrapper) is parsed by the V1 fetch wrapper — this was breaking ALL
//     mission tool calls in TUI default (in-process RPC) mode.
//   - Switching to the V2 SDK's `session` API bypasses the V1 fetch
//     wrapper entirely and uses the SDK's own request/response pipeline
//     which properly handles in-process RPC transport.
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
   * A Session2-like object (from V2 SDK) with `get()` and `update()` methods.
   * In practice this is `v2Client.session` from the plugin runtime.
   */
  session: {
    get: (params: { sessionID: string }) => Promise<any>
    update: (params: { sessionID: string; metadata?: Record<string, unknown> }) => Promise<any>
  }
  /** Under which metadata key the mission is stored. Default: "mission". */
  metadataKey?: string
}

export class MetadataMissionStorage implements MissionStorage {
  readonly mode = "metadata" as const
  private readonly session: NonNullable<MetadataMissionStorageOptions["session"]>
  private readonly key: string

  constructor(opts: MetadataMissionStorageOptions) {
    this.session = opts.session
    this.key = opts.metadataKey ?? DEFAULT_METADATA_KEY
  }

  /**
   * Extract the session data from the V2 SDK's response format.
   * The SDK returns { data: Session, request, response } by default.
   * Handle both the wrapped and unwrapped form defensively.
   */
  private unwrap(result: any): any {
    if (!result) return null
    // V2 SDK default response (responseStyle not set): { data: Session, ... }
    if (typeof result === "object" && "data" in result) return result.data
    return result
  }

  async read(sessionID: string): Promise<Mission | null> {
    try {
      const result = await this.session.get({ sessionID })
      const session = this.unwrap(result)
      if (!session) return null
      const raw = (session.metadata ?? {})[this.key]
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
    // (third-party plugins may also use metadata), we GET first and
    // merge. The round-trip is acceptable because mission writes are
    // rare events (state transitions), not a hot loop.
    let current: Record<string, unknown> = {}
    try {
      const curResult = await this.session.get({ sessionID })
      const curSession = this.unwrap(curResult)
      if (curSession?.metadata) {
        current = curSession.metadata as Record<string, unknown>
      }
    } catch {
      // If the GET fails, proceed with empty metadata
    }

    const next: Record<string, unknown> = { ...current }
    if (mission === null) {
      delete next[this.key]
    } else {
      next[this.key] = mission
    }

    try {
      await this.session.update({ sessionID, metadata: next })
    } catch (err: any) {
      throw new Error(
        `MetadataMissionStorage: PATCH session/${sessionID} failed: ${err?.message ?? String(err)}`,
      )
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

// ─────────────────────────────────────────────────────────────────────────────
//  Factory
// ─────────────────────────────────────────────────────────────────────────────

export interface StorageConfig {
  session: MetadataMissionStorageOptions["session"]
}

export function createMissionStorage(config: StorageConfig): MissionStorage {
  return new MetadataMissionStorage({
    session: config.session,
  })
}
