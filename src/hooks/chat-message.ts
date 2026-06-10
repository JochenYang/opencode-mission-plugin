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
      log?.(`[mission-pro] ${msg}`)
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
          ;(part as any).text = subagentMissionContext(mission, (part as any).text)
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
      if (!report) return

      debug(`parsed verify report verdict=${report.verdict} sessionID=${input.sessionID}`)

      // Attach report to the parent session's mission
      await store.attachVerificationReport(session.parentID, report)

      if (report.verdict === "passed") {
        // Passed: automatically mark complete
        await store.markComplete(session.parentID, report)
        debug(`mission marked complete via verify sessionID=${input.sessionID}`)
      }
      // failed: do nothing; the main session will see the report and continue.
    },
  }
}

const JSON_BLOCK_RE = /```(?:json)?\s*(\{[\s\S]*?"verdict"[\s\S]*?\})\s*```/

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
