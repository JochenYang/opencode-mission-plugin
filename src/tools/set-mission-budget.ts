// ─────────────────────────────────────────────────────────────────────────────
//  SetMissionBudget tool
//
// The LLM picks the unit from a closed enum so it cannot send ambiguous
// wallclock amounts (e.g. "30" — seconds or ms?). One { value, unit } pair
// is set at a time, so a single call cannot accidentally silence two of the
// three budget dimensions by passing only one of them.
// ─────────────────────────────────────────────────────────────────────────────

import { tool, type ToolContext, type ToolResult } from "@opencode-ai/plugin/tool"
import type { MissionStore } from "../mission-store.js"
import { formatMissionStatus } from "../utils/format.js"

type BudgetUnit = "turns" | "tokens" | "milliseconds" | "seconds" | "minutes" | "hours"

const BUDGET_UNITS = ["turns", "tokens", "milliseconds", "seconds", "minutes", "hours"] as const

const MIN_TIME_MS = 1_000
const MAX_TIME_MS = 24 * 60 * 60 * 1000

export function setMissionBudgetTool(store: MissionStore) {
  return tool({
    description:
      "Set or adjust a single hard budget limit for the current mission. " +
      "Pass one { value, unit } pair per call. " +
      "Once any limit is reached the mission auto-transitions to `blocked`.",
    args: {
      value: tool.schema
        .number()
        .positive()
        .describe("The positive numeric budget value. Whole numbers for turns/tokens; decimals allowed for time units."),
      unit: tool.schema
        .enum(BUDGET_UNITS)
        .describe(
          "The unit of the value. " +
            "'turns' = max continuation turns. " +
            "'tokens' = max total tokens. " +
            "'milliseconds' | 'seconds' | 'minutes' | 'hours' = max wall-clock duration.",
        ),
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      try {
        const value = normalizeValue(args.value, args.unit as BudgetUnit)
        const limits = budgetLimitsFromInput(value, args.unit as BudgetUnit)
        if (limits === null) {
          return `Error: ${formatBudget(value, args.unit as BudgetUnit)} is not a reasonable mission budget. ` +
            `Wall-clock budgets must be between ${MIN_TIME_MS / 1000}s and ${MAX_TIME_MS / 1000 / 60 / 60}h.`
        }
        const { mission, overBudget } = await store.setBudget(ctx.sessionID, limits)
        const overNote = overBudget
          ? "\n\nNote: the mission is currently over budget. Consider UpdateMission status=\"blocked\" to stop continuation."
          : ""
        return `Budget updated: ${formatBudget(value, args.unit as BudgetUnit)}.\n\n${formatMissionStatus(mission)}${overNote}`
      } catch (err: any) {
        return `Error: ${err?.message ?? String(err)}`
      }
    },
  })
}

function normalizeValue(value: number, unit: BudgetUnit): number {
  if (unit === "turns" || unit === "tokens") {
    return Math.max(1, Math.round(value))
  }
  return value
}

function budgetLimitsFromInput(
  value: number,
  unit: BudgetUnit,
): { turnLimit?: number; tokenLimit?: number; wallClockLimitMs?: number } | null {
  switch (unit) {
    case "turns":
      return { turnLimit: value }
    case "tokens":
      return { tokenLimit: value }
    case "milliseconds":
    case "seconds":
    case "minutes":
    case "hours": {
      const ms = Math.round(toMs(value, unit))
      if (ms < MIN_TIME_MS || ms > MAX_TIME_MS) return null
      return { wallClockLimitMs: ms }
    }
  }
}

function toMs(value: number, unit: "milliseconds" | "seconds" | "minutes" | "hours"): number {
  switch (unit) {
    case "milliseconds":
      return value
    case "seconds":
      return value * 1000
    case "minutes":
      return value * 60 * 1000
    case "hours":
      return value * 60 * 60 * 1000
  }
}

function formatBudget(value: number, unit: BudgetUnit): string {
  const singular = unit.endsWith("s") ? unit.slice(0, -1) : unit
  return `${String(value)} ${value === 1 ? singular : unit}`
}
