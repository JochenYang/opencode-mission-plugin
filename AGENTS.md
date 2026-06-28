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
│       ├── session-http.ts       # File-based mission storage + raw fetch for sub-agent routing
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

### 0. Storage backends (pluggable)

Mission persistence is handled by the `MissionStorage` interface (`src/mission-storage.ts`). The plugin ships two implementations:

- `FileMissionStorage` (default, mode=`file`): JSON files at `~/.config/opencode/missions/<workspace-slug>/<sessionID>.json` with atomic temp-file renames. Self-contained; works with any opencode version. This is the behavior the plugin has had since v0.2.0 and the on-disk layout is a public contract.
- `MetadataMissionStorage` (opt-in, mode=`metadata`): PATCHes the opencode session's metadata JSON column (`Session.metadata.mission`) via the canonical `PATCH /session/:sessionID` endpoint. Pros: free session-fork inheritance (the forked session gets the parent's metadata copied automatically by the server), centralized backup with the rest of the user's opencode data, no extra filesystem footprint. Cons: requires an opencode server build that exposes the `PATCH /session/:id` endpoint; on builds that don't, the PATCH call returns non-2xx and the storage layer throws (we do NOT silently fall back to file — see constraint #8).

Selection happens at plugin boot from `OPENCODE_MISSION_STORAGE` (default `file`). The factory in `mission-storage.ts` is the only entry point. `SessionHttp` keeps the legacy `readMission` / `writeMission` methods as thin shims that delegate to the provided storage, so existing call sites in `MissionStore`, hooks, and tools did not need to change in this refactor — but new code should depend on `MissionStorage` directly.

To add a third backend: implement the `MissionStorage` interface (three methods: `read`, `write`, optional `healthCheck`), export a new factory in `mission-storage.ts`, and add a value to the `StorageMode` union. Tests in `tests/mission-storage.test.ts` show the contract.

### 1. State machine

`active / paused / blocked / budget_limited / complete` (5 states):

- `active` — agent works autonomously
- `paused` — user-initiated stop, **wallclock is frozen**
- `blocked` — agent-declared, requires 3 consecutive same-reason attempts (see #2)
- `budget_limited` — system-level stop (budget exhausted) or judge cap reached, **wallclock keeps accumulating**
- `complete` — successful, triggered by the verify subagent

Transition rules (see `mission-store.ts:assertTransition`):

- `active` -> `paused` / `blocked` / `budget_limited`
- `paused` / `blocked` / `budget_limited` -> `active`
- any -> `cancelled` (clears the record)

### 2. 3-turn blocked threshold and judge react cap

Agent-declared blocked (via `UpdateMission status="blocked"` with `actor="model"`) requires 3 consecutive same-reason attempts before the state actually transitions. Below the threshold, the attempt is recorded (`consecutiveBlockAttempts` + `lastBlockReason`) and the mission stays active. Counter resets on resume.

Symmetric guard for the judge: when `recordJudgeReactAttempt` is called and the count reaches `MAX_JUDGE_REACT = 5` consecutive failed verdicts, the mission is auto-transitioned to `budget_limited` (with a terminal reason explaining the cap). This prevents infinite verify loops when the judge keeps rejecting without the agent making progress.

Runtime errors (`actor="runtime"`) still block immediately — no threshold.

### 3. Persistence

The plugin owns mission state as JSON files under the user's config dir, decoupling from opencode server metadata APIs:

```
~/.config/opencode/missions/<workspace-slug>/<sessionID>.json
```

- Path built with `os.homedir() + path.join()` (cross-platform: Windows, macOS, Linux).
- Workspace slug is sanitized from `PluginInput.directory` (URL-decoded, path separators replaced with `-`).
- Atomic writes: write to `<file>.tmp`, then `rename` to `<file>` (POSIX atomic, Windows close-to-atomic).
- Sub-agent routing uses raw `fetch` to `/api/session/{id}` (the 1.17.x canonical path) to find the parent session ID; falls back to a "no parent" sentinel if unreachable.

The V2 SDK's `session.get()` method has a path-template substitution bug in 1.17.1 (sends literal `{id}` to the server, gets 500), so we use raw `fetch` instead.

### 4. HTML response guard

Whenever the plugin makes a raw fetch to the opencode server, the response body is checked: if it starts with `<!doctype` or `<html`, treat as a failed call. This is the SPA-fallback signal — the server is returning its web UI for an unknown route. Without the guard, the plugin would silently trust empty SPA pages as legitimate API responses.

### 5. Fail-open on judge parse failure

If the verify subagent's output cannot be parsed as a JSON report, attach a synthetic `VerificationReport { verdict: "failed", judgeFailed: true }` and mark complete anyway. Without this, a persistent parse failure traps the user in mission mode forever.

### 6. SetMissionBudget: single-dimension-per-call

`SetMissionBudget` accepts `{ value: number, unit: 'turns'|'tokens'|'milliseconds'|'seconds'|'minutes'|'hours' }` — one dimension per call. The unit is a closed enum so the LLM cannot send ambiguous wallclock amounts. To set three dimensions, the agent calls the tool three times.

### 7. Continuation mechanism

Primary trigger: `EventSessionIdle` (dedicated event in opencode 1.4.8+).

Auxiliary: `EventMessageUpdated` (assistant role) for token accumulation. `AssistantMessage.tokens` carries `total / input / output / reasoning / cache.{read, write}`; we track last seen `total` per session and accumulate the delta.

Interrupt tracking:

- `EventSessionError` with `error.name === "MessageAbortedError"` -> `userAborted` set
- `EventSessionError` with any other error name -> `runtimeErrored` set
- On `session.idle`, the sets are consumed: user Esc -> `paused`, runtime error -> `blocked`

Re-entry guard: `continuationInFlight: Set<sessionID>`.

### 8. Tool design

Four standalone tools. Each tool has a single, clear intent and an independent error path.

Main/subagent isolation:

- `ToolContext.agent` distinguishes the main session (`"build"`) from subagents.
- `UpdateMission` rejects subagent calls (except the `mission-verify` subagent).
- `GetMission` in a subagent automatically reads the **parent session's** mission.

There is no dynamic tool visibility (not supported by the public plugin API). Each tool internally returns a friendly error when called with no active mission.

### 9. Self-audit (4-dimension pre-declare checklist)

Both the continuation prompt (`src/prompts.ts`) and the active system injection (`src/prompts-injection.ts`) force a 4-dimension self-audit before the agent considers the work complete:

1. Completeness — every completion-criterion item has current evidence
2. Correctness — the work actually runs; read the files you wrote, do not assume
3. Integration — the new pieces fit the existing codebase
4. Robustness — edge cases handled

A plan, summary, or first pass is NOT a complete result. This is borrowed from mature goal-driver design — without explicit self-audit, agents tend to declare completion after partial work.

The active system injection also includes:

- A `<mission_status>` block with structured fields (Status, Objective, Time used, Tokens used, Budget guidance, Commands)
- A dynamic `Commands:` list scoped to the current status
- A 3-turn block-threshold reminder when prior attempts have been recorded
- A wrap-up directive when budget is over (instead of starting new work, summarize + identify remaining work + leave a clear next step)

### 10. Verify mechanism

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
2. **DO NOT** bypass the `MissionStorage` abstraction. Persistence is now pluggable: the default `FileMissionStorage` writes JSON to `~/.config/opencode/missions/<workspace>/<sessionID>.json` (the public on-disk contract), and `MetadataMissionStorage` (opt-in via `OPENCODE_MISSION_STORAGE=metadata`) persists inside the opencode session's metadata column. `SessionHttp` only handles session-info lookup (parentID, metadata read), not mission persistence. Adding a new storage backend means implementing the `MissionStorage` interface in `src/mission-storage.ts`.
3. **DO NOT** change the file-based storage directory layout without a migration plan — the file path `<workspace-slug>/<sessionID>.json` is part of the public contract (it lives on the user's filesystem) and the default `FileMissionStorage` is what most users will keep using.
4. **DO NOT** introduce `as any` in tool code; use `ctx.agent` to distinguish main vs sub.
5. **DO NOT** leak `terminalReason` into the continuation prompt (it goes in the system injection, the continuation prompt stays clean).
6. **DO NOT** remove the ABSOLUTE RULE from `command-template.ts` — without it, agents skip `CreateMission` and the entire plugin stays inert.
7. **DO NOT** relax the bash protocol — chained `;` commands and detached `Start-Process` are the two main causes of stuck turns.
8. **DO NOT** silently fall back from `MetadataMissionStorage` to file storage. A PATCH failure should surface as a hard error so operators notice the misconfiguration; if you want a soft fallback you have to do it explicitly in the storage backend (and document it).

## Verification checklist

A task is "done" only when all of the following pass:

- [ ] `bun x tsc --noEmit` reports no errors
- [ ] `bun run build` produces `dist/index.js` (~56 KB)
- [ ] In an interactive TUI session: `/mission <objective>` causes the agent's **first** tool call to be `CreateMission`
- [ ] The mission-verify subagent gets spawned after the main work is done
- [ ] Auto-complete fires: `GetMission` returns "No active mission" after the JSON report parses with `verdict === "passed"`
- [ ] `/mission status` shows budget usage and continuation count
- [ ] `/mission budget set turns=2` followed by enough work causes the mission to transition to `budget_limited` (not `blocked`)
- [ ] User Esc during autonomous work -> mission transitions to `paused`; `/mission resume` re-activates and wallclock resumes from where it was frozen
- [ ] A non-`mission-verify` subagent calling `UpdateMission` receives the "not authorized" error
- [ ] Mission state persists across opencode server restarts (file-based storage at `~/.config/opencode/missions/<workspace>/<sessionID>.json`)

## Known limitations

1. **Verify JSON parsing is fragile** — depends on the subagent emitting a strict `\`\`\`json { verdict, scores } \`\`\`` block. Fail-open (see #5 below) catches parse failures; a future version could replace the free-text parser with a structured tool emit.
2. **Wallclock precision** — uses `Date.now()`, subject to system clock adjustments.
3. **Token accumulation** — depends on `EventMessageUpdated` carrying `AssistantMessage.tokens`. If opencode changes this field shape, accumulation may break.
4. **Continuation in headless mode** — the `event` hook has not been observed receiving `session.idle` events during `opencode run` (headless) testing. The mechanism is structurally correct but should be validated in interactive TUI mode where the user can press Esc and observe pause behavior.
5. **Sub-agent routing on opencode 1.17.x** — `getSession` uses raw `fetch` to `/api/session/{id}` (the canonical 1.17.x path; V2 SDK has a `{sessionID}` template-substitution bug). On 1.17.x the plugin process may be sandboxed away from the server, in which case `getSession` returns null and the main flow continues safely (sub-agent routing falls back to a "no parent" sentinel).
6. **Single mission per session** — the JSON file schema allows extension to a `missionsPro: Mission[]` array for parallel missions; not implemented in v1.

## Future work (v2+)

- Multi-mission parallel execution (extend the JSON file schema to a `missions: Mission[]` array per session).
- Budget pool (multiple missions sharing a token budget).
- Verify report visualization (custom TUI panel).
- Status change notifications via `EventTuiToastShow`.
- `/mission history` command.
- Side-channel parentID propagation for mission-verify (so it works even when `getSession` cannot reach the opencode server).
- Structured emit (tool instead of free text) for verify report to remove JSON-parsing fragility.