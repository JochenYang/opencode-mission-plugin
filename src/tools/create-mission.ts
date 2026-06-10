// ─────────────────────────────────────────────────────────────────────────────
//  CreateMission tool
// ─────────────────────────────────────────────────────────────────────────────

import { tool, type ToolContext, type ToolResult } from "@opencode-ai/plugin/tool"
import type { MissionStore } from "../mission-store.js"
import { formatMissionStatus } from "../utils/format.js"

export function createMissionTool(store: MissionStore) {
  return tool({
    description:
      "Start an autonomous mission. Once created, the agent will work across multiple turns to achieve the objective. " +
      "Both objective and completionCriterion are REQUIRED. " +
      "If the user's request is vague, ask for clarification before creating a mission. " +
      "Do not call this for ordinary questions or tasks — only for explicit autonomous work.",
    args: {
      objective: tool.schema
        .string()
        .describe(
          "Concise description of what the agent should achieve. Be specific about scope and outcome.",
        ),
      completionCriterion: tool.schema
        .string()
        .describe(
          "Concrete, checkable conditions that prove the mission is done. " +
            "Example: 'User can log in with email+password, JWT is returned, invalid credentials show 401, " +
            "tests in test/auth.test.ts all pass'.",
        ),
      budgetTurns: tool.schema
        .number()
        .optional()
        .describe("Optional: max number of continuation turns before auto-blocking."),
      budgetTokens: tool.schema
        .number()
        .optional()
        .describe("Optional: max total tokens before auto-blocking."),
      budgetWallClockMs: tool.schema
        .number()
        .optional()
        .describe("Optional: max wall-clock duration in ms (1000-86400000) before auto-blocking."),
      replace: tool.schema
        .boolean()
        .optional()
        .describe(
          "If true, replace any existing non-complete mission. Defaults to false (refuse to overwrite).",
        ),
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      try {
        if (args.replace) {
          const existing = await store.read(ctx.sessionID)
          if (existing) {
            await store.updateStatus(ctx.sessionID, "cancelled", "model", "replaced by new mission")
          }
        }
        const mission = await store.create(ctx.sessionID, {
          objective: args.objective,
          completionCriterion: args.completionCriterion,
          budget: {
            turnLimit: args.budgetTurns,
            tokenLimit: args.budgetTokens,
            wallClockLimitMs: args.budgetWallClockMs,
          },
          actor: "model",
        })
        return `Mission created.\n\n${formatMissionStatus(mission)}\n\nWork autonomously. The agent will continue across multiple turns until the mission is achieved, blocked, or paused.`
      } catch (err: any) {
        return `Error: ${err?.message ?? String(err)}`
      }
    },
  })
}
