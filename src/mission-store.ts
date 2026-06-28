// ─────────────────────────────────────────────────────────────────────────────
//  MissionStore
//
// State machine + budget accumulation + persistence. The only entry point for
// any mission mutation. All transitions go through this class to guarantee
// legality and consistent budget tracking.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  AbortReason,
  BudgetSnapshot,
  ContinuationDecision,
  Mission,
  MissionActor,
  MissionBudget,
  MissionBudgetLimits,
  MissionStatus,
  UpdateMissionStatus,
  VerificationReport,
} from "./types.js"
import { isOverBudget } from "./utils/format.js"
import type { MissionStorage } from "./mission-storage.js"
import type { SessionHttp } from "./utils/session-http.js"

// ── Constants ───────────────────────────────────────────────────────────────

const SOFT_TURN_CAP = 100
// Cap on consecutive failed judge verdicts before the mission is auto-capped.
// Lower than the turn cap because each judge call is a full LLM round-trip.
const MAX_JUDGE_REACT = 5

// ── MissionStore ─────────────────────────────────────────────────────────────

export class MissionStore {
  private storage: MissionStorage
  private http: SessionHttp

  /**
   * @param storage Mission persistence backend. Owns the read/write of the
   *   mission record; can be either a file-backed or a session-metadata-backed
   *   implementation (see mission-storage.ts).
   * @param http Session-info lookup. Used only to read the parent session ID
   *   (for sub-agent routing decisions in shouldContinue). Mission data
   *   itself does not pass through this dependency.
   */
  constructor(storage: MissionStorage, http: SessionHttp) {
    this.storage = storage
    this.http = http
  }

  // ── Read ───────────────────────────────────────────────────────────────

  async read(sessionID: string): Promise<Mission | null> {
    return this.storage.read(sessionID)
  }

  async snapshot(sessionID: string): Promise<{
    mission: Mission | null
    snapshot: import("./types.js").MissionSnapshot | null
    budget: BudgetSnapshot | null
  }> {
    const mission = await this.read(sessionID)
    if (!mission) return { mission: null, snapshot: null, budget: null }
    const { missionToSnapshot, budgetToSnapshot } = await import("./utils/format.js")
    return {
      mission,
      snapshot: missionToSnapshot(mission),
      budget: budgetToSnapshot(mission),
    }
  }

  // ── Create ─────────────────────────────────────────────────────────────

  async create(
    sessionID: string,
    input: {
      objective: string
      completionCriterion: string
      budget?: MissionBudgetLimits
      actor?: MissionActor
    },
  ): Promise<Mission> {
    const existing = await this.read(sessionID)
    if (existing && existing.status === "active") {
      throw new Error(`Cannot create: an active mission already exists: "${existing.objective}"`)
    }
    if (existing && existing.status === "paused") {
      throw new Error(
        `Cannot create: a paused mission exists. Use UpdateMission status="cancelled" to discard it first, or status="active" to resume it.`,
      )
    }
    if (existing && existing.status === "blocked") {
      throw new Error(
        `Cannot create: a blocked mission exists. Use UpdateMission status="cancelled" to discard it first, or status="active" to resume it.`,
      )
    }

    const limits = input.budget ?? {}
    validateBudgetLimits(limits)

    const now = Date.now()
    const mission: Mission = {
      id: `mission_${now}_${Math.random().toString(36).slice(2, 8)}`,
      objective: input.objective.trim(),
      completionCriterion: input.completionCriterion.trim(),
      status: "active",
      createdAt: now,
      updatedAt: now,
      createdBy: input.actor ?? "model",
      updatedBy: input.actor ?? "model",
      continuationCount: 0,
      budget: makeBudget(limits, now),
      consecutiveBlockAttempts: 0,
      judgeReactAttempts: 0,
    }
    await this.storage.write(sessionID, mission)
    return mission
  }

  // ── Update status ──────────────────────────────────────────────────────

