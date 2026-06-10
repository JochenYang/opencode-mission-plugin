# opencode-mission · Design

> An OpenCode plugin that adds an autonomous mission-driven agent mode: the user sets a mission, the agent works across multiple turns until the mission is achieved, paused, or blocked.

## 1. Overview

| Aspect                 | Design                                                              |
| ---------------------- | ------------------------------------------------------------------- |
| State machine          | `active / paused / blocked / complete` (4 states)                   |
| Budget                 | turn / token / wallclock (3 dimensions, independently configurable) |
| Tools                  | 4 standalone tools                                                 |
| Continuation trigger   | `EventSessionIdle` (primary), `EventSessionError` (interrupt)      |
| Prompt injection       | 3-level system injection (active / blocked / paused)               |
| Interrupt semantics    | user Esc -> `paused` (wallclock frozen), runtime error -> `blocked` |
| Verification           | 4-dimension structured scoring + JSON report                       |
| Storage                | `Session.metadata.missionPro` (namespaced, V1 HeyApi client)      |

## 2. State machine

```
                +----------+
   create ----> |  active  | <---- resume (from paused/blocked)
                +----+-----+
                     |
        +------------+------------+----------------+
        v            v            v                v
   +---------+  +----------+  +----------+    (cleared)
   | paused  |  | blocked  |  | complete |     cancel
   +---------+  +----------+  +----------+
   user Esc    budget/error   verify passed
```

| from \\ to          | active | paused | blocked | complete | (cleared) |
| ------------------- | ------ | ------ | ------- | -------- | --------- |
| (none)              | create | -      | -       | -        | -         |
| active              | -      | user   | runtime | verify   | cancel    |
| paused              | resume | -      | -       | -        | cancel    |
| blocked             | resume | -      | -       | -        | cancel    |
| complete            | -      | -      | -       | -        | cancel    |

Implementation: `src/mission-store.ts:assertTransition`.

## 3. Data model

State lives in `Session.metadata.missionPro` (JSON column, auto-serialized):

```ts
interface Mission {
  id: string
  objective: string
  completionCriterion: string
  status: MissionStatus
  createdAt: number
  updatedAt: number
  createdBy: MissionActor
  updatedBy: MissionActor
  continuationCount: number
  lastContinuationAt?: number
  budget: MissionBudget
  terminalReason?: string
  verificationReport?: VerificationReport
}

interface MissionBudget {
  turnLimit?: number
  tokenLimit?: number
  wallClockLimitMs?: number
  turnsUsed: number
  tokensUsed: number
  wallClockMs: number
  wallClockStartedAt?: number
  wallClockPausedAt?: number
  totalPausedMs: number
}
```

Full schema in `src/types.ts`.

## 4. Persistence layer

Mission reads/writes go through `src/utils/session-http.ts`, which uses the **V1 HeyApi client** injected by the plugin runtime:

```ts
const v1Client = (input.client as any)._client
await v1Client.get({ url: `${baseUrl}/session/${sessionID}` })
await v1Client.patch({ url: `${baseUrl}/session/${sessionID}`, body: { metadata } })
```

Why V1 client (not bare `fetch`):

- V1 client wraps fetch with proper baseUrl, auth headers, and response parsing.
- The SDK 1.4.8 type definition for `SessionUpdateData.body` does not declare `metadata`, but the opencode 1.16.x server accepts it. We pass it through the client; the V1 wrapper handles the response cleanly.
- Reusing the runtime-injected client keeps cookies and auth consistent with other opencode tools.

Storage key: `Session.metadata.missionPro` (namespaced to coexist with other mission plugins).

## 5. Tools

| Tool                | Main session | Subagent (mission-verify) | Purpose                                                |
| ------------------- | ------------ | -------------------------- | ------------------------------------------------------ |
| `CreateMission`     | yes          | no                         | Create a new mission (requires `objective` + `completionCriterion`) |
| `UpdateMission`     | yes          | no (only via verify)       | Transition status: `active / paused / blocked / cancelled` |
| `GetMission`        | yes          | yes (reads parent)         | Read current mission state                            |
| `SetMissionBudget`  | yes          | no                         | Adjust budget limits (one dimension per call)          |

- `ToolContext.agent` distinguishes the main session (`"build"`) from subagents.
- The `mission-verify` subagent is the only subagent allowed to call `UpdateMission`.
- Dynamic tool visibility is not supported by the public plugin API. Each tool internally rejects calls with no active mission and a friendly error.

