// ─────────────────────────────────────────────────────────────────────────────
//  Session info lookup
//
// For sub-agent routing we need the parent session's ID. We use raw
// fetch against the canonical /session/{id} route (no /api prefix;
// the V2 SDK URL is canonical for opencode 1.17.x). The fetch
// implementation comes from the V1 client (opencode-injected) so it
// uses the opencode-trusted transport, not the plugin-sandboxed
// globalThis.fetch. This pattern matches mission-storage.ts so both
// the read and write paths share one fetch.
//
// We previously tried the V2 SDK's session.get() here, but its
// response handling and the v[0] wrapper were problematic for the
// parent lookup use case. Raw fetch + a single unwrap step is more
// reliable.
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
  /** HTTP timeout in ms. Default: 10000. */
  timeoutMs?: number
}

export interface SessionHttp {
  getSession(
    sessionID: string,
  ): Promise<{ id: string; parentID?: string; metadata: Record<string, unknown> } | null>
}

const DEFAULT_TIMEOUT_MS = 10_000

function stripSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s
}

function isHtmlResponse(text: string): boolean {
  const head = text.trimStart().slice(0, 64).toLowerCase()
  return head.startsWith("<!doctype") || head.startsWith("<html")
}

/**
 * The V2 SDK's OpencodeClient wraps the V1 SDK client at
 * `inputClient._client`. The V1 client is what the opencode runtime
 * injects as the trusted transport, so we extract it to get a fetch
 * that bypasses the plugin sandbox.
 *
 * Kept as an explicit helper (not a re-export) so the build does not
 * break for callers that held a reference. Returns null when no V1
 * client is available (e.g., in tests or if opencode changes its
 * runtime injection in a future version).
 */
export function extractV1Client(inputClient: unknown): any {
  if (!inputClient || typeof inputClient !== "object") return null
  const candidate = (inputClient as any)._client
  if (candidate && typeof candidate.getConfig === "function") return candidate
  return null
}

export function createSessionHttp(config: SessionHttpConfig): SessionHttp {
  const { fetchImpl, baseUrl } = config
  const base = stripSlash(baseUrl)
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  async function getSession(
    sessionID: string,
  ): Promise<{ id: string; parentID?: string; metadata: Record<string, unknown> } | null> {
    const url = `${base}/session/${encodeURIComponent(sessionID)}`
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const resp = await fetchImpl(url, {
        method: "GET",
        signal: ac.signal,
      })
      clearTimeout(timer)
      if (!resp.ok) return null
      const text = await resp.text()
      if (isHtmlResponse(text)) return null
      // The V1 client's fetch wraps the response body in {v: [...]}.
      // Unwrap it if present so callers see the raw server payload.
      let data: any
      try {
        data = JSON.parse(text)
      } catch {
        return null
      }
      if (data && typeof data === "object" && Array.isArray(data.v) && data.v.length > 0) {
        data = data.v[0]
      }
      if (!data || !data.id) return null
      return {
        id: data.id,
        parentID: data.parentID,
        metadata: (data.metadata ?? {}) as Record<string, unknown>,
      }
    } catch (err: any) {
      clearTimeout(timer)
      if (err?.name !== "AbortError") {
        // Silent: parent lookup is best-effort, fail-open is the
        // documented contract. See AGENTS.md §3 "Sub-agent routing".
      }
      return null
    }
  }

  return { getSession }
}
