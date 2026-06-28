// ─────────────────────────────────────────────────────────────────────────────
//  MissionStorage
//
// Primary: FileMissionStorage. Stores Mission records in a local JSON file
// at `~/.config/opencode/missions.json` (or `%APPDATA%/opencode/missions.json`
// on Windows), with atomic tmp+rename writes.
//
// Fallback/legacy: MetadataMissionStorage. Stores Mission records inside the
// opencode session's typed metadata JSON column via the V2 SDK's
// session.get() / session.update() APIs. Not used by default because the
// PATCH /session/{id} endpoint returns 500 on opencode 1.17.11
// (UnknownError defect in the event chain).
//
// Why file-based:
//
//   - The PATCH /session/{id} route in opencode 1.17.11 throws an
//     unhandled defect (UnknownError / 500) during the event publication
//     chain, which the errorLayer middleware catches and returns as
//     "Unexpected server error". Other working goal plugins avoid PATCH
//     for the same reason — they use local JSON file storage.
//   - File storage: no PATCH, no server-side error, no V1/V2 SDK
//     transport mismatch to debug.
//   - Atomic writes (tmp + rename) are safe against concurrent mutations;
//     a serialization queue (mutex) prevents races.
//
// Trade-offs vs metadata storage:
//
//   - Pro: works on every opencode version, no PATCH endpoint dependency
//   - Pro: no V1/V2 SDK transport issues, no v[0] envelope bugs
//   - Con: no automatic session-fork inheritance (file stays, not copied
//     to forked sessions)
//   - Con: mission state is not backed up with opencode's session DB
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Mission } from "./types.js"
import { log } from "./utils/log.js"

// ── Interface ────────────────────────────────────────────────────────────────

/** Public read/write surface for mission persistence. */
export interface MissionStorage {
  /** A short label for logging. */
  readonly mode: string

  /**
   * Read the Mission for a session. Returns null if no mission exists.
   */
  read(sessionID: string): Promise<Mission | null>

  /**
   * Persist a Mission. Passing null means "delete the record"
   * (matches the cancelled transition semantics).
   */
  write(sessionID: string, mission: Mission | null): Promise<void>

  /**
   * Find the most recent active mission in this storage backend.
   * Used by the verify subagent as a fallback when the V2 SDK
   * session.get() fails to return the parent session info.
   * Returns null if no active mission exists.
   */
  findActiveMission?(): Promise<{ sessionID: string; mission: Mission } | null>

  /**
   * Optional boot-time health probe. Default no-op.
   */
  healthCheck?(): Promise<{ ok: boolean; detail?: string }>
}

// ── Constants ────────────────────────────────────────────────────────────────

const STORAGE_VERSION = 1
const FILE_NAME = "missions.json"

interface StorageFile {
  version: typeof STORAGE_VERSION
  missions: Record<string, Mission>
}

// ── FileMissionStorage ──────────────────────────────────────────────────────

export interface FileMissionStorageOptions {
  /**
   * Absolute directory path. If provided, the file is stored at
   * `<directory>/.opencode/missions.json` (workspace-scoped).
   * If omitted, uses `~/.config/opencode/missions.json` (global).
   */
  directory?: string | null
}

export class FileMissionStorage implements MissionStorage {
  readonly mode: string = "file"
  private readonly filePath: string
  /** Serialization mutex — only one write mutation at a time. */
  private mutex: Promise<void> = Promise.resolve()

