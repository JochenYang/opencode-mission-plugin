// ─────────────────────────────────────────────────────────────────────────────
//  UpdateMission tool
//
// Main session only. Subagent sessions are rejected (except mission-verify for
// complete operations, which are gated in MissionStore.markComplete).
// ─────────────────────────────────────────────────────────────────────────────

import { tool, type ToolContext, type ToolResult } from "@opencode-ai/plugin/tool"
import type { MissionStore } from "../mission-store.js"
import { formatMissionStatus } from "../utils/format.js"

export function updateMissionTool(store: MissionStore) {
  return tool({
    description:
      "Update the current mission's status. Use this to pause/resume/block/cancel the mission. " +
      "If a mission is active and you don't call this tool, the mission will continue autonomously. " +
      "When the work is done, do NOT call this with status=complete — call the mission-verify sub-agent instead. " +
      "If the mission is unachievable or wrong, use status=cancelled.",
    args: {
      status: tool.schema
        .enum(["active", "paused", "blocked", "cancelled"])
        .describe(
          "Target status. " +
            "'active' resumes a paused/blocked mission. " +
            "'paused' freezes the mission (wall clock pauses). " +
            "'blocked' marks the mission as system-blocked (e.g. budget exhaustion). " +
            "'cancelled' discards the mission entirely.",
        ),
      reason: tool.schema
        .string()
        .optional()
        .describe("Optional human-readable reason, stored in the mission's terminalReason."),
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      // Subagents other than mission-verify cannot update mission status.
      if (ctx.agent !== "build" && ctx.agent !== "mission-verify") {
        return `Error: agent "${ctx.agent}" is not authorized to update mission status. Only the main session can.`
      }
      try {
        const { mission, stopped } = await store.updateStatus(
          ctx.sessionID,
          args.status,
          ctx.agent === "mission-verify" ? "system" : "model",
          args.reason,
        )
        const stopNote = stopped ? " This turn will NOT trigger continuation." : ""
        return `Mission updated.\n\n${formatMissionStatus(mission)}\n\n${stopNote}`
      } catch (err: any) {
        return `Error: ${err?.message ?? String(err)}`
      }
    },
  })
}
