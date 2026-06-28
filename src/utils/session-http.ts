// ─────────────────────────────────────────────────────────────────────────────
//  Session info lookup (mission storage is delegated to MissionStorage)
//
// For sub-agent routing we need the parent session's ID. The V2 SDK's
// client.session.get() does not substitute the {sessionID} path template
// in 1.17.1 (the server returns 500 with "UnknownError" because it gets the
// literal string "{id}"). We sidestep that bug with a direct raw fetch to
// the canonical API path /api/session/:sessionID that we verified in the
// opencode source (groups/session.ts).
//
// Mission persistence is now handled by the MissionStorage abstraction
// (see mission-storage.ts). The two thin methods readMission / writeMission
// remain on SessionHttp as a compatibility shim that delegates to the
// provided storage backend, so existing call sites (MissionStore, hooks,
// tools) can keep using one dependency injection without churn. New code
// should depend on MissionStorage directly.
// ─────────────────────────────────────────────────────────────────────────────

import type { Mission } from "../types.js"
import type { MissionStorage } from "../mission-storage.js"
import { log as fileLog } from "./log.js"

const log = (msg: string) => fileLog(`[mission] ${msg}`)

export interface SessionHttpConfig {
  // The V2 SDK client (input.client in the plugin runtime). Used only for
  // the underlying transport's baseUrl when calling the opencode session
  // API. Mission state itself is handled by the storage backend.
  v2Client: any
  // The plugin's working directory (input.directory). Canonical source for
  // the workspace path, used to namespace storage per project.
  directory: string
  // Mission persistence backend (file or metadata). Required.
  storage: MissionStorage
}

export interface SessionHttp {
  getSession(
    sessionID: string,
  ): Promise<{ id: string; parentID?: string; metadata: Record<string, unknown> } | null>
  /** @deprecated delegate to the provided MissionStorage directly. */
  readMission(sessionID: string): Promise<Mission | null>
  /** @deprecated delegate to the provided MissionStorage directly. */
  writeMission(sessionID: string, mission: Mission | null): Promise<void>
}

// Project-isolate storage so two opencode projects do not collide.
// The opencode runtime sends the workspace directory in the
// x-opencode-directory header (URL-encoded). We sanitize it into a
// filesystem-safe slug and use it as a subdirectory under STORAGE_DIR.
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

function stripSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s
}

function isHtmlResponse(text: string): boolean {
  const head = text.trimStart().slice(0, 64).toLowerCase()
  return head.startsWith("<!doctype") || head.startsWith("<html")
}

export function createSessionHttp(config: SessionHttpConfig): SessionHttp {
  const { v2Client, storage } = config

  function clientHeaders(): Record<string, string> {
    const v1 = v2Client?._client
    const h = v1?.getConfig?.()?.headers ?? v2Client?.getConfig?.()?.headers
    return h && typeof h === "object" ? { ...h } : {}
  }

  function baseUrl(): string {
    return (
      v2Client?._client?.getConfig?.()?.baseUrl ??
      v2Client?.getConfig?.()?.baseUrl ??
      "http://localhost:4096"
    )
  }

  async function getSession(sessionID: string) {
    // 1.17.x canonical session path: /api/session/:sessionID (verified in
    // packages/server/src/groups/session.ts). globalThis.fetch avoids both
    // the V2 SDK's "{sessionID}" path-template bug and the V1 client's
    // fetch-wrapper "v[0]" error on raw responses.
    const url = `${stripSlash(baseUrl())}/api/session/${encodeURIComponent(sessionID)}`
    if (process.env.OPENCODE_MISSION_DEBUG === "1") {
      log(`GET ${url}`)
    }
    try {
      const response = await globalThis.fetch(url, {
        method: "GET",
        headers: clientHeaders(),
      })
      if (!response.ok) {
        throw new Error(`GET ${url} returned status ${response.status}`)
      }
      const text = await response.text()
      if (isHtmlResponse(text)) {
        throw new Error(`Session API at ${url} returned HTML; expected JSON.`)
      }
      const data = JSON.parse(text)
      if (!data.id) {
        throw new Error(`Session API returned no id: ${text.slice(0, 200)}`)
      }
      if (process.env.OPENCODE_MISSION_DEBUG === "1") {
        log(`GET ok parentID=${data.parentID ?? "(none)"}`)
      }
      return {
        id: data.id,
        parentID: data.parentID,
        metadata: (data.metadata ?? {}) as Record<string, unknown>,
      }
    } catch (err: any) {
      if (process.env.OPENCODE_MISSION_DEBUG === "1") {
        log(`GET FAIL sessionID=${sessionID} err=${err?.message ?? String(err)}`)
      }
      return null
    }
  }

  // Thin compatibility shims. Callers should prefer MissionStorage
  // directly in new code; these are kept so existing MissionStore and
  // hook call sites do not need to be touched in this refactor.
  async function readMission(sessionID: string): Promise<Mission | null> {
    return storage.read(sessionID)
  }

  async function writeMission(sessionID: string, mission: Mission | null): Promise<void> {
    return storage.write(sessionID, mission)
  }

  return { getSession, readMission, writeMission }
}

// Kept for callers that still hold a reference; in 1.17.x the runtime injects
// a V2 SDK client and the V1 client (input.client._client) is no longer the
// canonical transport. We retain the export so the build does not break
// elsewhere, but it is no longer used for storage or session lookup.
export function extractV1Client(inputClient: unknown): any {
  return (inputClient as any)?._client
}

// Re-export the slug helper so unit tests can verify the path layout
// without importing the storage module.
export const __test__ = { projectSlug }


