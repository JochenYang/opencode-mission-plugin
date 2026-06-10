# AGENTS.md · Project notes for future maintainers

> Written by Aya for the user and any agent that picks up this project.

## One-line summary

opencode-mission is an OpenCode plugin that gives the main session an "autonomous mission-driven agent mode": the user sets a mission, the agent works across multiple turns until the mission is achieved, paused, or blocked.

## Core architecture

```
opencode-mission/
├── src/
│   ├── index.ts                  # Entry point: hook wiring
│   ├── types.ts                  # Type definitions (Mission, Budget, Status, Actor, VerificationReport)
│   ├── mission-store.ts          # State machine + budget accumulation + persistence (the only mutation entry point)
│   ├── command-template.ts       # /mission command template + ABSOLUTE RULE + bash protocol
│   ├── prompts.ts                # Continuation prompt + 4-dim self-audit
│   ├── prompts-injection.ts      # 3-level system prompt injection + self-audit
│   ├── tools/
│   │   ├── create-mission.ts     # CreateMission tool
│   │   ├── update-mission.ts     # UpdateMission tool
│   │   ├── get-mission.ts        # GetMission tool
│   │   └── set-mission-budget.ts # SetMissionBudget tool
│   ├── hooks/
│   │   ├── event-hook.ts         # Continuation + interrupt tracking + token accumulation
│   │   ├── chat-message.ts       # Verify subagent context injection + JSON report parsing
│   │   ├── system-transform.ts   # Main session system prompt 3-level injection
│   │   └── command-execute.ts    # /mission command synthetic-ization
│   ├── verify/
│   │   ├── verify-prompt.ts      # Verify subagent system prompt
│   │   └── verify-context.ts     # Subagent context injection template
│   └── utils/
│       ├── session-http.ts       # V1 HeyApi client wrapper for Session.metadata
│       └── format.ts             # Formatting helpers (duration, number, status output)
├── dist/
│   └── index.js                  # Built single-file bundle (~56 KB)
├── package.json
├── tsconfig.json
├── README.md                     # Chinese
├── README.en.md                  # English
├── DESIGN.md                     # Full design document
└── AGENTS.md                     # This file
```

## Design highlights

### 1. State machine

`active / paused / blocked / complete` (4 states):

- `active` — agent works autonomously
- `paused` — user-initiated stop, **wallclock is frozen**
- `blocked` — system-level stop (budget exhausted / runtime error), **wallclock keeps accumulating**
- `complete` — successful, triggered by the verify subagent

Transition rules (see `mission-store.ts:assertTransition`):

- `active` -> `paused` / `blocked`
- `paused` / `blocked` -> `active`
- any -> `cancelled` (clears the record)

### 2. Persistence

The plugin uses the **V1 HeyApi client** injected by the plugin runtime (`(input.client as any)._client`) to read/write `Session.metadata.missionPro`:

- `v1Client.get({ url: ".../session/{id}" })` — read
- `v1Client.patch({ url: ".../session/{id}", body: { metadata } })` — write

Why V1 client:

- The V1 wrapper bundles baseUrl, auth headers, and response parsing, which avoids bare-fetch issues.
- The V1 SDK type `SessionUpdateData.body` does not declare `metadata` (the opencode 1.16.x server does accept it). The V1 client accepts the extra field and passes it through.
- Reusing the runtime-injected client keeps cookies and auth consistent with other opencode tools.

Storage key: `Session.metadata.missionPro` (namespaced to coexist with other mission plugins).

### 3. SetMissionBudget: single-dimension-per-call

`SetMissionBudget` accepts `{ value: number, unit: 'turns'|'tokens'|'milliseconds'|'seconds'|'minutes'|'hours' }` — one dimension per call. The unit is a closed enum so the LLM cannot send ambiguous wallclock amounts. To set three dimensions, the agent calls the tool three times.

### 4. Continuation mechanism

Primary trigger: `EventSessionIdle` (dedicated event in opencode 1.4.8+).

Auxiliary: `EventMessageUpdated` (assistant role) for token accumulation. `AssistantMessage.tokens` carries `total / input / output / reasoning / cache.{read, write}`; we track last seen `total` per session and accumulate the delta.

Interrupt tracking:

- `EventSessionError` with `error.name === "MessageAbortedError"` -> `userAborted` set
- `EventSessionError` with any other error name -> `runtimeErrored` set
- On `session.idle`, the sets are consumed: user Esc -> `paused`, runtime error -> `blocked`

Re-entry guard: `continuationInFlight: Set<sessionID>`.

### 5. Tool design

Four standalone tools. Each tool has a single, clear intent and an independent error path.

Main/subagent isolation:

- `ToolContext.agent` distinguishes the main session (`"build"`) from subagents.
- `UpdateMission` rejects subagent calls (except the `mission-verify` subagent).
- `GetMission` in a subagent automatically reads the **parent session's** mission.

There is no dynamic tool visibility (not supported by the public plugin API). Each tool internally returns a friendly error when called with no active mission.

### 6. Self-audit (4-dimension pre-declare checklist)

Both the continuation prompt (`src/prompts.ts`) and the active system injection (`src/prompts-injection.ts`) force a 4-dimension self-audit before the agent considers the work complete:

1. Completeness — every completion-criterion item has current evidence
2. Correctness — the work actually runs; read the files you wrote, do not assume
3. Integration — the new pieces fit the existing codebase
4. Robustness — edge cases handled

