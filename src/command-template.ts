// ─────────────────────────────────────────────────────────────────────────────
//  /mission command template
// ─────────────────────────────────────────────────────────────────────────────

export const MISSION_COMMAND_TEMPLATE = `You received a /mission command. Parse the subcommand from: $ARGUMENTS

## ABSOLUTE RULE (READ THIS FIRST)

For CREATE requests, your **single next tool call MUST be the \`CreateMission\` tool**. Do not:
- Call \`GetMission\` first to "check if there's an existing mission" (there isn't — you just received the command)
- Run a bash command to explore the filesystem first
- Read files to understand the workspace first
- Use todowrite to plan before calling CreateMission
- Ask the user clarifying questions about details you can infer

Just call \`CreateMission\` with the objective and completion criterion. THEN proceed with the work.

Only deviate from this rule if the user's intent is genuinely ambiguous (e.g. /mission with a typo like "/m ission").

## Subcommand Parser

## Subcommand Parser

You have FOUR mission tools available. Call them by these exact names:

- Empty / non-flag text → **call the \`CreateMission\` tool** with the text as objective and an inferred completion_criterion
- "status" → call the \`GetMission\` tool and display its output
- "pause" → call \`UpdateMission\` with status="paused"
- "resume" → call \`UpdateMission\` with status="active"
- "cancel" → call \`UpdateMission\` with status="cancelled"
- "budget" → parse further:
  - "budget show" → call \`GetMission\` and display the budget section
  - "budget set turns=N" | "budget set tokens=N" | "budget set time=30m" → call \`SetMissionBudget\` once with { value, unit } (one dimension at a time)
- "help" / "--help" / "-h" → display help

## Rules

1. /mission is the ONLY entry point for mission mode. Do NOT do the work directly without first calling \`CreateMission\`.
2. Your **first tool call** in response to a CREATE request must be \`CreateMission\`. Do NOT skip ahead to bash/write/read — call \`CreateMission\` first to record the mission in plugin storage, otherwise the rest of the plugin (continuation, self-audit, budget tracking, mission-verify) will not work.
3. For CREATE: you must specify BOTH objective AND completion_criterion.
   If the user only provided objective (via /mission <text>), INFER a reasonable completion_criterion
   and state it explicitly in your response. If the user's intent is unclear, ask for clarification
   BEFORE creating the mission.
4. After CREATE, work autonomously. The plugin will continue your work across multiple turns
   until the mission is achieved, blocked, or paused.

## Examples

User: /mission implement user login
→ First tool call: CreateMission({ objective: "implement user login", completionCriterion: "<inferable criterion>" })
→ Then proceed with implementation.

User: /mission status
→ Call GetMission and display its output.

User: /mission budget set turns=20
→ Call SetMissionBudget({ value: 20, unit: "turns" })

User: /mission budget set time=30m
→ Call SetMissionBudget({ value: 30, unit: "minutes" })

User: /mission cancel
→ Call UpdateMission({ status: "cancelled" })

## Self-audit reminder

Before declaring any mission done, run the 4-dimension self-audit:
1. Completeness — every item in the completion criterion is satisfied with current evidence.
2. Correctness — the work actually runs without errors; read the files you wrote, do not assume.
3. Integration — the new pieces fit the existing codebase.
4. Robustness — edge cases are handled.

A plan, summary, or first pass is NOT a complete result. If any dimension fails, do the missing work and re-audit.

After 4-dimension self-audit:
- **All four pass**: you MUST call the \`task\` tool with \`subagent_type: "mission-verify"\` IMMEDIATELY in the same turn. Do NOT stop, do NOT ask the user, do NOT wait for confirmation. The verify is REQUIRED, not optional.

## task tool contract (OpenCode)

When spawning mission-verify (or any subagent) via the task tool:

1. For a **new** verification run, call task with \`subagent_type: "mission-verify"\` and **omit task_id completely**.
2. Never invent a task_id. Never pass a UUID, punchcard TID, mission id, or random string.
3. OpenCode session ids always start with ses (e.g. ses_...). Only reuse a task_id that a previous successful task result returned, and only when you intentionally resume that same subagent session.
4. If a previous task call failed with Expected a string starting with "ses", retry **without** task_id.

- **Any dimension fails**: do the missing work in this turn and re-audit. Do NOT stop to ask the user.
- **Cannot make all four pass**: call \`UpdateMission status="blocked"\` with a clear reason.

## PowerShell shell habits (READ THIS)

You are running in a PowerShell-on-Windows shell inside opencode. Two things will block your turn if mishandled:

- **Permission prompts** — opencode will pop a permission dialog for every unfamiliar bash command. If you start a long-running server, the dialog blocks, the user has to manually approve, and the turn appears "stuck".
- **Detached processes** — \`Start-Process\` with no \`-Wait\` leaves the parent shell waiting on an interactive prompt (\`Id:\`). The fix is \`-NoNewWindow -PassThru\`, AND wrap in \`(...)\` + access \`.Id\` directly (NEVER pipe to \`Select-Object Id\` — that pipeline hangs in opencode's stdio host).

### Avoiding permission prompts

1. The shell tool is pre-configured with \`"permission": {"bash": {"*": "allow"}}\` for the workspace (see \`~/.config/opencode/opencode.json\`). Most commands will NOT prompt.
2. Destructive patterns still prompt: \`Remove-Item *\`, \`rm -rf *\`, \`cmdkey /delete*\`, etc. The user has explicitly asked for these to remain prompting.

### CRITICAL: one command per bash call (NEVER chain with \`;\`)

opencode parses each \`bash\` invocation with a real shell AST. When you chain several commands with \`;\` (or pipeline \`|\`), the entire multi-statement tree is treated as a SINGLE unit. If any sub-command matches an \`ask\` pattern (e.g. \`Remove-Item *\`), the WHOLE composite command prompts — even sub-commands that would individually be \`allow\`.

This means: **a 5-step \`;\`-chained command triggers exactly one permission dialog**, and the dialog shows the entire script (hard to read), and the user has to approve/deny in bulk.

**Always run each step in its own \`bash\` tool call.** When you have several small steps, prefer:

- One \`bash\` per command (preferred; no permission flicker, easy to debug)
- A short \`bash\` script file in the workspace, then invoke it once (acceptable; the script becomes a known pattern the user can "always allow")

Example — bad:

\`\`\`powershell
Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 2; Remove-Item $log -ErrorAction SilentlyContinue; Start-Process -FilePath "cmd.exe" -ArgumentList "/c","npm run start" ...
\`\`\`

Example — good:

\`\`\`powershell
# Step 1: kill any old node
Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# Step 2: clean log
Remove-Item "C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\opencode\\dev.log" -ErrorAction SilentlyContinue

# Step 3: start backend
$pid = (Start-Process -FilePath "node.exe" -ArgumentList "server.js" -WorkingDirectory "D:\\codes\\mission-test-todo" -RedirectStandardOutput "C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\opencode\\dev.log" -RedirectStandardError "C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\opencode\\dev.err" -NoNewWindow -PassThru).Id

# Step 4: verify the detached process is actually alive (Start-Process -PassThru returns PID before Node is up)
Start-Sleep -Milliseconds 500
Get-Process -Id $pid -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, StartTime

# Step 5: wait for boot
Start-Sleep -Seconds 3

# Step 6: probe
try { (Invoke-RestMethod -Uri "http://localhost:3001/api/properties" -TimeoutSec 5).Count } catch { "FAILED" }
\`\`\`

The user can press \`a\` (Allow always) once per \`bash\` call. With 5 separate calls the user has at most 5 small approvals (usually 0–1 thanks to the \`*\` allow rule), instead of one giant dialog blocking the whole turn.

### Starting a dev server in one turn

\`\`\`powershell
$log = "C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\opencode\\my-backend.log"
Remove-Item $log -ErrorAction SilentlyContinue
Push-Location "<absolute path to backend workspace>"
Start-Process -FilePath "cmd.exe" -ArgumentList "/c","npm run start" \\
    -RedirectStandardOutput $log -RedirectStandardError "$log.err" -NoNewWindow -PassThru | \\
    Select-Object Id
Pop-Location
Start-Sleep -Seconds 3
\`\`\`

### Probing endpoints

\`\`\`powershell
try {
  $r = Invoke-RestMethod -Uri "http://localhost:3001/api/properties" -TimeoutSec 5
  "count=$($r.Count)"
} catch { "FAILED: $($_.Exception.Message)" }
\`\`\`

Frontend / admin (Vite) can be checked via \`Invoke-WebRequest -Uri http://localhost:5173 -UseBasicParsing -TimeoutSec 5 | Select-Object -ExpandProperty StatusCode\`.

### Killing the dev server before the turn ends

\`\`\`powershell
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt (Get-Date).AddMinutes(-2) } | \\
    Stop-Process -Force -ErrorAction SilentlyContinue
\`\`\`

### Long-lived inspection (server stays up across turns)

If the user needs the server running to look at it, leave it running and report the URL in your final message. Do NOT block the turn waiting for it.

## Begin

Parse the arguments and execute the corresponding tool call.`
