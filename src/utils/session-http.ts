// ─────────────────────────────────────────────────────────────────────────────
//  Session info lookup
//
// For sub-agent routing we need the parent session's ID. We use the V2
// SDK's session.get() API. This avoids the V1 client's `v[0]` unwrap bug
// that crashes when the opencode server returns an unwrapped response
// (which happens in 1.17.x because the server doesn't follow V1's
// `{v: [...]}` envelope convention).
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionHttpConfig {
  /**
   * The V2 SDK OpencodeClient injected by the opencode runtime.
   * We use its `session.get()` method for session-info lookup.
   */
  client: any
}

export interface SessionHttp {
  getSession(
    sessionID: string,
  ): Promise<{ id: string; parentID?: string; metadata: Record<string, unknown> } | null>
}

/** Extract the inner data from the V2 SDK's { data, request, response } wrapper. */
function unwrap(result: any): any {
  if (!result) return null
  if (typeof result === "object" && "data" in result) return result.data
  return result
}

export function createSessionHttp(config: SessionHttpConfig): SessionHttp {
  const session = config.client.session

  async function getSession(
    sessionID: string,
  ): Promise<{ id: string; parentID?: string; metadata: Record<string, unknown> } | null> {
    try {
      const result = await session.get({ sessionID })
      const data = unwrap(result)
      if (!data || !data.id) return null
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
