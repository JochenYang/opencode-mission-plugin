// ─────────────────────────────────────────────────────────────────────────────
//  Verify subagent context injection
// ─────────────────────────────────────────────────────────────────────────────

import type { Mission } from "../types.js"
import { formatDuration, formatNumber } from "../utils/format.js"

export function subagentMissionContext(
  mission: Mission,
  originalPrompt: string,
  parentSessionID: string,
): string {
  const b = mission.budget
  const turnLine = b.turnLimit ? `${mission.continuationCount}/${b.turnLimit}` : `${mission.continuationCount}/∞`
  const tokenLine = b.tokenLimit ? `${formatNumber(b.tokensUsed)}/${formatNumber(b.tokenLimit)}` : `${formatNumber(b.tokensUsed)}/∞`
  const wallLine = b.wallClockLimitMs ? `${formatDuration(b.wallClockMs)}/${formatDuration(b.wallClockLimitMs)}` : `${formatDuration(b.wallClockMs)}/∞`
  const verifyLine = mission.verificationReport
    ? `Last verification: ${mission.verificationReport.verdict} at ${new Date(mission.verificationReport.verifiedAt).toISOString()}`
    : "First verification"

  return `<mission_context>
<session_id>
${parentSessionID}
</session_id>

<objective>
${mission.objective}
</objective>

<completion_criterion>
${mission.completionCriterion}
</completion_criterion>

<budget>
turns ${turnLine} · tokens ${tokenLine} · wallclock ${wallLine}
</budget>

<verification_history>
${verifyLine}
</verification_history>
</mission_context>

<extra_context>
Supplementary guidance from the main agent. Treat as secondary to the objective and completion criterion above.
${originalPrompt}
</extra_context>`
}

