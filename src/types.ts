// ─────────────────────────────────────────────────────────────────────────────
//  Type definitions
//
// Design notes:
// - MissionStatus: 4 states, distinguishing user-initiated (paused) from
//   system-level (blocked) stops
// - MissionActor: tracks the source of status changes
// - MissionBudget: 3-dimension budget (turn / token / wallclock)
// - VerificationReport: 4-dimension structured scoring
//   (completeness / correctness / integration / robustness)
// ─────────────────────────────────────────────────────────────────────────────

// ── Status / Actor ──────────────────────────────────────────────────────────

export type MissionStatus =
  | "active"
  | "paused"
  | "blocked"
  | "budget_limited"
  | "complete"

export type MissionActor = "user" | "model" | "runtime" | "system"

// UpdateMission's externally exposed status parameter set.
// Note: "cancelled" is a tool parameter value that triggers record deletion;
// it is NOT written to the status field. "budget_limited" is set automatically
// by the runtime when budget exhausts; external callers transition out of it
// via "active" but cannot set it directly.
export type UpdateMissionStatus = "active" | "paused" | "blocked" | "cancelled"

// ── Budget ──────────────────────────────────────────────────────────────────

export interface MissionBudgetLimits {
  readonly turnLimit?: number
  readonly tokenLimit?: number
  readonly wallClockLimitMs?: number
}

export interface MissionBudget {
  // Limits
  readonly turnLimit?: number
  readonly tokenLimit?: number
  readonly wallClockLimitMs?: number

  // Accumulated usage (written at runtime)
  turnsUsed: number
  tokensUsed: number
  wallClockMs: number

  // Time anchors (wallclock anchor is reset on resume; pause freezes it)
  wallClockStartedAt?: number
  wallClockPausedAt?: number
  totalPausedMs: number
}

export interface BudgetSnapshot {
  turnLimit: number | null
  tokenLimit: number | null
  wallClockLimitMs: number | null
  turnsUsed: number
  tokensUsed: number
  wallClockMs: number
  turnsRemaining: number | null
  tokensRemaining: number | null
  wallClockRemainingMs: number | null
  overBudget: boolean
  pctUsed: {
    turns: number
    tokens: number
    wallClock: number
  }
}

// ── Verification ────────────────────────────────────────────────────────────

export type DimensionScoreValue = 0 | 1 | 2 | 3 | 4

export interface DimensionScore {
  score: DimensionScoreValue
  evidence: string
  notes?: string
}

export interface VerificationScores {
  completeness: DimensionScore
  correctness: DimensionScore
  integration: DimensionScore
  robustness: DimensionScore
}

export interface VerificationReport {
  verifiedAt: number
  verdict: "passed" | "failed"
  scores: VerificationScores
  gaps?: string[]
  evidence?: string[]
}

// ── Mission ─────────────────────────────────────────────────────────────────

export interface Mission {
  id: string
  objective: string
  completionCriterion: string
  status: MissionStatus

  // Tracking
  createdAt: number
  updatedAt: number
  createdBy: MissionActor
  updatedBy: MissionActor

  // Continuation progress
  continuationCount: number
  lastContinuationAt?: number

  // Budget
  budget: MissionBudget

  // Termination info
  terminalReason?: string

  // 3-turn blocked threshold (P0 #3, inspired by Codex)
  consecutiveBlockAttempts: number
  lastBlockReason?: string

  // Verification
  verificationReport?: VerificationReport
}

export interface MissionSnapshot {
  id: string
  objective: string
  completionCriterion: string
  status: MissionStatus
  createdAt: number
  updatedAt: number
  continuationCount: number
  terminalReason?: string
  budget: BudgetSnapshot
  hasVerificationReport: boolean
}

// ── Session metadata storage schema ─────────────────────────────────────────

// Session.metadata is Record<string, unknown>; we use "missionPro" as our key.
export interface SessionMetadataShape {
  missionPro?: Mission
}

// ── Interrupt tracking ─────────────────────────────────────────────────────

export type AbortReason = "user" | "runtime"

// ── Continuation decision ──────────────────────────────────────────────────

export type ContinuationSkipReason =
  | "no-mission"
  | "not-active"
  | "is-subagent"
  | "aborted-user"
  | "aborted-runtime"
  | "over-budget"
  | "soft-cap"

export interface ContinuationDecision {
  shouldContinue: boolean
  reason?: ContinuationSkipReason
  detail?: string
}
