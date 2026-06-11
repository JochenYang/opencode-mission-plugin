// ─────────────────────────────────────────────────────────────────────────────
//  UpdateMission tool
//
// Main session for the regular status transitions. The mission-verify
// sub-agent additionally uses status="complete" to mark the parent mission
// as verified; this works without depending on the experimental.text.complete
// hook (which has a known opencode cleanup-path bug that swallows the auto
// complete).
// ─────────────────────────────────────────────────────────────────────────────

import { tool, type ToolContext, type ToolResult } from "@opencode-ai/plugin/tool"
import type { MissionStore } from "../mission-store.js"
import { formatMissionStatus } from "../utils/format.js"

export function updateMissionTool(store: MissionStore) {
  return tool({
    description:
      "Update the current mission's status. Use this to pause/resume/block/cancel the mission. " +
      "If a mission is active and you don't call this tool, the mission will continue autonomously. " +
      "When the work is done, do NOT call this with status=complete from the main session — the " +
      "mission-verify sub-agent will do that. If the mission is unachievable or wrong, use status=cancelled.",
    args: {
      status: tool.schema
        .enum(["active", "paused", "blocked", "cancelled", "complete"])
        .describe(
          "Target status. " +
            "'active' resumes a paused/blocked mission. " +
            "'paused' freezes the mission (wall clock pauses). " +
            "'blocked' marks the mission as system-blocked (e.g. budget exhaustion). " +
            "'cancelled' discards the mission entirely. " +
            "'complete' is ONLY callable by the mission-verify sub-agent and marks the mission " +
            "as verified; it always requires `missionSessionID` to be the parent session ID.",
        ),
      reason: tool.schema
        .string()
        .optional()
        .describe("Optional human-readable reason, stored in the mission's terminalReason."),
      missionSessionID: tool.schema
        .string()
        .optional()
        .describe(
          "Required by the mission-verify sub-agent when status='complete': the parent " +
            "session ID where the mission lives. The main session should leave this unset " +
            "(the tool uses its own ctx.sessionID).",
        ),
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      // Subagents other than mission-verify cannot update mission status.
      if (ctx.agent !== "build" && ctx.agent !== "mission-verify") {
        return `Error: agent "${ctx.agent}" is not authorized to update mission status. Only the main session can.`
      }

      // 'complete' is reserved for the mission-verify sub-agent.
      if (args.status === "complete" && ctx.agent !== "mission-verify") {
        return `Error: status="complete" can only be set by the mission-verify sub-agent. The main session should use the task tool to spawn mission-verify instead.`
      }

      // 'complete' from the verify sub-agent needs the parent missionSessionID,
      // because the mission is keyed on the parent session, not the verify
      // sub-agent's own session.
      if (args.status === "complete" && !args.missionSessionID) {
        return `Error: status="complete" requires missionSessionID to identify the parent mission. The verify sub-agent's context includes <session_id> for this purpose.`
      }

      const targetSessionID = args.missionSessionID ?? ctx.sessionID

      try {
        if (args.status === "complete") {
          const mission = await store.markComplete(targetSessionID)
          if (!mission) {
            return `Error: no active mission found for sessionID=${targetSessionID}.`
          }
          return `Mission marked complete.\n\n${formatMissionStatus(mission)}`
        }

        const { mission, stopped } = await store.updateStatus(
          targetSessionID,
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