A plan, summary, or first pass is NOT a complete result. This is borrowed from mature goal-driver design — without explicit self-audit, agents tend to declare completion after partial work.

### 7. Verify mechanism

The `mission-verify` subagent is registered via the `config` hook with a dedicated system prompt. It owns `GetMission` / `UpdateMission` tool access but no write tools (read-only auditor).

Pass condition: `verdict === "passed"` iff all 4 dimensions >= 3 AND completeness >= 3.

Auto-complete: `experimental.text.complete` intercepts the subagent's final text, extracts the JSON block via `tryParseVerifyJson`, and if `verdict === "passed"` calls `store.markComplete(parentSessionID, report)`.

### 8. The ABSOLUTE RULE (command template)

`src/command-template.ts` opens with an ABSOLUTE RULE instructing the LLM to make `CreateMission` its **first** tool call — no `GetMission` to "check if there's an existing mission", no `bash` to explore, no `todowrite` to plan. This bypasses the LLM's strong default of "look before you leap", which otherwise skips past the mission tool entirely and completes the task in normal mode.

Without the ABSOLUTE RULE, agents in headless `opencode run` testing have been observed to:

1. First tool call: `GetMission` (returns "No active mission")
2. Then `todowrite` to plan
3. Then `write` / `bash` to do the work directly
4. Never call `CreateMission` — the plugin stays inert
5. `GetMission` after the fact still returns "No active mission" — no verification, no auto-complete, no self-audit injection

### 9. Bash protocol (command template)

The template also includes a bash protocol warning the LLM about two failure modes that block turns in this environment:

1. **Permission dialogs**: opencode matches bash patterns against the `permission` config; chained commands with `;` are treated as a single unit, so any `ask`-pattern sub-command blocks the whole turn.
2. **Detached processes**: `Start-Process` without `-NoNewWindow -PassThru` leaves the parent shell waiting on an interactive `Id:` prompt.

Rules: one `bash` call per command; start dev servers in the background with explicit output redirection; probe endpoints with `Invoke-RestMethod`; clean up via `Get-Process | Where-Object | Stop-Process` before turn end.

### 10. Naming conventions

- Files: kebab-case (`create-mission.ts`)
- Classes/types: PascalCase (`MissionStore`, `VerificationReport`)
- Functions/variables: camelCase
- Private helpers: underscore prefix (`_drop`)
- Type fields: camelCase (`continuationCount`)

## Important constraints

1. **DO NOT** modify `mission-store.ts:assertTransition` without updating `DESIGN.md §2` (state transition table).
2. **DO NOT** change the persistence approach in `utils/session-http.ts` (V1 HeyApi client wrapper). This is the only way we have access to the runtime's auth context.
3. **DO NOT** rename the `Session.metadata.missionPro` storage key — it coexists with other mission plugins.
4. **DO NOT** introduce `as any` in tool code; use `ctx.agent` to distinguish main vs sub.
5. **DO NOT** leak `terminalReason` into the continuation prompt (it goes in the system injection, the continuation prompt stays clean).
6. **DO NOT** remove the ABSOLUTE RULE from `command-template.ts` — without it, agents skip `CreateMission` and the entire plugin stays inert.
7. **DO NOT** relax the bash protocol — chained `;` commands and detached `Start-Process` are the two main causes of stuck turns.

## Verification checklist

A task is "done" only when all of the following pass:

- [ ] `bun x tsc --noEmit` reports no errors
- [ ] `bun run build` produces `dist/index.js` (~56 KB)
- [ ] In an interactive TUI session: `/mission <objective>` causes the agent's **first** tool call to be `CreateMission`
- [ ] The mission-verify subagent gets spawned after the main work is done
- [ ] Auto-complete fires: `GetMission` returns "No active mission" after the JSON report parses with `verdict === "passed"`
- [ ] `/mission status` shows budget usage and continuation count
- [ ] `/mission budget set turns=2` followed by enough work causes the mission to transition to `blocked`
- [ ] User Esc during autonomous work -> mission transitions to `paused`; `/mission resume` re-activates and wallclock resumes from where it was frozen
- [ ] A non-`mission-verify` subagent calling `UpdateMission` receives the "not authorized" error
- [ ] Session metadata persists across opencode server restarts

## Known limitations

1. **Verify JSON parsing is fragile** — depends on the subagent emitting a strict `\`\`\`json { verdict, scores } \`\`\`` block. A future version could have the subagent emit via a structured tool.
2. **Wallclock precision** — uses `Date.now()`, subject to system clock adjustments.
3. **Token accumulation** — depends on `EventMessageUpdated` carrying `AssistantMessage.tokens`. If opencode changes this field shape, accumulation may break.
4. **Continuation in headless mode** — the `event` hook has not been observed receiving `session.idle` events during `opencode run` (headless) testing. The mechanism is structurally correct but should be validated in interactive TUI mode where the user can press Esc and observe pause behavior.
5. **V1 SDK type lag** — SDK 1.4.8 does not declare `metadata` in `SessionUpdateData.body`. The opencode 1.16.x server accepts it; we rely on V1 client wrapper accepting the extra field. Future SDK or server changes could break this.

## Future work (v2+)

- Multi-mission parallel execution (extend metadata schema to `missionsPro: Mission[]`).
- Budget pool (multiple missions sharing a token budget).
- Verify report visualization (custom TUI panel).
- Status change notifications via `EventTuiToastShow`.
- `/mission history` command.
- Structured emit (tool instead of free text) for verify report to remove JSON-parsing fragility.