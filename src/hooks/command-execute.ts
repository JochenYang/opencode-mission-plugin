// ─────────────────────────────────────────────────────────────────────────────
//  /mission command synthetic-ization hook
// ─────────────────────────────────────────────────────────────────────────────

import type { Hooks } from "@opencode-ai/plugin"

export function createCommandExecuteHook(): Pick<Hooks, "command.execute.before"> {
  return {
    "command.execute.before": async (input, output) => {
      if (input.command !== "mission") return

      // Mark all template-generated text parts as synthetic (hidden from user)
      for (const part of output.parts) {
        if ((part as any).type === "text") {
          ;(part as any).synthetic = true
        }
      }

      // Prepend a short user-visible summary
      const args = input.arguments?.trim() ?? ""
      const summary = args ? `/mission ${truncate(args, 60)}` : "/mission"
      output.parts.unshift({
        type: "text" as const,
        text: summary,
      } as any)
    },
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s
}
