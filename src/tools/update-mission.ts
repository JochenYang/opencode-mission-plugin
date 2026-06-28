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

      // 'complete' is reserved for the mission-verify sub-agent under
      // normal flow, but the main session may also call it as a safety
      // net: if a passing verification report is already on the
      // mission, the verify has run independently and the main
      // session can confirm. This guards against the rare case where
      // the verify subagent's text-complete hook did not fire (so no
      // auto-complete) AND the verify subagent did not call
      // UpdateMission itself (the prompt told it to but the model
      // skipped). Without this relaxation the mission is stuck in
      // ACTIVE forever despite a passing verify.
      if (args.status === "complete" && ctx.agent !== "mission-verify") {
        const targetID = args.missionSessionID ?? ctx.sessionID
        const existing = await store.read(targetID)
        if (!existing) {
          return `Error: status="complete" requires an existing mission. No mission found for sessionID=${targetID}.`
        }
        if (existing.verificationReport?.verdict !== "passed") {
          return `Error: status="complete" from the main session requires a passing verification report. Run the mission-verify subagent first, or call UpdateMission from the verify subagent itself.`
        }
        // Main session confirming a verified mission — allowed.
      }

      // 'complete' from the verify sub-agent needs the parent missionSessionID,
      // because the mission is keyed on the parent session, not the verify
      // sub-agent's own session. If the verify subagent didn't get a
      // <mission_context> block injected (V2 SDK parent lookup failed),
      // fall back to scanning the local missions file for the active
      // mission — that's the same workspace, so the file is available.
      let resolvedMissionSessionID = args.missionSessionID
      if (
        args.status === "complete" &&
        ctx.agent === "mission-verify" &&
        !resolvedMissionSessionID
      ) {
        const active = await store.findActiveMission()
        if (active) {
          resolvedMissionSessionID = active.sessionID
        } else {
          return `Error: status="complete" requires missionSessionID to identify the parent mission. The verify sub-agent's context includes <session_id> for this purpose, or the plugin can fall back to scanning the local missions file when no <mission_context> was injected.`
        }
      }

      const targetSessionID = resolvedMissionSessionID ?? ctx.sessionID

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