  async updateStatus(
    sessionID: string,
    target: UpdateMissionStatus,
    actor: MissionActor,
    reason?: string,
  ): Promise<{ mission: Mission; stopped: boolean }> {
    const mission = await this.read(sessionID)
    if (!mission) {
      throw new Error("No mission to update. Use CreateMission first.")
    }

    // cancelled is a special path: remove the record
    if (target === "cancelled") {
      await this.storage.write(sessionID, null)
      return { mission: { ...mission, status: "complete" }, stopped: true }
    }

    // P0 #3: 3-turn threshold for agent-declared blocked.
    // Code-authored attempts (actor="model") need 3 consecutive same-reason
    // attempts before they actually transition. Runtime/user/system still
    // block immediately.
    if (target === "blocked" && actor === "model") {
      const sameReason = mission.lastBlockReason === reason
      mission.consecutiveBlockAttempts = sameReason
        ? (mission.consecutiveBlockAttempts ?? 0) + 1
        : 1
      mission.lastBlockReason = reason
      mission.updatedAt = Date.now()
      mission.updatedBy = actor
      if (mission.consecutiveBlockAttempts < 3) {
        await this.storage.write(sessionID, mission)
        throw new Error(
          `Block threshold not met: this is attempt ${mission.consecutiveBlockAttempts}/3 ` +
            `for the same reason. The mission stays active. Re-attempt ` +
            `UpdateMission status="blocked" with the same reason for ` +
            `${3 - mission.consecutiveBlockAttempts} more turn(s) to actually ` +
            `mark it as blocked. This is intentional: prevents premature ` +
            `block declarations on transient issues.`,
        )
      }
      // Threshold met — fall through to the normal transition path.
    }

    assertTransition(mission.status, target)

    const prevStatus = mission.status
    mission.status = target
    mission.updatedAt = Date.now()
    mission.updatedBy = actor
    mission.terminalReason = reason

    if (target === "paused") {
      // Freeze wall clock
      mission.budget.wallClockPausedAt = Date.now()
    } else if (target === "active" && prevStatus === "paused" && mission.budget.wallClockPausedAt) {
      // Accumulate paused duration, reset start anchor
      const paused = Date.now() - mission.budget.wallClockPausedAt
      mission.budget.totalPausedMs += paused
      mission.budget.wallClockPausedAt = undefined
      mission.budget.wallClockStartedAt = Date.now()
    } else if (target === "active" && prevStatus === "blocked") {
      // blocked -> active re-activates, reset wall clock anchor
      mission.budget.wallClockStartedAt = Date.now()
    } else if (target === "active") {
      // Other cases (e.g. first activation), set anchor if missing
      mission.budget.wallClockStartedAt ??= Date.now()
    }

    // Clear terminalReason on resume
    if (target === "active") {
      mission.terminalReason = undefined
      // Reset block threshold counter on resume so a fresh cycle starts clean.
      mission.consecutiveBlockAttempts = 0
      mission.lastBlockReason = undefined
      mission.judgeReactAttempts = 0
    }

    await this.storage.write(sessionID, mission)
    return { mission, stopped: target !== "active" }
  }

  // ── Budget mutation ────────────────────────────────────────────────────

  async setBudget(sessionID: string, limits: MissionBudgetLimits): Promise<{ mission: Mission; overBudget: boolean }> {
    validateBudgetLimits(limits)
    const mission = await this.read(sessionID)
    if (!mission) throw new Error("No mission to set budget for. Use CreateMission first.")

    const next: MissionBudget = {
      turnLimit: limits.turnLimit ?? mission.budget.turnLimit,
      tokenLimit: limits.tokenLimit ?? mission.budget.tokenLimit,
      wallClockLimitMs: limits.wallClockLimitMs ?? mission.budget.wallClockLimitMs,
      turnsUsed: mission.budget.turnsUsed,
      tokensUsed: mission.budget.tokensUsed,
      wallClockMs: mission.budget.wallClockMs,
      wallClockStartedAt: mission.budget.wallClockStartedAt,
      wallClockPausedAt: mission.budget.wallClockPausedAt,
      totalPausedMs: mission.budget.totalPausedMs,
    }

    // Prevent setting a limit below current usage
    if (next.turnLimit != null && next.turnsUsed >= next.turnLimit) {
      throw new Error(`turnLimit (${next.turnLimit}) is <= turnsUsed (${next.turnsUsed})`)
    }
    if (next.tokenLimit != null && next.tokensUsed >= next.tokenLimit) {
      throw new Error(`tokenLimit (${next.tokenLimit}) is <= tokensUsed (${next.tokensUsed})`)
    }
    if (next.wallClockLimitMs != null && next.wallClockMs >= next.wallClockLimitMs) {
      throw new Error(`wallClockLimitMs (${next.wallClockLimitMs}) is <= wallClockMs (${next.wallClockMs})`)
    }

    mission.budget = next
    mission.updatedAt = Date.now()
    mission.updatedBy = "model"
    await this.storage.write(sessionID, mission)
    return { mission, overBudget: isOverBudget(mission) }
  }

