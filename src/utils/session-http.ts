// ─────────────────────────────────────────────────────────────────────────────
//  Session info lookup
//
// For sub-agent routing we need the parent session's ID. We use raw
// fetch against the canonical /api/session/:sessionID route. The fetch
// implementation comes from the V1 client (opencode-injected) so it
// uses the opencode-trusted transport, not the plugin-sandboxed
// globalThis.fetch. This pattern matches mission-storage.ts so both
// the read and write paths share one fetch.
//
// Mission persistence is handled by MissionStorage (see mission-storage.ts).
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionHttpConfig {
  /**
   * The opencode-trusted fetch implementation. In practice this is
   * `v1Client.getConfig().fetch` from the plugin runtime.
   */
  fetchImpl: typeof fetch
  /** Base URL of the opencode server. */
  baseUrl: string
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
  const { fetchImpl, baseUrl } = config
  const base = stripSlash(baseUrl)

  async function getSession(
    sessionID: string,
  ): Promise<{ id: string; parentID?: string; metadata: Record<string, unknown> } | null> {
    try {
      const resp = await fetchImpl(`${base}/api/session/${encodeURIComponent(sessionID)}`, {
        method: "GET",
      })
      if (!resp.ok) return null
      const text = await resp.text()
      if (isHtmlResponse(text)) return null
      const data = JSON.parse(text)
      if (!data.id) return null
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

// Kept for callers that still hold a reference; in 1.17.x the runtime
// injects a V2 SDK client and the V1 client (input.client._client) is
// no longer the canonical transport. We retain the export so the build
// does not break elsewhere, but it is no longer used for session lookup.
export function extractV1Client(inputClient: unknown): any {
  return (inputClient as any)?._client
}
