// ─────────────────────────────────────────────────────────────────────────────
//  Mission storage and session info
//
// 1.17.x removed the legacy PATCH endpoint for arbitrary session metadata.
// We own mission state ourselves in a JSON file under the user's config
// dir, so we are decoupled from opencode server API changes. The storage
// path is built with os.homedir() + path.join() so the same code runs on
// Windows, macOS, and Linux without changes.
//
// For sub-agent routing we need the parent session's ID. The V2 SDK's
// client.session.get() does not substitute the {sessionID} path template
// in 1.17.1 (the server returns 500 with "UnknownError" because it gets the
// literal string "{id}"). We sidestep that bug with a direct raw fetch to
// the canonical API path /api/session/:sessionID that we verified in the
// opencode source (groups/session.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Mission } from "../types.js"
import { log as fileLog } from "./log.js"

const log = (msg: string) => fileLog(`[mission] ${msg}`)

export interface SessionHttpConfig {
  // The V2 SDK client (input.client in the plugin runtime). Used only for
  // the underlying transport's baseUrl when calling the opencode session
  // API. Mission state itself lives in a local JSON file, so SDK methods
  // are not used.
  v2Client: any
  // The plugin's working directory (input.directory). Canonical source for
  // the workspace path, used to namespace storage per project.
  directory: string
}

export interface SessionHttp {
  getSession(
    sessionID: string,
  ): Promise<{ id: string; parentID?: string; metadata: Record<string, unknown> } | null>
  readMission(sessionID: string): Promise<Mission | null>
  writeMission(sessionID: string, mission: Mission | null): Promise<void>
}

const STORAGE_DIR = join(homedir(), ".config", "opencode", "missions")

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
  const { v2Client, directory } = config

  // Helpers that close over the per-plugin config. They live inside the
  // factory (not at module level) so v2Client and directory resolve to
  // the per-plugin instance, not to a TDZ error or an outer undefined.

  function currentProjectSlug(): string {
    // PluginInput.directory is the canonical workspace path. Fall back to
    // SDK-derived values only if the PluginInput field is missing.
    const v1 = v2Client?._client
    const v1Headers = v1?.getConfig?.()?.headers as Record<string, string> | undefined
    const v2Headers = v2Client?.getConfig?.()?.headers as Record<string, string> | undefined
    const raw =
      directory ??
      v1Headers?.["x-opencode-directory"] ??
      v2Headers?.["x-opencode-directory"] ??
      (v1?.getConfig?.() as any)?.directory ??
      (v2Client?.getConfig?.() as any)?.directory
    if (process.env.OPENCODE_MISSION_DEBUG === "1") {
      log(`projectSlug raw=${raw}`)
    }
    return projectSlug(raw)
  }

  function missionPath(sessionID: string): string {
    return join(STORAGE_DIR, currentProjectSlug(), `${sessionID}.json`)
  }

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

  async function readMission(sessionID: string): Promise<Mission | null> {
    const file = missionPath(sessionID)
    if (process.env.OPENCODE_MISSION_DEBUG === "1") {
      log(`READ ${file}`)
    }
    try {
      const text = await readFile(file, "utf8")
      return JSON.parse(text) as Mission
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        if (process.env.OPENCODE_MISSION_DEBUG === "1") {
          log(`READ miss (no file)`)
        }
        return null
      }
      log(`READ FAIL sessionID=${sessionID} err=${err?.message ?? String(err)}`)
      throw err
    }
  }

  async function writeMission(sessionID: string, mission: Mission | null): Promise<void> {
    const file = missionPath(sessionID)
    if (mission === null) {
      // Cancellation: best-effort delete; missing file is fine
      if (process.env.OPENCODE_MISSION_DEBUG === "1") {
        log(`DELETE ${file}`)
      }
      try {
        await unlink(file)
      } catch (err: any) {
        if (err?.code !== "ENOENT") {
          log(`DELETE FAIL sessionID=${sessionID} err=${err?.message ?? String(err)}`)
        }
      }
      return
    }
    const tmp = `${file}.tmp`
    if (process.env.OPENCODE_MISSION_DEBUG === "1") {
      log(`WRITE ${file}`)
    }
    await mkdir(dirname(file), { recursive: true })
    await writeFile(tmp, JSON.stringify(mission, null, 2), "utf8")
    // Atomic on POSIX, mostly atomic on Windows. If the target exists the
    // rename overwrites it, so concurrent readers always see a complete file.
    await rename(tmp, file)
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


