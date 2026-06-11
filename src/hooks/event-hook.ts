// ─────────────────────────────────────────────────────────────────────────────
//  Event hook: continuation + interrupt tracking + token accumulation
//
// Events handled:
// - session.idle     : primary continuation trigger
// - session.error    : interrupt tracking (distinguish user Esc vs runtime)
// - message.updated  : token accumulation (assistant role) + user message reset
// ─────────────────────────────────────────────────────────────────────────────

import type { Hooks } from "@opencode-ai/plugin"
import type { MissionStore } from "../mission-store.js"
import type { SessionHttp } from "../utils/session-http.js"
import { continuationPrompt } from "../prompts.js"
import { isOverBudget } from "../utils/format.js"
import type { AbortReason } from "../types.js"

export interface ContinuationHookDeps {
  store: MissionStore
  http: SessionHttp
  promptAsync: (sessionID: string, text: string) => Promise<void>
  log?: (msg: string) => void
}

interface LastTokenSnapshot {
  sessionID: string
  messageID: string
  total: number
}

export function createEventHook(deps: ContinuationHookDeps) {
  const { store, http, promptAsync, log } = deps
  const userAborted = new Set<string>()
  const runtimeErrored = new Set<string>()
  const lastTokens = new Map<string, LastTokenSnapshot>()
  const continuationInFlight = new Set<string>()

  function debug(msg: string) {
    if (process.env.OPENCODE_MISSION_DEBUG === "1") {
      log?.(`[mission] ${msg}`)
    }
  }

  return async function event({ event }: { event: any }) {
    const type = event?.type as string | undefined
    if (!type) return

    // LLM token-by-token output: every part.delta = LLM is actively generating
    if (type === "message.part.delta") {
      const sessionID = event.properties?.sessionID
      const field = event.properties?.field
      const delta = event.properties?.delta
      const len = typeof delta === "string" ? delta.length : 0
      debug(
        `message.part.delta sessionID=${sessionID} field=${field} len=${len}`,
      )
      return
    }

    // Interrupt tracking
    if (type === "session.error") {
      const props = event.properties ?? {}
      const sessionID: string | undefined = props.sessionID
      if (!sessionID) return
      const errorName = props.error?.name
      if (errorName === "MessageAbortedError") {
        // In opencode, MessageAbortedError corresponds to user-initiated abort.
        // Runtime errors carry ApiError / UnknownError / etc.
        userAborted.add(sessionID)
        debug(`session.error MessageAbortedError sessionID=${sessionID}`)
      } else {
        runtimeErrored.add(sessionID)
        debug(`session.error ${errorName} sessionID=${sessionID}`)
      }
      return
    }

    // User message: clear interrupt flags + reset token cache
    if (type === "message.updated") {
      const props = event.properties ?? {}
      const sessionID: string | undefined = props.sessionID
      if (!sessionID) return
      const info = props.info
      if (info?.role === "user") {
        userAborted.delete(sessionID)
        runtimeErrored.delete(sessionID)
        // Counters (continuationCount, turnsUsed, tokensUsed, wallClockMs) are
        // mission-lifetime and must NOT be reset on every user message —
        // otherwise /mission status mid-mission reports 0/0 even after many
        // continuations. New-mission initialization happens in
        // MissionStore.create() (see makeBudget), not here.
        lastTokens.delete(sessionID)
        debug(`user message: cleared interrupt flags + token cache sessionID=${sessionID}`)
        return
      }
      // Assistant message: accumulate tokens
      if (info?.role === "assistant") {
        const total = info.tokens?.total ?? 0
        const seen = lastTokens.get(sessionID)
        if (!seen || seen.messageID !== info.id) {
          // First time seeing this message, record baseline
          lastTokens.set(sessionID, {
            sessionID,
            messageID: info.id,
            total,
          })
          return
        }
        if (total > seen.total) {
          const delta = total - seen.total
          await store.recordTokenUsage(sessionID, delta)
          debug(`recordTokenUsage +${delta} sessionID=${sessionID} total=${total}`)
          lastTokens.set(sessionID, { sessionID, messageID: info.id, total })
        }
        return
      }
    }

    // Primary continuation trigger.
    // In opencode 1.17.x the EventV2 "session.idle" event is bridged onto
    // the GlobalBus as "session.status" (with status.type === "idle" on
    // the idle transition). Filter on both fields so we catch the right
    // transition regardless of which side of the bridge the type string
    // ends up on.
    if (type === "session.status") {
      const s = event.properties?.status
      debug(
        `session.status event: statusType=${typeof s === "string" ? s : s?.type} ` +
          `statusJson=${JSON.stringify(s)?.slice(0, 200)}`,
      )
    }
    if (
      type === "session.status" &&
      (event.properties?.status?.type === "idle" ||
        event.properties?.status === "idle")
    ) {
      const sessionID: string | undefined = event.properties?.sessionID
      if (!sessionID) return
      // Prevent re-entry
      if (continuationInFlight.has(sessionID)) {
        debug(`continuation already in flight, skip sessionID=${sessionID}`)
        return
      }
      continuationInFlight.add(sessionID)
      try {
        await maybeContinue(sessionID, userAborted, runtimeErrored)
      } finally {
        continuationInFlight.delete(sessionID)
      }
      return
    }
  }

  async function maybeContinue(
    sessionID: string,
    userAborted: Set<string>,
    runtimeErrored: Set<string>,
  ) {
    // 1. Read mission first; skip the network call entirely when no mission exists
    //    (the plugin is globally registered, so this fires for every opencode session;
    //    only active missions need sub-agent routing lookups)
    const mission = await store.read(sessionID)
    if (!mission) return

    // 2. Resolve parent session via http.getSession; skip subagent sessions.
    //    If getSession fails (returns null), fall through and treat the
    //    session as a main session so the continuation loop keeps running.
    //    On opencode 1.17.x the plugin process is often sandboxed away
    //    from the server, so a null result here is the common case — not
    //    an error worth aborting auto-continuation for.
    const session = await http.getSession(sessionID)
    if (session && session.parentID) {
      debug(`subagent session, skip sessionID=${sessionID}`)
      return
    }

    // 3. Distinguish abort reason
    let abortReason: AbortReason | undefined
    if (userAborted.has(sessionID)) {
      abortReason = "user"
      userAborted.delete(sessionID)
    } else if (runtimeErrored.has(sessionID)) {
      abortReason = "runtime"
      runtimeErrored.delete(sessionID)
    }

    if (abortReason) {
      debug(`session aborted (${abortReason}), marking mission sessionID=${sessionID}`)
      if (abortReason === "user") {
        await store.updateStatus(sessionID, "paused", "user", "User pressed Esc")
      } else {
        await store.markBlocked(sessionID, "Runtime error in last turn")
      }
      return
    }

    // 4. Continuation gate: mission must be active
    if (mission.status !== "active") {
      debug(`mission not active (${mission.status}), skip sessionID=${sessionID}`)
      return
    }

    // 5. Budget check
    await store.tickWallClock(sessionID)
    const fresh = await store.read(sessionID)
    if (!fresh) return
    if (isOverBudget(fresh)) {
      debug(`over budget, marking budget_limited sessionID=${sessionID}`)
      await store.markBudgetLimited(sessionID, "Budget exhausted at end of turn")
      return
    }

    // 6. Soft cap
    if (fresh.continuationCount > 100) {
      debug(`soft cap reached, marking blocked sessionID=${sessionID}`)
      await store.markBlocked(sessionID, "Continuation soft cap reached (100 turns)")
      return
    }

    // 7. Record continuation + dispatch
    const updated = await store.recordContinuation(sessionID)
    if (!updated) return
    debug(`continuing turn=${updated.continuationCount} sessionID=${sessionID}`)
    try {
      await promptAsync(sessionID, continuationPrompt(updated))
    } catch (err) {
      debug(`promptAsync failed: ${(err as Error).message}`)
    }
  }
}

// Hooks factory: package the event handler into the plugin's Hooks object.
export function createHooks(deps: ContinuationHookDeps): Pick<Hooks, "event"> {
  const handler = createEventHook(deps)
  return {
    event: async ({ event }) => handler({ event }),
  }
}
