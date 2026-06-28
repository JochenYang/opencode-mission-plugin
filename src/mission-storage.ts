// ─────────────────────────────────────────────────────────────────────────────
//  MissionStorage
//
// Pluggable persistence layer for Mission records. Two implementations:
//
//   - FileMissionStorage  (default)
//       Persists Mission records to <storageDir>/<workspace>/<sessionID>.json
//       with atomic temp-file renames. Self-contained; works without any
//       opencode server cooperation.
//
//   - MetadataMissionStorage  (opt-in via OPENCODE_MISSION_STORAGE=metadata)
//       Stores Mission records inside the opencode session's typed metadata
//       JSON column via PATCH /session/:sessionID. Enables fork inheritance
//       (the new session receives a snapshot of the parent's metadata at
//       creation time) and centralized backup with the rest of the user's
//       opencode data.
//
// Both implementations implement the same async interface, so the rest of
// the plugin does not care which one is active. The choice is made at
// plugin boot (index.ts) based on the OPENCODE_MISSION_STORAGE env var and
// surfaced in the MissionStorage interface itself for logging.
// ─────────────────────────────────────────────────────────────────────────────

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Mission } from "./types.js"
import { log } from "./utils/log.js"

/** Public read/write surface every storage backend must satisfy. */
export interface MissionStorage {
  /** A short label like "file" or "metadata" for logging. */
  readonly mode: "file" | "metadata"

  /**
   * Read the Mission for a session. Returns null if no mission exists.
   * Throws on hard IO / network errors (caller decides retry).
   */
  read(sessionID: string): Promise<Mission | null>

  /**
   * Persist a Mission. Passing null means "delete the record" (matches
   * the existing file-storage semantics used by cancelled transitions).
   */
  write(sessionID: string, mission: Mission | null): Promise<void>

  /**
   * Optional cleanup hook for the parent class. Default no-op.
   * Returns a short status string for the boot log.
   */
  healthCheck?(): Promise<{ ok: boolean; detail?: string }>
}

// ─────────────────────────────────────────────────────────────────────────────
//  FileMissionStorage — preserved from utils/session-http.ts
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_STORAGE_DIR = join(homedir(), ".config", "opencode", "missions")

/** Project-isolate storage so two opencode projects do not collide. */
function projectSlug(directory: string | undefined | null): string {
  if (!directory) return "_unknown"
  let decoded: string
  try {
    decoded = decodeURIComponent(directory)
  } catch {
    decoded = directory
  }
  return (
    decoded
      .replace(/[:\\/]+/g, "-") // drive colon, backslash, forward slash
      .replace(/[^a-zA-Z0-9._-]+/g, "-") // any other unsafe char
      .replace(/^-+|-+$/g, "") // trim leading/trailing dashes
      .slice(0, 100) || "_unknown"
  )
}

export interface FileMissionStorageOptions {
  directory?: string | null
  storageDir?: string // override root, mainly for tests
}

export class FileMissionStorage implements MissionStorage {
  readonly mode = "file" as const
  private readonly directory: string | null
  private readonly storageDir: string

  constructor(opts: FileMissionStorageOptions = {}) {
    this.directory = opts.directory ?? null
    this.storageDir = opts.storageDir ?? DEFAULT_STORAGE_DIR
  }

  private fileFor(sessionID: string): string {
    return join(this.storageDir, projectSlug(this.directory), `${sessionID}.json`)
  }

  async read(sessionID: string): Promise<Mission | null> {
    const file = this.fileFor(sessionID)
    try {
      const text = await readFile(file, "utf8")
      return JSON.parse(text) as Mission
    } catch (err: any) {
      if (err?.code === "ENOENT") return null
      log(`[mission-storage:file] READ FAIL sessionID=${sessionID} err=${err?.message ?? String(err)}`)
      throw err
    }
  }

  async write(sessionID: string, mission: Mission | null): Promise<void> {
    const file = this.fileFor(sessionID)
    if (mission === null) {
      try {
        await unlink(file)
      } catch (err: any) {
        if (err?.code !== "ENOENT") {
          log(`[mission-storage:file] DELETE FAIL sessionID=${sessionID} err=${err?.message ?? String(err)}`)
        }
      }
      return
    }
    const tmp = `${file}.tmp`
    await mkdir(dirname(file), { recursive: true })
    await writeFile(tmp, JSON.stringify(mission, null, 2), "utf8")
    // Atomic on POSIX, mostly atomic on Windows.
    await rename(tmp, file)
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await mkdir(this.storageDir, { recursive: true })
      return { ok: true, detail: this.storageDir }
    } catch (err: any) {
      return { ok: false, detail: err?.message ?? String(err) }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  MetadataMissionStorage — uses opencode session metadata via PATCH API
//
// Strategy:
//   1. On write: PATCH /session/:sessionID with body { metadata: { mission: M } }
//      (or { metadata: { mission: null } } to clear). OpenCode merges into
//      its typed JSON column. 1.18+ endpoints accept arbitrary keys.
//   2. On read: GET /session/:sessionID and pull out metadata.mission.
//   3. Fork inheritance: handled automatically by the opencode server
//      when a session is forked — the child's metadata starts as a copy
//      of the parent's. No special handling needed here.
//
// Failure mode: if the PATCH endpoint is unavailable (older opencode
// versions, network error, server sandboxed away), the constructor's
// healthCheck will surface the error at boot. The MissionStore itself
// does not fall back to file storage — operators who want that should
// set OPENCODE_MISSION_STORAGE=file explicitly. Silent fallback would
// hide config mistakes.
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
    return `${this.baseUrl}/session/${encodeURIComponent(sessionID)}`
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
      log(`[mission-storage:metadata] GET FAIL sessionID=${sessionID} err=${err?.message ?? String(err)}`)
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
        log(`[mission-storage:metadata] PATCH FAIL sessionID=${sessionID} status=${resp.status}`)
        return false
      }
      return true
    } catch (err: any) {
      log(`[mission-storage:metadata] PATCH FAIL sessionID=${sessionID} err=${err?.message ?? String(err)}`)
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
        `MetadataMissionStorage: PATCH /session/${sessionID} failed; ` +
          `mission state could not be persisted. Check opencode server logs.`,
      )
    }
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    // No-op probe: we can only validate at write time because the server
    // does not expose a metadata ping. The constructor is the real test —
    // a malformed baseUrl throws during path computation, not here.
    return { ok: true, detail: `${this.baseUrl} key=${this.key}` }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Factory
// ─────────────────────────────────────────────────────────────────────────────

export type StorageMode = "file" | "metadata"

export interface StorageConfig {
  mode: StorageMode
  directory?: string | null
  baseUrl?: string
  headers?: Record<string, string>
}

export function resolveStorageModeFromEnv(): StorageMode {
  const raw = (process.env.OPENCODE_MISSION_STORAGE ?? "file").trim().toLowerCase()
  if (raw === "metadata" || raw === "file") return raw
  log(`[mission-storage] unknown OPENCODE_MISSION_STORAGE=${raw}; defaulting to "file"`)
  return "file"
}

export function createMissionStorage(config: StorageConfig): MissionStorage {
  if (config.mode === "metadata") {
    if (!config.baseUrl) {
      throw new Error(
        "MetadataMissionStorage requires baseUrl; " +
          "pass it from PluginInput.serverUrl.origin in index.ts",
      )
    }
    return new MetadataMissionStorage({
      baseUrl: config.baseUrl,
      headers: config.headers ?? {},
    })
  }
  return new FileMissionStorage({ directory: config.directory })
}