### 5.1 SetMissionBudget: single-dimension-per-call

`SetMissionBudget` accepts `{ value: number, unit: 'turns'|'tokens'|'milliseconds'|'seconds'|'minutes'|'hours' }` — one dimension per call. The LLM cannot send ambiguous wallclock amounts (e.g. "30" — seconds or ms?) because the unit is a closed enum. To set three dimensions, the agent calls the tool three times.

## 6. Continuation mechanism

Primary trigger: `EventSessionIdle` (dedicated event in opencode 1.4.8+).

The event hook (`src/hooks/event-hook.ts`) does the following on each `session.idle`:

1. Skip subagent sessions (have `parentID`).
2. Read the mission; skip if not `active`.
3. If `EventSessionError` with `MessageAbortedError` was seen -> transition to `paused`.
4. If `EventSessionError` with any other error name was seen -> transition to `blocked`.
5. Tick wallclock; if over budget -> mark `blocked`.
6. Soft cap of 100 continuation turns.
7. Otherwise: increment `continuationCount`, dispatch a synthetic continuation prompt via `v2Client.session.promptAsync`.

In-memory tracking:

- `userAborted: Set<sessionID>` — populated by `EventSessionError` with `MessageAbortedError`.
- `runtimeErrored: Set<sessionID>` — populated by other error names.
- `lastTokens: Map<sessionID, { messageID, total }>` — token accumulation via `EventMessageUpdated` (assistant role). Delta is computed as `current total - last seen total`.
- `continuationInFlight: Set<sessionID>` — re-entry guard.

## 7. Prompt injection

Three levels of system prompt injection via `experimental.chat.system.transform`:

- `active`: full objective + completion criterion + budget usage + budget guidance (healthy/moderate/tight/exhausted) + behavior hints (use subagent for verify, etc.) + **4-dimension self-audit**.
- `blocked`: lightweight hint + reason, do not pursue autonomously.
- `paused`: guardrail hint, do not work unless the user explicitly asks to continue.

`chat.message` injects the mission context into the `mission-verify` subagent's user message.

`experimental.text.complete` parses the subagent's final text output for a JSON block (`verdict + scores`). If `verdict === "passed"` (and all scores >= 3, completeness >= 3), the mission is auto-marked `complete` in the parent session.

## 8. Self-audit (4-dimension pre-declare checklist)

Both the continuation prompt (`src/prompts.ts`) and the active system injection (`src/prompts-injection.ts`) include:

1. **Completeness** — every completion-criterion item is satisfied with current evidence
2. **Correctness** — the work actually runs without errors; read the files you wrote, do not assume
3. **Integration** — the new pieces fit the existing codebase (imports resolve, types match, conventions followed)
4. **Robustness** — the obvious edge cases are handled (empty input, error paths, boundary values)

The continuation prompt also enforces:

- "A plan, summary, or first pass is NOT a complete result."
- "Do not mark complete after only producing a plan, summary, first pass, or partial result."
- The agent must run the self-audit before considering the work complete.

## 9. Verification subagent

Registered via the `config` hook. Description: independent verifier that reads `GetMission`, inspects the codebase, runs tests, and outputs a 4-dimension JSON report.

Scoring scale (apply uniformly):

- 0 = not delivered / completely broken
- 1 = major gaps / severe defects
- 2 = partial / significant issues
- 3 = substantially done / minor issues
- 4 = fully delivered and correct

Pass condition: `verdict === "passed"` iff all 4 dimensions >= 3 AND completeness >= 3.

The subagent is read-only (no write/edit tools) — verification is by inspection, tests, and read commands.

The plugin auto-completes the mission when `experimental.text.complete` intercepts a `verdict === "passed"` JSON block in the subagent's final text.

## 10. Command surface

`/mission` is a single command with subcommands parsed by the LLM via the `MISSION_COMMAND_TEMPLATE` (`src/command-template.ts`):

| Subcommand                              | Effect                                                |
| --------------------------------------- | ----------------------------------------------------- |
| `/mission <text>`                       | Create mission with `<text>` as objective             |
| `/mission status`                       | Show current mission                                  |
| `/mission pause / resume / cancel`      | Lifecycle transitions                                  |
| `/mission budget show`                  | Display budget section                                 |
| `/mission budget set turns=N`           | Set turn limit (one dimension per call)               |
| `/mission budget set tokens=N`          | Set token limit                                       |
| `/mission budget set time=30m`          | Set wall-clock limit                                  |
| `/mission help`                         | Display help                                          |

