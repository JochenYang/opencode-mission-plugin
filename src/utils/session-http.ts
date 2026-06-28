// ─────────────────────────────────────────────────────────────────────────────
//  Session info lookup
//
// For sub-agent routing we need the parent session's ID. The V2 SDK's
// client.session.get() does not substitute the {sessionID} path template
// in 1.17.1 (the server returns 500 with "UnknownError" because it gets the
// literal string "{id}"). We sidestep that bug with a direct raw fetch to
// the canonical API path /api/session/:sessionID that we verified in the
// opencode source (groups/session.ts).
//
// Mission persistence is handled by MissionStorage (see mission-storage.ts).
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionHttpConfig {
  // The V2 SDK client (input.client in the plugin runtime). Used only for
  // the underlying transport's baseUrl when calling the opencode session
  // API.
  v2Client: any
}

export interface SessionHttp {
  getSession(
    sessionID: string,
  ): Promise<{ id: string; parentID?: string; metadata: Record<string, unknown> } | null>
}

function stripSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s
}

function isHtmlResponse(text: string): boolean {
  const head = text.trimStart().slice(0, 64).toLowerCase()
  return head.startsWith("<!doctype") || head.startsWith("<html")
}

export function createSessionHttp(config: SessionHttpConfig): SessionHttp {
  const { v2Client } = config

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
      return {
        id: data.id,
        parentID: data.parentID,
        metadata: (data.metadata ?? {}) as Record<string, unknown>,
      }
    } catch {
      return null
    }
  }

  return { getSession }
}

// Kept for callers that still hold a reference; in 1.17.x the runtime injects
// a V2 SDK client and the V1 client (input.client._client) is no longer the
// canonical transport. We retain the export so the build does not break
// elsewhere, but it is no longer used for session lookup.
export function extractV1Client(inputClient: unknown): any {
  return (inputClient as any)?._client
}