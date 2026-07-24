// ─────────────────────────────────────────────────────────────────────────────
//  Continuation prompt template
//
// The continuation prompt is short and strict on purpose: a long, soft
// prompt lets the agent skip the self-audit. The four-dimension checklist
// forces the agent to inspect the current state, not its memory, before
// declaring the mission complete.
// ─────────────────────────────────────────────────────────────────────────────

import type { Mission } from "./types.js"
import { formatDuration, formatNumber, isOverBudget } from "./utils/format.js"

export function continuationPrompt(mission: Mission): string {
  const b = mission.budget
  const over = isOverBudget(mission)

  const turnLine = b.turnLimit
    ? `${mission.continuationCount}/${b.turnLimit} (${Math.round((mission.continuationCount / b.turnLimit) * 100)}% used)`
    : `${mission.continuationCount} (no limit)`
  const tokenLine = b.tokenLimit
    ? `${formatNumber(b.tokensUsed)}/${formatNumber(b.tokenLimit)} (${Math.round((b.tokensUsed / b.tokenLimit) * 100)}% used)`
    : `${formatNumber(b.tokensUsed)} (no limit)`
  const wallLine = b.wallClockLimitMs
    ? `${formatDuration(b.wallClockMs)}/${formatDuration(b.wallClockLimitMs)} (${Math.round((b.wallClockMs / b.wallClockLimitMs) * 100)}% used)`
    : `${formatDuration(b.wallClockMs)} (no limit)`

  let budgetGuidance: string
  const maxPct = Math.max(
    b.turnLimit ? mission.continuationCount / b.turnLimit : 0,
    b.tokenLimit ? b.tokensUsed / b.tokenLimit : 0,
    b.wallClockLimitMs ? b.wallClockMs / b.wallClockLimitMs : 0,
  )
  if (over) {
    budgetGuidance = `BUDGET EXHAUSTED. Do NOT start any new substantive work for this goal.
Wrap up THIS turn cleanly:
  - Summarize useful progress made so far (what's done, with evidence)
  - Identify remaining work or blockers
  - Leave the user with a clear next step
Then call UpdateMission status="blocked" with a concrete reason describing the budget dimension that ran out.`
  } else if (maxPct >= 0.75) {
    budgetGuidance = "Budget tight (>=75% used): converge on the objective. Avoid starting new discretionary work."
  } else if (maxPct >= 0.5) {
    budgetGuidance = "Budget moderate: keep making focused progress."
  } else {
    budgetGuidance = "Budget healthy: room for thorough work."
  }

  return `Continue working toward the active goal.

<objective>
${mission.objective}
</objective>

<completion_criterion>
${mission.completionCriterion}
</completion_criterion>

<progress>
Turn ${turnLine}
Tokens ${tokenLine}
Wallclock ${wallLine}
</progress>

<budget_guidance>
${budgetGuidance}
</budget_guidance>

## Decision rules

Do not run another turn if the objective is simple, already answered, impossible, unsafe, or contradictory. In that case, call UpdateMission with \`complete\` or \`blocked\` in this same turn.

Otherwise, weigh the objective and any completion criteria against the work done so far. Mission mode is iterative.

**Do NOT end the turn after one slice.** Keep working in the same turn until one of:
- Mission is verifiably complete (you are about to call the \`task\` tool with the \`mission-verify\` subagent)
- You hit a budget limit (in which case run the wrap-up directive above)
- You are genuinely blocked and need user input (in which case call \`UpdateMission status="blocked"\` with a clear reason)

"Reassess" means check your progress and decide the next concrete action — it does NOT mean stop the turn. Concrete next actions: run the next command, write the next file, call the next tool. Do not narrate that you are continuing — execute.

## Self-audit checklist (before declaring done)

Before calling UpdateMission status="complete", verify each of these against the current state — not against your memory of what you intended:

1. **Completeness**: every item in the completion criterion is satisfied with current evidence (file paths, command output, test results). A plan or a first pass is NOT a complete result.
2. **Correctness**: the work actually runs without errors you have not addressed. Read the files you wrote; do not assume.
3. **Integration**: the new pieces fit the existing codebase (imports resolve, types match, conventions followed).
4. **Robustness**: the obvious edge cases are handled (empty input, error paths, boundary values).

If any of the four fails, do not mark complete. Do the missing work this turn, then re-audit.

If all four pass, you MUST call the \`task\` tool with \`subagent_type: "mission-verify"\` IMMEDIATELY in this turn. Do NOT stop, do NOT ask the user, do NOT wait. The verify is mandatory, not optional. Only the verify subagent can mark the mission complete — never call \`UpdateMission status="complete"\` yourself.

## task tool contract (OpenCode)

When spawning mission-verify (or any subagent) via the task tool:

1. For a **new** verification run, call task with \`subagent_type: "mission-verify"\` and **omit task_id completely**.
2. Never invent a task_id. Never pass a UUID, punchcard TID, mission id, or random string.
3. OpenCode session ids always start with ses (e.g. ses_...). Only reuse a task_id that a previous successful task result returned, and only when you intentionally resume that same subagent session.
4. If a previous task call failed with Expected a string starting with "ses", retry **without** task_id.

If the objective cannot be completed as stated (external blocker, contradictory requirements, required user input), call UpdateMission status="blocked" with a concrete reason.

## Working principles

- Keep the self-audit brief. Do not explore unrelated interpretations once the goal can be decided.
- Work from evidence — inspect the current state before relying on anything.
- Improve, replace, or remove existing work as needed; do not redefine success around a smaller or easier task.
- Optimize for movement toward the requested end state.
- If the work is not done, just keep working. Do not narrate that you are continuing — execute.`
}
