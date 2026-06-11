// ─────────────────────────────────────────────────────────────────────────────
//  chat.message hook
//
// Two responsibilities:
// 1. Verify subagent's user message: inject mission context
// 2. Verify subagent's assistant message: parse JSON report
// ─────────────────────────────────────────────────────────────────────────────

import type { Hooks } from "@opencode-ai/plugin"
import type { MissionStore } from "../mission-store.js"
import type { SessionHttp } from "../utils/session-http.js"
import { subagentMissionContext } from "../verify/verify-context.js"
import type { VerificationReport } from "../types.js"

export interface ChatMessageHookDeps {
  store: MissionStore
  http: SessionHttp
  log?: (msg: string) => void
}

export function createChatMessageHook(deps: ChatMessageHookDeps): Pick<Hooks, "chat.message" | "experimental.text.complete"> {
  const { store, http, log } = deps

  function debug(msg: string) {
    if (process.env.OPENCODE_MISSION_DEBUG === "1") {
      log?.(`[mission] ${msg}`)
    }
  }

  return {
    "chat.message": async (input, output) => {
      // Only act on the mission-verify subagent
      if (input.agent !== "mission-verify") return

      // Find the parent session
      const session = await http.getSession(input.sessionID)
      if (!session?.parentID) return

      const mission = await store.read(session.parentID)
      if (!mission) return

      // Inject mission context into the user message
      for (const part of output.parts) {
        if ((part as any).type === "text" && (part as any).text) {
          ;(part as any).text = subagentMissionContext(
            mission,
            (part as any).text,
            session.parentID,
          )
        }
      }
      debug(`injected mission context into verify subagent sessionID=${input.sessionID}`)
    },

    /**
     * experimental.text.complete:
     * When a verify subagent finishes a text part, try to parse the JSON
     * verification report. If verdict="passed", automatically mark complete.
     */
    "experimental.text.complete": async (input, output) => {
      // Only act on the mission-verify subagent
      const session = await http.getSession(input.sessionID)
      if (!session?.parentID) return

      const text = output.text
      if (!text || !text.includes("verdict")) return

      const report = tryParseVerifyJson(text)
      const parentID = session.parentID

      if (!report) {
        // Fail-open: the judge failed to produce parseable output. Without
        // this fallback, a persistent parse failure traps the user in
        // mission mode forever (continuation keeps firing, mission never
        // completes). Attach a synthetic "judgeFailed" report and mark
        // complete so the user can move on; the report flags the gap so
        // it's visible in the mission history.
        const failOpen: VerificationReport = {
          verifiedAt: Date.now(),
          verdict: "failed",
          judgeFailed: true,
          reason: "verify subagent output was not a parseable JSON report",
          scores: emptyScores("judge produced no parseable output"),
        }
        await store.attachVerificationReport(parentID, failOpen)
        await store.markComplete(parentID, failOpen)
        debug(`judge failed to produce parseable output; failing open sessionID=${parentID}`)
        return
      }

      debug(`parsed verify report verdict=${report.verdict} sessionID=${input.sessionID}`)

      // Attach report to the parent session's mission
      await store.attachVerificationReport(parentID, report)

      if (report.verdict === "passed") {
        // Passed: automatically mark complete
        await store.markComplete(parentID, report)
        debug(`mission marked complete via verify sessionID=${input.sessionID}`)
        return
      }

      // Failed: increment judge react counter; cap at MAX_JUDGE_REACT
      // to prevent infinite verify loops when the judge keeps rejecting
      // without the agent making progress.
      const { capped } = await store.recordJudgeReactAttempt(parentID)
      if (capped) {
        debug(
          `judge react cap reached; mission auto-budget_limited sessionID=${parentID}`,
        )
      }
    },
  }
}

const JSON_BLOCK_RE = /```(?:json)?\s*(\{[\s\S]*?"verdict"[\s\S]*?\})\s*```/

function emptyScores(evidence: string): VerificationReport["scores"] {
  const dim = (): VerificationReport["scores"][keyof VerificationReport["scores"]] => ({
    score: 0,
    evidence,
  })
  return {
    completeness: dim(),
    correctness: dim(),
    integration: dim(),
    robustness: dim(),
  }
}

export function tryParseVerifyJson(text: string): VerificationReport | null {
  const match = text.match(JSON_BLOCK_RE)
  if (!match) return null
  const raw = match[1]
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed.verdict !== "string") return null
    if (parsed.verdict !== "passed" && parsed.verdict !== "failed") return null
    if (!parsed.scores) return null
    const dims = ["completeness", "correctness", "integration", "robustness"] as const
    for (const d of dims) {
      const s = parsed.scores[d]
      if (!s || typeof s.score !== "number") return null
    }
    return parsed as VerificationReport
  } catch {
    return null
  }
}
