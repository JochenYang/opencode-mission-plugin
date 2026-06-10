// ─────────────────────────────────────────────────────────────────────────────
//  Formatting utilities
// ─────────────────────────────────────────────────────────────────────────────

import type { BudgetSnapshot, Mission, MissionSnapshot } from "../types.js"

export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ""}`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60 ? `${m % 60}m` : ""}`
}

export function formatNumber(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function formatPct(p: number): string {
  if (!Number.isFinite(p)) return "—"
  return `${Math.round(p * 100)}%`
}

export function missionToSnapshot(mission: Mission): MissionSnapshot {
  return {
    id: mission.id,
    objective: mission.objective,
    completionCriterion: mission.completionCriterion,
    status: mission.status,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
    continuationCount: mission.continuationCount,
    terminalReason: mission.terminalReason,
    budget: budgetToSnapshot(mission),
    hasVerificationReport: !!mission.verificationReport,
  }
}

export function budgetToSnapshot(mission: Mission): BudgetSnapshot {
  const b = mission.budget
  const turnsRemaining = b.turnLimit != null ? Math.max(0, b.turnLimit - b.turnsUsed) : null
  const tokensRemaining = b.tokenLimit != null ? Math.max(0, b.tokenLimit - b.tokensUsed) : null
  const wallClockRemaining =
    b.wallClockLimitMs != null ? Math.max(0, b.wallClockLimitMs - b.wallClockMs) : null

  const pct = (used: number, limit: number | null | undefined): number => {
    if (!limit || limit <= 0) return 0
    return Math.min(1, used / limit)
  }

  return {
    turnLimit: b.turnLimit ?? null,
    tokenLimit: b.tokenLimit ?? null,
    wallClockLimitMs: b.wallClockLimitMs ?? null,
    turnsUsed: b.turnsUsed,
    tokensUsed: b.tokensUsed,
    wallClockMs: b.wallClockMs,
    turnsRemaining,
    tokensRemaining,
    wallClockRemainingMs: wallClockRemaining,
    overBudget: isOverBudget(mission),
    pctUsed: {
      turns: pct(b.turnsUsed, b.turnLimit),
      tokens: pct(b.tokensUsed, b.tokenLimit),
      wallClock: pct(b.wallClockMs, b.wallClockLimitMs),
    },
  }
}

export function isOverBudget(mission: Mission): boolean {
  const b = mission.budget
  if (b.turnLimit != null && b.turnsUsed >= b.turnLimit) return true
  if (b.tokenLimit != null && b.tokensUsed >= b.tokenLimit) return true
  if (b.wallClockLimitMs != null && b.wallClockMs >= b.wallClockLimitMs) return true
  return false
}

export function formatMissionStatus(mission: Mission): string {
  const lines: string[] = []
  lines.push(`Mission: ${mission.objective}`)
  lines.push(`Status: ${mission.status.toUpperCase()}`)
  if (mission.terminalReason) {
    lines.push(`Reason: ${mission.terminalReason}`)
  }
  if (
    mission.status === "active" &&
    mission.consecutiveBlockAttempts &&
    mission.consecutiveBlockAttempts > 0
  ) {
    lines.push(
      `Block attempts: ${mission.consecutiveBlockAttempts}/3 (same reason, threshold not met)`,
    )
  }
  lines.push("")
  lines.push("Completion criterion:")
  lines.push(`  ${mission.completionCriterion}`)
  lines.push("")
  lines.push("Budget:")
  const b = budgetToSnapshot(mission)
  const turnLine = b.turnLimit
    ? `  turns: ${b.turnsUsed}/${b.turnLimit} (${formatPct(b.pctUsed.turns)})`
    : `  turns: ${b.turnsUsed} (no limit)`
  const tokenLine = b.tokenLimit
    ? `  tokens: ${formatNumber(b.tokensUsed)}/${formatNumber(b.tokenLimit)} (${formatPct(b.pctUsed.tokens)})`
    : `  tokens: ${formatNumber(b.tokensUsed)} (no limit)`
  const wallLine = b.wallClockLimitMs
    ? `  wallclock: ${formatDuration(b.wallClockMs)}/${formatDuration(b.wallClockLimitMs)} (${formatPct(b.pctUsed.wallClock)})`
    : `  wallclock: ${formatDuration(b.wallClockMs)} (no limit)`
  lines.push(turnLine)
  lines.push(tokenLine)
  lines.push(wallLine)
  lines.push("")
  lines.push(`Continuations: ${mission.continuationCount}`)
  if (mission.verificationReport) {
    lines.push(`Last verify: ${mission.verificationReport.verdict} at ${new Date(mission.verificationReport.verifiedAt).toISOString()}`)
  }
  return lines.join("\n")
}
