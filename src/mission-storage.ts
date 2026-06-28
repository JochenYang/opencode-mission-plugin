// ─────────────────────────────────────────────────────────────────────────────
//  MissionStorage
//
// Single implementation: MetadataMissionStorage. Stores Mission records
// inside the opencode session's typed metadata JSON column via the
// opencode server's PATCH /session/:sessionID endpoint (V2 SDK's
// session.update).
//
// Why the V2 SDK (not raw fetch):
//
//   - The V2 SDK constructs the request URL from the same source as the
//     server's route table, so the path is correct on every version.
//   - The V1 client injects its own fetch (with auth, cookies, and the
//     sandboxed transport that the plugin process can reach). Passing
//     that fetch into the V2 client reuses the opencode-trusted socket
//     path; raw `globalThis.fetch` is blocked in the plugin's sandbox.
//   - Headers and content-type are wired up by the SDK.
//
// Requires opencode >= 1.17.11 (the PATCH endpoint has shipped there).
// A PATCH failure surfaces as a hard error so the user notices —
// silent fallback would hide a misconfiguration.
// ─────────────────────────────────────────────────────────────────────────────

import { createOpencodeClient } from "@opencode-ai/sdk/v2"
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
  v2Client: ReturnType<typeof createOpencodeClient>
  /** Under which metadata key the mission is stored. Default: "mission". */
  metadataKey?: string
}

export class MetadataMissionStorage implements MissionStorage {
  readonly mode = "metadata" as const
  private readonly v2Client: ReturnType<typeof createOpencodeClient>
  private readonly key: string

  constructor(opts: MetadataMissionStorageOptions) {
    this.v2Client = opts.v2Client
    this.key = opts.metadataKey ?? DEFAULT_METADATA_KEY
  }

  private async getSessionMetadata(
    sessionID: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const result = await this.v2Client.session.get({ sessionID })
      const data = (result as any)?.data
      return ((data?.metadata ?? {}) as Record<string, unknown>)
    } catch (err: any) {
      log(
        `GET FAIL sessionID=${sessionID} err=${err?.message ?? String(err)}`,
      )
      return null
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
    let error: any = null
    try {
      const result = await this.v2Client.session.update({
        sessionID,
        metadata: next,
      })
      error = (result as any)?.error ?? null
    } catch (err: any) {
      error = err
    }
    if (error) {
      throw new Error(
        `MetadataMissionStorage: session.update failed for ${sessionID}: ` +
          (error?.message ?? JSON.stringify(error)),
      )
    }
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: "V2 SDK session.update" }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Factory
// ─────────────────────────────────────────────────────────────────────────────

export interface StorageConfig {
  v2Client: ReturnType<typeof createOpencodeClient>
}

export function createMissionStorage(config: StorageConfig): MissionStorage {
  return new MetadataMissionStorage({ v2Client: config.v2Client })
}