  constructor(opts?: FileMissionStorageOptions) {
    const baseDir = opts?.directory?.trim()
      ? join(opts.directory.trim(), ".opencode")
      : join(homedir(), ".config", "opencode")

    this.filePath = join(baseDir, FILE_NAME)
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  /** Ensure the parent directory exists. */
  private ensureDir(): void {
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }

  /** Read the full storage file, or return the empty state if missing/corrupt. */
  private readAll(): StorageFile {
    if (!existsSync(this.filePath)) {
      return { version: STORAGE_VERSION, missions: {} }
    }
    try {
      const raw = readFileSync(this.filePath, "utf-8")
      const parsed = JSON.parse(raw) as StorageFile
      if (parsed?.version === STORAGE_VERSION && parsed?.missions) {
        return parsed
      }
      // Migrate: stale format -> reset
      return { version: STORAGE_VERSION, missions: {} }
    } catch {
      log(`FileMissionStorage: corrupt file at ${this.filePath}, resetting`)
      return { version: STORAGE_VERSION, missions: {} }
    }
  }

  /** Atomic write: tmp file + rename. Synchronous to avoid races on the file handle. */
  private writeAll(data: StorageFile): void {
    this.ensureDir()
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8")
    renameSync(tmp, this.filePath)
  }

  /** Enqueue a mutation to prevent concurrent writes. */
  private enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.mutex.then(fn, fn)
    // Chain synchronously: previous result doesn't matter, only ordering.
    this.mutex = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  // ── Public API ────────────────────────────────────────────────────────

  async read(sessionID: string): Promise<Mission | null> {
    try {
      const all = this.readAll()
      return all.missions[sessionID] ?? null
    } catch {
      return null
    }
  }

  async write(sessionID: string, mission: Mission | null): Promise<void> {
    return this.enqueue(() => {
      const all = this.readAll()
      if (mission === null) {
        delete all.missions[sessionID]
      } else {
        all.missions[sessionID] = mission
      }
      this.writeAll(all)
    })
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      this.ensureDir()
      return { ok: true }
    } catch (err: any) {
      return { ok: false, detail: err?.message ?? String(err) }
    }
  }

  /**
   * Scan the local missions file and return the most recent mission with
   * status === "active". This is the fallback for the verify subagent when
   * the V2 SDK's session.get() returns null (so the subagent has no way to
   * find its parent session ID through the SDK). The file is workspace-
   * scoped, so a subagent running in the same workspace can read it
   * directly without any network round-trip.
   *
   * Returns null if no active mission exists in this workspace.
   */
  async findActiveMission(): Promise<{ sessionID: string; mission: Mission } | null> {
    try {
      const all = this.readAll()
      const activeEntries = Object.entries(all.missions).filter(
        ([, m]) => m.status === "active",
      )
      if (activeEntries.length === 0) return null
      // Most recently created wins (stable tie-breaker: lexicographic on
      // sessionID so tests are deterministic).
      activeEntries.sort(([, a], [, b]) => {
        if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt
        return a.id.localeCompare(b.id)
      })
      const [sessionID, mission] = activeEntries[0]
      return { sessionID, mission }
    } catch {
      return null
    }
  }
}

// ── Legacy: MetadataMissionStorage ──────────────────────────────────────────

const DEFAULT_METADATA_KEY = "mission"

export interface MetadataMissionStorageOptions {
  session: {
    get: (params: { sessionID: string }) => Promise<any>
    update: (params: { sessionID: string; metadata?: Record<string, unknown> }) => Promise<any>
  }
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

  private unwrap(result: any): any {
    if (!result) return null
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
    let current: Record<string, unknown> = {}
    try {
      const result = await this.session.get({ sessionID })
      const session = this.unwrap(result)
      if (session?.metadata) {
        current = session.metadata as Record<string, unknown>
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

    try {
      const result = await this.session.update({ sessionID, metadata: next })
      if (result?.error) {
        const e = result.error
        const msg = e?.message ?? (typeof e === "string" ? e : JSON.stringify(e))
        throw new Error(`MetadataMissionStorage: PATCH session/${sessionID} failed: ${msg}`)
      }
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
      return { ok: true }
    }
  }
}

// ── Factory ───────────────────────────────────────────────────────────────

export interface StorageConfig {
  /**
   * Optional: the workspace directory (PluginInput.directory).
   * When set, missions are stored at `<directory>/.opencode/missions.json`.
   * When absent, store globally at `~/.config/opencode/missions.json`.
   */
  directory?: string | null
}

export function createMissionStorage(config?: StorageConfig): MissionStorage {
  return new FileMissionStorage({ directory: config?.directory })
}
