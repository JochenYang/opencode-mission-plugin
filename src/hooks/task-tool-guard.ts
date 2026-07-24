// ─────────────────────────────────────────────────────────────────────────────
//  Task tool guard hook
//
//  OpenCode's native `task` tool validates `task_id` as a branded SessionID,
//  which must start with "ses_". If the model invents a UUID, punchcard TID,
//  or random string as `task_id` (a common failure when spawning
//  `mission-verify`), OpenCode rejects the call at the schema layer with:
//
//     Expected a string starting with "ses"
//
//  This hook intercepts `tool.execute.before` for the task tool and strips
//  any `task_id` that is not a valid `ses*` session id. The call then
//  proceeds as a fresh subagent session, which is the correct behavior for
//  a new `mission-verify` dispatch.
// ─────────────────────────────────────────────────────────────────────────────

import type { Hooks } from "@opencode-ai/plugin"

export interface TaskToolGuardHookDeps {
  log?: (msg: string) => void
}

export function createTaskToolGuardHook(
  deps?: TaskToolGuardHookDeps,
): Pick<Hooks, "tool.execute.before"> {
  const { log } = deps ?? {}

  function debug(msg: string) {
    if (process.env.OPENCODE_MISSION_DEBUG === "1") {
      log?.(`[mission] ${msg}`)
    }
  }

  return {
    "tool.execute.before": async (input, output) => {
      const toolName = input?.tool
      if (toolName !== "task" && toolName !== "Task") return

      const args = (output as any)?.args
      if (!args || typeof args !== "object") return

      const taskId = args.task_id
      if (taskId == null) return

      if (taskId === "" || typeof taskId !== "string" || !taskId.startsWith("ses")) {
        debug(
          `stripping invalid task_id=${String(taskId)} (must start with ses or be omitted)`,
        )
        delete args.task_id
      }
    },
  }
}