  // ── Accumulation on continuation ───────────────────────────────────────

  async recordContinuation(sessionID: string): Promise<Mission | null> {
    const mission = await this.read(sessionID)
    if (!mission || mission.status !== "active") return null
    const now = Date.now()
    mission.continuationCount += 1
    mission.budget.turnsUsed = mission.continuationCount
    mission.lastContinuationAt = now
    mission.updatedAt = now
    await this.storage.write(sessionID, mission)
    return mission
  }

  async recordTokenUsage(sessionID: string, deltaTokens: number): Promise<Mission | null> {
    if (deltaTokens <= 0) return null
    const mission = await this.read(sessionID)
    if (!mission) return null
    mission.budget.tokensUsed += deltaTokens
    mission.updatedAt = Date.now()
    await this.storage.write(sessionID, mission)
    return mission
  }

  async tickWallClock(sessionID: string): Promise<Mission | null> {
    const mission = await this.read(sessionID)
    if (!mission) return null
    if (mission.status === "paused" || mission.budget.wallClockPausedAt) {
      return mission
    }
    const start = mission.budget.wallClockStartedAt ?? mission.createdAt
    const now = Date.now()
    const elapsed = now - start - mission.budget.totalPausedMs
    mission.budget.wallClockMs = Math.max(0, elapsed)
    await this.storage.write(sessionID, mission)
    return mission
  }

  async markBlocked(sessionID: string, reason: string): Promise<Mission | null> {
    const mission = await this.read(sessionID)
    if (!mission) return null
    if (mission.status !== "active") return mission
    mission.status = "blocked"
    mission.terminalReason = reason
    mission.updatedAt = Date.now()
    mission.updatedBy = "runtime"
    await this.storage.write(sessionID, mission)
    return mission
  }

  // P0 #4: separate state for budget-exhaustion (vs agent-declared blocked).
  // Both are recoverable via UpdateMission status="active", but the status
  // name communicates the cause. Resuming from budget_limited requires the
  // owner to either set a higher budget or accept that continuation will
  // re-block on the next turn once the same budget hits 100% again.
  async markBudgetLimited(sessionID: string, reason: string): Promise<Mission | null> {
    const mission = await this.read(sessionID)
    if (!mission) return null
    if (mission.status !== "active") return mission
    mission.status = "budget_limited"
    mission.terminalReason = reason
    mission.updatedAt = Date.now()
    mission.updatedBy = "runtime"
    await this.storage.write(sessionID, mission)
    return mission
  }

  async attachVerificationReport(sessionID: string, report: VerificationReport): Promise<Mission | null> {
    const mission = await this.read(sessionID)
    if (!mission) return null
    mission.verificationReport = report
    mission.updatedAt = Date.now()
    mission.updatedBy = "system"
    await this.storage.write(sessionID, mission)
    return mission
  }