### 10.1 The ABSOLUTE RULE

The command template opens with an ABSOLUTE RULE instructing the LLM to make `CreateMission` its **first** tool call — no `GetMission` to "check if there's an existing mission", no `bash` to explore, no `todowrite` to plan. Just call `CreateMission`. This bypasses the LLM's strong default of "look before you leap" which would otherwise skip past the mission tool entirely and complete the task in normal mode.

## 11. Bash protocol

The command template also includes a bash protocol that warns the LLM about two failure modes that block turns in this environment:

1. **Permission dialogs**: opencode matches bash patterns against the `permission` config; if the LLM chains multiple commands with `;`, the shell AST parser treats the whole chain as one node, and any sub-command matching an `ask` pattern (e.g. `Remove-Item *`) blocks the entire turn.
2. **Detached processes**: `Start-Process` without `-NoNewWindow -PassThru` leaves the parent shell waiting on an interactive `Id:` prompt.

Protocol rules: one `bash` call per command; start dev servers in the background with explicit output redirection; probe endpoints with `Invoke-RestMethod`; clean up via `Get-Process | Where-Object | Stop-Process` before turn end.

## 12. File structure

```
opencode-mission/
├── src/
│   ├── index.ts                       # Entry: hooks wiring
│   ├── types.ts                       # Type definitions
│   ├── mission-store.ts               # State machine + budget accumulation
│   ├── command-template.ts            # /mission command template + ABSOLUTE RULE + bash protocol
│   ├── prompts.ts                     # Continuation prompt + self-audit
│   ├── prompts-injection.ts           # 3-level system prompt injection + self-audit
│   ├── tools/
│   │   ├── create-mission.ts
│   │   ├── update-mission.ts
│   │   ├── get-mission.ts
│   │   └── set-mission-budget.ts      # { value, unit } one-dim-per-call
│   ├── hooks/
│   │   ├── event-hook.ts              # Continuation + interrupt + token accumulation
│   │   ├── chat-message.ts            # Verify subagent context + JSON parse
│   │   ├── system-transform.ts        # System prompt 3-level injection
│   │   └── command-execute.ts         # /mission synthetic-ization
│   ├── verify/
│   │   ├── verify-prompt.ts           # Subagent system prompt
│   │   └── verify-context.ts          # Subagent context template
│   └── utils/
│       ├── session-http.ts            # V1 client wrapper for Session.metadata
│       └── format.ts                  # Formatting helpers
├── dist/
│   └── index.js                       # Built single-file bundle (~56 KB)
├── package.json
├── tsconfig.json
├── README.md                          # Chinese
├── README.en.md                       # English
├── DESIGN.md                          # This file
└── AGENTS.md
```

## 13. Build & install

```bash
# Build single-file bundle
bun run build

# Install as a single file at the opencode plugins directory
cp dist/index.js ~/.config/opencode/plugins/opencode-mission.js

# Register in opencode.json
{
  "plugin": ["./plugins/opencode-mission.js"]
}
```

The plugin ships as a single JS file (~56 KB) with no external runtime dependencies in the same directory — `bun build` inlines internal modules and keeps `@opencode-ai/plugin`, `@opencode-ai/sdk`, `zod`, and `effect` as external imports resolved by the opencode runtime.

## 14. Known limitations

- **Continuation + interrupt tracking depend on `EventSessionIdle`**: works in interactive TUI; `opencode run` (headless) does not emit this event so the mechanism is structurally correct but unvalidated in headless tests.
- **Verify JSON parsing** depends on the subagent emitting a strict `\`\`\`json { verdict, scores } \`\`\`` block. A future version could have the subagent emit via a structured tool.
- **Wallclock precision** relies on `Date.now()`; subject to system clock adjustments.
- **Single mission per session**: the metadata schema allows extension to a `missionsPro: Mission[]` array for parallel missions; not implemented in v1.
- **Storage SDK mismatch**: V1 SDK 1.4.8 type definition for `SessionUpdateData.body` does not declare `metadata`; the opencode 1.16.x server accepts it. We rely on V1 client wrapper accepting the extra field.

## 15. Future work (v2+)

- Multi-mission parallel execution (extend metadata schema to `missionsPro: Mission[]`).
- Budget pool (multiple missions sharing a token budget).
- Verify report visualization (custom TUI panel).
- Status change notifications via `EventTuiToastShow`.
- `/mission history` command.
- Structured emit (tool instead of free text) for verify report to remove JSON-parsing fragility.