# opencode-mission

**English** | [**中文**](README.md)

[![npm version](https://img.shields.io/npm/v/opencode-mission?style=flat-square)](https://www.npmjs.com/package/opencode-mission)
[![License: MIT](https://img.shields.io/npm/l/opencode-mission?style=flat-square)](https://github.com/JochenYang/opencode-mission-plugin/blob/main/LICENSE)
[![Node >=18](https://img.shields.io/badge/Node-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://www.npmjs.com/package/opencode-mission)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![GitHub stars](https://img.shields.io/github/stars/JochenYang/opencode-mission-plugin?style=flat-square)](https://github.com/JochenYang/opencode-mission-plugin)

An OpenCode plugin that adds an autonomous mission-driven agent mode: the user sets a mission, the agent works across multiple turns until the mission is achieved, paused, or blocked.

## Features

| Feature                        | Description                                                              |
| ------------------------------ | ------------------------------------------------------------------------ |
| **5-state machine**            | `active / paused / blocked / budget_limited / complete` (distinguishes user stop, system stop, system limit) |
| **3-dimension budget**         | `turn / token / wallclock`, independently configurable, auto-`budget_limited` on exceed |
| **3-turn block threshold**     | Agent-declared blocked requires 3 consecutive same-reason attempts (prevents premature declarations) |
| **judge react cap**            | 5 failed verdicts in a row auto-transitions to `budget_limited` (prevents infinite verify loops) |
| **4 standalone tools**         | `CreateMission` / `UpdateMission` / `GetMission` / `SetMissionBudget`         |
| **Independent verify subagent** | 4-dimension scoring (completeness/correctness/integration/robustness) → auto mark complete |
| **Status-adaptive system prompt** | `<mission_status>` block + dynamic commands + 3-turn reminder + wrap-up directive |
| **Self-audit**                 | Every turn's continuation prompt + system prompt force a 4-dim self-check       |
| **Interrupt semantics**        | User Esc → `paused` (wallclock frozen) / runtime error → `blocked`              |
| **Pluggable storage**  | Default: self-managed JSON at `~/.config/opencode/missions/<workspace>/<sessionID>.json`. Optional: opencode session metadata mode |

## Installation

### Recommended: install from npm (auto-configures)

```bash
npm install -g opencode-mission
# or: bun add -g opencode-mission
```

The `postinstall` script will automatically:

1. Copy `dist/index.js` to `~/.config/opencode/plugins/opencode-mission.js`
2. Add `./plugins/opencode-mission.js` to the `plugin` array in `~/.config/opencode/opencode.json` (skipped if already present)
3. On uninstall (`npm uninstall -g opencode-mission`), remove the entry from `opencode.json`

> Cross-platform: `~/.config/opencode/` (overridable via `$XDG_CONFIG_HOME`).

### Manual install (development or custom build)

Add to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "./plugins/opencode-mission.js"
  ]
}
```

For project-level install, drop the file into `./.opencode/plugins/` or the project root's `opencode.json`.

Build and install:

```bash
bun run build
cp dist/index.js ~/.config/opencode/plugins/opencode-mission.js
```

## Usage

### Start a mission

```
/mission implement a tool: add /src/math.ts exporting add/subtract/mul/div, with unit tests. Completion criterion: bun test 4 pass / 0 fail
```

The agent will **strictly**:

1. First tool call MUST be `CreateMission` (do not explore first)
2. Write code + run tests
3. Spawn the mission-verify subagent for independent audit
4. Auto mark complete after audit passes

### Status

```
/mission status
```

### Lifecycle

```
/mission pause     # pause (freezes wallclock)
/mission resume    # resume
/mission cancel    # cancel (clears the record)
```

### Budget (**optional**, missions work without it)

`SetMissionBudget` sets one dimension per call (prevents LLM from picking wrong units). **Missions work without any budget set** — the plugin only enforces a soft cap (100 continuation turns) to prevent infinite loops. Set budgets for long tasks, but **skip them for short ones**:

```
/mission budget set turns=20        # max 20 continuation turns
/mission budget set tokens=500000   # max 500k tokens
/mission budget set time=30m        # max 30 minutes wall-clock
/mission budget show                # inspect current budget
```

Supported units: `turns`, `tokens`, `milliseconds`, `seconds`, `minutes`, `hours` (wall-clock range 1s-24h).

## Tools

| Tool                | Main session | Subagent (mission-verify) | Purpose                                                |
| ------------------- | ------------ | -------------------------- | ------------------------------------------------------ |
| `CreateMission`     | yes          | no                         | Create a new mission (requires `objective` + `completionCriterion`) |
| `UpdateMission`     | yes          | no (only via verify)       | Transition status: `active / paused / blocked / cancelled` |
| `GetMission`        | yes          | yes (reads parent)         | Read current mission state                            |
| `SetMissionBudget`  | yes          | no                         | Adjust budget limits (one dimension per call)          |

## Verification

The main session never declares a mission complete by itself. Completion path:

1. Main session spawns `mission-verify` subagent via the Task tool.
2. Subagent calls `GetMission` → inspects code → runs tests → outputs 4-dimension JSON score.
3. Plugin's `experimental.text.complete` hook parses the JSON:
   - `verdict="passed"` (all 4 dimensions >= 3 AND completeness >= 3) → auto mark `complete`
   - `verdict="failed"` → report attached to mission, main session continues

## Self-audit

Every continuation prompt AND the active system prompt force a 4-dimension check:

1. **Completeness** — every completion-criterion item has current evidence
2. **Correctness** — code actually runs, not "I plan to write it"
3. **Integration** — fits existing codebase style
4. **Robustness** — edge cases handled

A plan / summary / first pass is NOT a complete result.

## Bash protocol (must read)

The agent runs in a PowerShell-on-Windows shell inside opencode. **Avoid**:

- ❌ **NEVER chain commands with `;`** — opencode parses each `bash` invocation with a real shell AST. The whole multi-statement tree is treated as a single unit. If any sub-command matches an `ask` pattern (e.g. `Remove-Item *`), the WHOLE composite command prompts — even sub-commands that would individually be `allow`. **One step per `bash` call.**
- ❌ **NEVER `Start-Process` without `-NoNewWindow -PassThru`** — it detaches and leaves the parent shell waiting on an interactive `Id:` prompt.
- ✅ Start a dev server in the background:
  ```powershell
  $log = "C:\Users\ADMINI~1\AppData\Local\Temp\opencode\dev.log"
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c","npm run start" `
      -RedirectStandardOutput $log -RedirectStandardError "$log.err" `
      -NoNewWindow -PassThru | Select-Object Id
  Start-Sleep -Seconds 3
  ```
- ✅ Probe endpoints with `Invoke-RestMethod` or `curl`.
- ✅ Clean up before exit:
  ```powershell
  Get-Process node -ErrorAction SilentlyContinue | `
      Where-Object { $_.StartTime -gt (Get-Date).AddMinutes(-2) } | `
      Stop-Process -Force -ErrorAction SilentlyContinue
  ```

## Test it

Launch opencode TUI:

```bash
opencode
```

Then in the TUI prompt:

```
/mission in `./test-mission/` create a Node.js package (type:module): 1) package.json with name='test-mission', version='1.0.0', type='module', scripts.test='bun test'; 2) src/index.js exporting add(a,b)=a+b; 3) src/index.test.js with bun:test, 2+ tests covering add; 4) bun test all pass. Completion: bun test outputs 2+ passed 0 failed; add(2,3)=5. Budget: turns=10 tokens=100000 time=5m
```

**Observe**:
- agent's first tool call should be `CreateMission`
- mission-verify subagent gets spawned
- mission auto-completes; `GetMission` returns "No active mission"

## Storage

Mission state lives directly inside the opencode session's metadata column (via `PATCH /session/:sessionID`). **Requires opencode >= 1.17.11** (the PATCH endpoint has shipped there).

Two free side benefits:

- **Session fork inheritance** — when a session is forked, the opencode server copies the parent's `Session.metadata` into the child automatically. The new session already has the mission, no plugin wiring required.
- **Centralized backup** — mission state rides along with the rest of the user's opencode data (sessions, messages, etc.) in the SQLite store, no separate mission file to back up.

**Gotchas**:

- If you fork a session and want the new session to keep the mission, read from the **parent** session's ID (not the fork's own ID).
- The old `OPENCODE_MISSION_STORAGE=file` mode has been removed as of 0.3.0.

## Known limitations

- **Continuation + interrupt tracking depends on `EventSessionIdle`**: works in interactive TUI; `opencode run` (headless) does not emit this event.
- **Verify JSON parsing** depends on the subagent emitting a strict `\`\`\`json { verdict, scores } \`\`\`` block.
- **Sub-agent routing** uses `globalThis.fetch` to call `/api/session/{id}`. On opencode 1.17.x the plugin process may be sandboxed away from the server; the fallback returns `null` which is safe for the main flow (sub-agent routing becomes a known limitation).

## Development

```bash
bun install
bun run typecheck      # tsc --noEmit
bun run build          # bun build -> dist/index.js
```

## License

MIT