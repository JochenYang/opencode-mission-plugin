// ─────────────────────────────────────────────────────────────────────────────
//  Plugin entry: wires all hooks together
//
// Hooks:
// - tool: 4 standalone tools (CreateMission / UpdateMission / GetMission / SetMissionBudget)
// - config: inject /mission command template + mission-verify subagent
// - chat.message: inject mission context into verify subagent's user message
// - experimental.text.complete: parse verify JSON report
// - experimental.chat.system.transform: 3-level system prompt injection
// - command.execute.before: mark /mission template as synthetic
// - event: continuation + interrupt tracking + token accumulation
// ─────────────────────────────────────────────────────────────────────────────

import type { Plugin, PluginModule, PluginInput, Hooks } from "@opencode-ai/plugin"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { MissionStore } from "./mission-store.js"
import { createSessionHttp, extractV1Client } from "./utils/session-http.js"
import { createMissionTool } from "./tools/create-mission.js"
import { updateMissionTool } from "./tools/update-mission.js"
import { getMissionTool } from "./tools/get-mission.js"
import { setMissionBudgetTool } from "./tools/set-mission-budget.js"
import { createEventHook } from "./hooks/event-hook.js"
import { createChatMessageHook } from "./hooks/chat-message.js"
import { createSystemTransformHook } from "./hooks/system-transform.js"
import { createCommandExecuteHook } from "./hooks/command-execute.js"
import { MISSION_COMMAND_TEMPLATE } from "./command-template.js"
import { VERIFY_AGENT_PROMPT } from "./verify/verify-prompt.js"

const serverPlugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  // Client initialization.
  // The plugin runtime injects a V1 HeyApi client (input.client._client) whose
  // patch/get already carry baseUrl, headers, fetch, and auth.
  const v1Client = extractV1Client(input.client)
  const http = createSessionHttp({ v1Client, baseUrl: input.serverUrl.origin })

  // V2 client is only used for promptAsync (V2 SDK exposes it).
  const v2Client = createOpencodeClient({
    baseUrl: input.serverUrl.origin,
    headers: v1Client?.getConfig?.()?.headers,
    fetch: v1Client?.getConfig?.()?.fetch,
  })
  const store = new MissionStore(http)

  const log = (msg: string) => {
    console.error(msg)
  }

  // Tool registration
  const createTool = createMissionTool(store)
  const updateTool = updateMissionTool(store)
  const getTool = getMissionTool(store, http)
  const budgetTool = setMissionBudgetTool(store)

  // Hooks
  const eventHook = createEventHook({
    store,
    http,
    promptAsync: async (sessionID, text) => {
      await v2Client.session.promptAsync({
        sessionID,
        parts: [{ type: "text" as const, text, synthetic: true }],
      })
    },
    log,
  })

  const chatMessageHook = createChatMessageHook({ store, http, log })
  const systemTransformHook = createSystemTransformHook({ store, log })
  const commandExecuteHook = createCommandExecuteHook()

  return {
    tool: {
      CreateMission: createTool,
      UpdateMission: updateTool,
      GetMission: getTool,
      SetMissionBudget: budgetTool,
    },

    config: async (cfg: any) => {
      // Inject /mission command
      if (!cfg.command) cfg.command = {}
      if (!cfg.command["mission"]) {
        cfg.command["mission"] = {
          template: MISSION_COMMAND_TEMPLATE,
          description: "Manage autonomous mission mode (create/status/pause/resume/cancel/budget).",
        }
      }

      // Inject mission-verify subagent
      if (!cfg.agent) cfg.agent = {}
      if (!cfg.agent["mission-verify"]) {
        cfg.agent["mission-verify"] = {
          mode: "subagent",
          description:
            "Independent mission verification agent. Reads the active mission via GetMission, then inspects the codebase to determine whether the completion criterion is met. Returns a structured 4-dimension JSON report (completeness/correctness/integration/robustness). Use this agent via the Task tool when you believe the mission is done.",
          prompt: VERIFY_AGENT_PROMPT,
        }
      }
    },

    event: eventHook,
    "chat.message": chatMessageHook["chat.message"],
    "experimental.text.complete": chatMessageHook["experimental.text.complete"],
    "experimental.chat.system.transform": systemTransformHook["experimental.chat.system.transform"],
    "command.execute.before": commandExecuteHook["command.execute.before"],
  } as any
}

const pluginModule: PluginModule = {
  id: "opencode-mission",
  server: serverPlugin,
}

export default pluginModule
