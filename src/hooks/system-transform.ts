// ─────────────────────────────────────────────────────────────────────────────
//  3-level system prompt injection (active / blocked / paused)
// ─────────────────────────────────────────────────────────────────────────────

import type { Hooks } from "@opencode-ai/plugin"
import type { MissionStore } from "../mission-store.js"
import { systemInjectForMission } from "../prompts-injection.js"

export interface SystemTransformHookDeps {
  store: MissionStore
  log?: (msg: string) => void
}

export function createSystemTransformHook(
  deps: SystemTransformHookDeps,
): Pick<Hooks, "experimental.chat.system.transform"> {
  const { store, log } = deps

  function debug(msg: string) {
    if (process.env.OPENCODE_MISSION_DEBUG === "1") {
      log?.(`[mission-pro] ${msg}`)
    }
  }

  return {
    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input.sessionID
      if (!sessionID) return
      try {
        const mission = await store.read(sessionID)
        if (!mission) return
        const inject = systemInjectForMission(mission)
        if (inject) {
          output.system.push(inject)
          debug(`injected system prompt for status=${mission.status} sessionID=${sessionID}`)
        }
      } catch (err) {
        debug(`system transform error: ${(err as Error).message}`)
      }
    },
  }
}