  // Record a non-satisfying judge verdict and check the react cap. When the
  // cap is reached, the mission is auto-transitioned to budget_limited so
  // continuation stops. Returns the updated mission and whether the cap fired.
  async recordJudgeReactAttempt(
    sessionID: string,
    maxAttempts: number = MAX_JUDGE_REACT,
  ): Promise<{ mission: Mission | null; capped: boolean }> {
    const mission = await this.read(sessionID)
    if (!mission) return { mission: null, capped: false }
    mission.judgeReactAttempts = (mission.judgeReactAttempts ?? 0) + 1
    mission.updatedAt = Date.now()
    mission.updatedBy = "system"
    let capped = false
    if (
      mission.judgeReactAttempts >= maxAttempts &&
      mission.status === "active"
    ) {
      mission.status = "budget_limited"
      mission.terminalReason = `Judge react cap reached (${maxAttempts} non-satisfying verdicts)`
      capped = true
    }
    await this.storage.write(sessionID, mission)
    return { mission, capped }
  }

  async markComplete(sessionID: string, report?: VerificationReport): Promise<Mission | null> {
    const mission = await this.read(sessionID)
    if (!mission) return null
    if (mission.status === "complete") return mission
    if (mission.status !== "active" && mission.status !== "blocked") {
      throw new Error(`Cannot mark complete from status: ${mission.status}`)
    }
    mission.status = "complete"
    mission.terminalReason = "verified by mission-verify subagent"
    mission.updatedAt = Date.now()
    mission.updatedBy = "system"
    if (report) mission.verificationReport = report
    await this.storage.write(sessionID, mission)
    return mission
  }

  // ── Continuation gate ──────────────────────────────────────────────────

  async shouldContinue(sessionID: string, abortReason?: AbortReason): Promise<ContinuationDecision> {
    const session = await this.http.getSession(sessionID)
    if (!session) return { shouldContinue: false, reason: "no-mission" }
    if (session.parentID) return { shouldContinue: false, reason: "is-subagent" }

    const mission = await this.read(sessionID)
    if (!mission) return { shouldContinue: false, reason: "no-mission" }
    if (mission.status !== "active") return { shouldContinue: false, reason: "not-active" }

    if (abortReason === "user") {
      return { shouldContinue: false, reason: "aborted-user" }
    }
    if (abortReason === "runtime") {
      return { shouldContinue: false, reason: "aborted-runtime" }
    }

    if (isOverBudget(mission)) {
      return { shouldContinue: false, reason: "over-budget" }
    }

    if (mission.continuationCount > SOFT_TURN_CAP) {
      return { shouldContinue: false, reason: "soft-cap" }
    }

    return { shouldContinue: true }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function makeBudget(limits: MissionBudgetLimits, now: number): MissionBudget {
  return {
    turnLimit: limits.turnLimit,
    tokenLimit: limits.tokenLimit,
    wallClockLimitMs: limits.wallClockLimitMs,
    turnsUsed: 0,
    tokensUsed: 0,
    wallClockMs: 0,
    wallClockStartedAt: now,
    totalPausedMs: 0,
  }
}

function validateBudgetLimits(limits: MissionBudgetLimits): void {
  if (limits.turnLimit != null) {
    if (limits.turnLimit < 1) {
      throw new Error(`turnLimit must be >= 1, got ${limits.turnLimit}`)
    }
  }
  if (limits.tokenLimit != null) {
    if (limits.tokenLimit < 100) {
      throw new Error(`tokenLimit must be >= 100, got ${limits.tokenLimit}`)
    }
  }
  if (limits.wallClockLimitMs != null) {
    if (limits.wallClockLimitMs < 1000) {
      throw new Error(`wallClockLimitMs must be >= 1000 (1s), got ${limits.wallClockLimitMs}`)
    }
    if (limits.wallClockLimitMs > 24 * 60 * 60 * 1000) {
      throw new Error(`wallClockLimitMs must be <= 86400000 (24h), got ${limits.wallClockLimitMs}`)
    }
  }
}

function assertTransition(from: MissionStatus, to: MissionStatus): void {
  const allowed: Record<MissionStatus, MissionStatus[]> = {
    active: ["paused", "blocked", "budget_limited"],
    paused: ["active"],
    blocked: ["active"],
    budget_limited: ["active"],
    complete: [],
  }
  if (!allowed[from].includes(to)) {
    throw new Error(`Invalid mission status transition: ${from} -> ${to}`)
  }
}
