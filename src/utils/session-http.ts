// ─────────────────────────────────────────────────────────────────────────────
//  Session HTTP utility
//
// Uses the V1 HeyApi client injected by the plugin runtime (input.client._client).
// The V1 client wraps fetch with proper baseUrl, headers, auth, and response
// parsing. This sidesteps any direct fetch() issues.
//
// Note: V1 SessionUpdate body type only declares { title }, but the server
// (opencode 1.16.x) also accepts { metadata }. We pass metadata via a cast.
// ─────────────────────────────────────────────────────────────────────────────

import type { Mission } from "../types.js"

export interface SessionHttpConfig {
  v1Client: any
  baseUrl: string
}

export interface SessionHttp {
  getSession(sessionID: string): Promise<{ id: string; parentID?: string; metadata: Record<string, unknown> } | null>
  readMission(sessionID: string): Promise<Mission | null>
  writeMission(sessionID: string, mission: Mission | null): Promise<void>
}

const METADATA_KEY = "missionPro" as const

export function createSessionHttp(config: SessionHttpConfig): SessionHttp {
  const { v1Client, baseUrl } = config

  async function getSession(sessionID: string) {
    try {
      const result = await v1Client.get({
        url: `${stripSlash(baseUrl)}/session/${encodeURIComponent(sessionID)}`,
      })
      const data = (result as any)?.data
      if (!data) return null
      return {
        id: data.id,
        parentID: data.parentID,
        metadata: (data.metadata ?? {}) as Record<string, unknown>,
      }
    } catch {
      return null
    }
  }

  async function writeSessionMetadata(sessionID: string, metadata: Record<string, unknown>) {
    await v1Client.patch({
      url: `${stripSlash(baseUrl)}/session/${encodeURIComponent(sessionID)}`,
      body: { metadata } as any,
    })
  }

  return {
    getSession,
    async readMission(sessionID: string): Promise<Mission | null> {
      const session = await getSession(sessionID)
      if (!session) return null
      const md = session.metadata
      return (md[METADATA_KEY] as Mission) ?? null
    },
    async writeMission(sessionID: string, mission: Mission | null): Promise<void> {
      const session = await getSession(sessionID)
      const existing = (session?.metadata ?? {}) as Record<string, unknown>
      let next: Record<string, unknown>
      if (mission === null) {
        const { [METADATA_KEY]: _drop, ...rest } = existing
        next = rest
      } else {
        next = { ...existing, [METADATA_KEY]: mission }
      }
      await writeSessionMetadata(sessionID, next)
    },
  }
}

function stripSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s
}

// Extract the underlying HeyApi V1 client from the plugin-injected client.
export function extractV1Client(inputClient: unknown): any {
  return (inputClient as any)?._client
}
