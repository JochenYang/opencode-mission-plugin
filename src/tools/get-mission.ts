// ─────────────────────────────────────────────────────────────────────────────
//  GetMission tool
//
// Available to main session and subagents. Subagents read the PARENT session's
// mission (not their own).
// ─────────────────────────────────────────────────────────────────────────────

import { tool, type ToolContext, type ToolResult } from "@opencode-ai/plugin/tool"
import type { MissionStore } from "../mission-store.js"
import type { SessionHttp } from "../utils/session-http.js"
import { formatMissionStatus } from "../utils/format.js"

export function getMissionTool(store: MissionStore, http: SessionHttp) {
  return tool({
    description:
      "Get the current mission's full state including objective, completion criterion, status, " +
      "budget usage (turns / tokens / wallclock), continuation count, and any verification report. " +
      "Always safe to call — no side effects.",
    args: {},
    async execute(_args, ctx: ToolContext): Promise<ToolResult> {
      try {
        // Known subagent types dispatched by the main session via the `task`
        // tool. These should read the PARENT session's mission instead of their own.
        const SUBAGENT_TYPES = new Set([
          "builder", "dba", "detective", "explore", "guard",
          "ops", "perf", "reviewer", "tester",
        ])
        // Subagents: read the parent session's mission
        let targetSessionID = ctx.sessionID
        if (SUBAGENT_TYPES.has(ctx.agent)) {
          const session = await http.getSession(ctx.sessionID)
          if (session?.parentID) {
            targetSessionID = session.parentID
          } else {
            // Fallback: scan the local missions file for the active
            // mission. Used when the V2 SDK cannot resolve the parent
            // (subagent sandbox, or SDK returns null for a subagent's
            // own session).
            const active = await store.findActiveMission()
            if (active) targetSessionID = active.sessionID
          }
        }
        const mission = await store.read(targetSessionID)
        if (!mission) {
          return "No active mission. Use CreateMission to start one."
        }
        return formatMissionStatus(mission)
      } catch (err: any) {
        return `Error: ${err?.message ?? String(err)}`
      }
    },
  })
}
