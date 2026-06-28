// ─────────────────────────────────────────────────────────────────────────────
//  Session info lookup
//
// For sub-agent routing we need the parent session's ID. We use the
// opencode V2 SDK (session.get) which constructs the correct URL from
// the same source as the server's route table. The V1 client's fetch
// is passed into the V2 client at index.ts so the SDK reuses the
// opencode-trusted transport — important when the plugin process is
// sandboxed away from raw `globalThis.fetch`.
//
// Mission persistence is handled by MissionStorage (see mission-storage.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { createOpencodeClient } from "@opencode-ai/sdk/v2"

export interface SessionHttpConfig {
  v2Client: ReturnType<typeof createOpencodeClient>
}

export interface SessionHttp {
  getSession(
    sessionID: string,
  ): Promise<{ id: string; parentID?: string; metadata: Record<string, unknown> } | null>
}

export function createSessionHttp(config: SessionHttpConfig): SessionHttp {
  const { v2Client } = config

  async function getSession(
    sessionID: string,
  ): Promise<{ id: string; parentID?: string; metadata: Record<string, unknown> } | null> {
    try {
      const result = await v2Client.session.get({ sessionID })
      const data = (result as any)?.data
      if (!data?.id) return null
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
