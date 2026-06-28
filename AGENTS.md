# AGENTS.md · Project notes for future maintainers

> Notes for anyone (human or agent) picking up this project.

## One-line summary

opencode-mission is an OpenCode plugin that gives the main session an "autonomous mission-driven agent mode": the user sets a mission, the agent works across multiple turns until the mission is achieved, paused, or blocked.

## Core architecture

```
opencode-mission/
├── src/
│   ├── index.ts                  # Entry point: hook wiring
│   ├── types.ts                  # Type definitions (Mission, Budget, Status, Actor, VerificationReport)
│   ├── mission-store.ts          # State machine + budget accumulation + persistence (the only mutation entry point)
│   ├── mission-storage.ts        # MissionStorage interface + MetadataMissionStorage (PATCH /session/:id)
│   ├── command-template.ts       # /mission command template + ABSOLUTE RULE
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
│       ├── session-http.ts       # Session info lookup (parentID) for sub-agent routing
│       └── format.ts             # Formatting helpers (duration, number, status output)
├── dist/
│   └── index.js                  # Built single-file bundle (~79 KB as of 0.3.8)
├── package.json
├── tsconfig.json
├── README.md                     # Chinese
├── README.en.md                  # English
├── DESIGN.md                     # Full design document
└── AGENTS.md                     # This file
```

## Design highlights

### 0. Storage

Mission persistence is handled by the `MissionStorage` interface (`src/mission-storage.ts`). The primary implementation is `FileMissionStorage`: it stores missions in a local JSON file at `<workspace>/.opencode/missions.json` (or `~/.config/opencode/missions.json` globally), with atomic tmp+rename writes.

Why file-based:
- **PATCH /session/{id} returns 500** on opencode 1.17.11 (unhandled `UnknownError` defect in the session event chain). Other working goal plugins also use local file storage for this reason.
- **No server-side transport bugs**: no V1 `v[0]` envelope unwrap issue, no V2 SDK empty-body bug.
- **Atomic writes**: temp file + rename provides crash-safe persistence.
- **Works on any opencode version** — no PATCH endpoint dependency.

Trade-offs vs metadata storage:
- **Fork inheritance lost**: file stays in the original workspace; forked sessions don't inherit the mission automatically.
- **No centralized backup**: mission state lives in its own file, not in the opencode SQLite session DB.

The factory in `mission-storage.ts` is the only entry point. `SessionHttp` handles session-info lookup (parentID, metadata read), not mission persistence.

To add a different backend: implement the `MissionStorage` interface (three methods: `read`, `write`, optional `healthCheck`), export a new factory in `mission-storage.ts`. Tests in `tests/mission-storage.test.ts` show the contract.

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

Mission state lives inside the opencode session's metadata column at `Session.metadata.mission`. The plugin does not own any on-disk layout — the opencode server does (SQLite).

- Set via `PATCH /session/:sessionID` with body `{ metadata: { ...currentMetadata, mission } }` (merge preserves sibling keys written by other plugins).
- Read via `GET /session/:sessionID` then `data.metadata.mission`.
- Sub-agent routing uses raw `fetch` to `/api/session/{id}` (the 1.17.x canonical path; the V2 SDK's `client.session.get()` has a `{sessionID}` template-substitution bug). Returns `null` if the plugin process is sandboxed away from the server; the main flow continues safely.
- v0.2.x owned mission state in JSON files at `~/.config/opencode/missions/<workspace-slug>/<sessionID>.json`. Removed in 0.3.0 once the metadata PATCH endpoint shipped in opencode 1.17.11 — file mode had no fork inheritance, no centralized backup, and a duplicate on-disk layout to maintain.

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

### 11. The ABSOLUTE RULE (command template)

`src/command-template.ts` opens with an ABSOLUTE RULE instructing the LLM to make `CreateMission` its **first** tool call — no `GetMission` to "check if there's an existing mission", no `bash` to explore, no `todowrite` to plan. This bypasses the LLM's strong default of "look before you leap", which otherwise skips past the mission tool entirely and completes the task in normal mode.

Without the ABSOLUTE RULE, agents in headless `opencode run` testing have been observed to:

1. First tool call: `GetMission` (returns "No active mission")
2. Then `todowrite` to plan
3. Then `write` / `bash` to do the work directly
4. Never call `CreateMission` — the plugin stays inert
5. `GetMission` after the fact still returns "No active mission" — no verification, no auto-complete, no self-audit injection

### 12. Bash protocol (command template)

The template also includes a bash protocol warning the LLM about two failure modes that block turns in this environment:

1. **Permission dialogs**: opencode matches bash patterns against the `permission` config; chained commands with `;` are treated as a single unit, so any `ask`-pattern sub-command blocks the whole turn.
2. **Detached processes**: `Start-Process` without `-NoNewWindow -PassThru` leaves the parent shell waiting on an interactive `Id:` prompt.

Rules: one `bash` call per command; start dev servers in the background with explicit output redirection; probe endpoints with `Invoke-RestMethod`; clean up via `Get-Process | Where-Object | Stop-Process` before turn end.

### 13. Naming conventions

- Files: kebab-case (`create-mission.ts`)
- Classes/types: PascalCase (`MissionStore`, `VerificationReport`)
- Functions/variables: camelCase
- Private helpers: underscore prefix (`_drop`)
- Type fields: camelCase (`continuationCount`)

## Important constraints

1. **DO NOT** modify `mission-store.ts:assertTransition` without updating `DESIGN.md §2` (state transition table).
2. **DO NOT** bypass the `MissionStorage` abstraction. Mission state lives in a local JSON file managed by `FileMissionStorage`. `SessionHttp` only handles session-info lookup (parentID, metadata read), not mission persistence. Adding a new storage backend means implementing the `MissionStorage` interface in `src/mission-storage.ts`.
3. **DO NOT** reintroduce session-metadata-based storage as the default. Metadata persistence (PATCH /session/{id}) returns 500 on opencode 1.17.11 (defect in the server's event chain). If the opencode server eventually fixes this, `MetadataMissionStorage` is still available in `src/mission-storage.ts` as a legacy option, but `FileMissionStorage` is the default.
4. **DO NOT** introduce `as any` in tool code; use `ctx.agent` to distinguish main vs sub.
5. **DO NOT** leak `terminalReason` into the continuation prompt (it goes in the system injection, the continuation prompt stays clean).
6. **DO NOT** remove the ABSOLUTE RULE from `command-template.ts` — without it, agents skip `CreateMission` and the entire plugin stays inert.
7. **DO NOT** relax the bash protocol — chained `;` commands and detached `Start-Process` are the two main causes of stuck turns.
8. **DO NOT** silently swallow metadata-storage errors. A `PATCH` failure should surface as a hard error so operators notice the misconfiguration; if you want a soft fallback you have to do it explicitly in the storage backend (and document it).

## Verification checklist

A task is "done" only when all of the following pass:

- [ ] `bun x tsc --noEmit` reports no errors
- [ ] `bun run build` produces `dist/index.js` (~79 KB as of 0.3.8)
- [ ] In an interactive TUI session: `/mission <objective>` causes the agent's **first** tool call to be `CreateMission`
- [ ] The mission-verify subagent gets spawned after the main work is done
- [ ] Auto-complete fires: `GetMission` returns "No active mission" after the JSON report parses with `verdict === "passed"`
- [ ] `/mission status` shows budget usage and continuation count
- [ ] `/mission budget set turns=2` followed by enough work causes the mission to transition to `budget_limited` (not `blocked`)
- [ ] User Esc during autonomous work -> mission transitions to `paused`; `/mission resume` re-activates and wallclock resumes from where it was frozen
- [ ] A non-`mission-verify` subagent calling `UpdateMission` receives the "not authorized" error
- [ ] Mission state persists across opencode server restarts (stored in local JSON file)

## Known limitations

1. **Verify JSON parsing is fragile** — depends on the subagent emitting a strict `\`\`\`json { verdict, scores } \`\`\`` block. Fail-open (see #5 below) catches parse failures; a future version could replace the free-text parser with a structured tool emit.
2. **Wallclock precision** — uses `Date.now()`, subject to system clock adjustments.
3. **Token accumulation** — depends on `EventMessageUpdated` carrying `AssistantMessage.tokens`. If opencode changes this field shape, accumulation may break.
4. **Continuation in headless mode** — the `event` hook has not been observed receiving `session.idle` events during `opencode run` (headless) testing. The mechanism is structurally correct but should be validated in interactive TUI mode where the user can press Esc and observe pause behavior.
5. **Sub-agent routing on opencode 1.17.x** — `getSession` uses raw `fetch` to `/api/session/{id}` (the canonical 1.17.x path; V2 SDK has a `{sessionID}` template-substitution bug). On 1.17.x the plugin process may be sandboxed away from the server, in which case `getSession` returns null and the main flow continues safely (sub-agent routing falls back to a "no parent" sentinel).
6. **Single mission per session** — the metadata column holds one `mission` key; a future `missions[]` array would let multiple missions share a session.

## Future work (v2+)

- Multi-mission parallel execution (extend the metadata schema to a `missions: Mission[]` array per session).
- Budget pool (multiple missions sharing a token budget).
- Verify report visualization (custom TUI panel).
- Status change notifications via `EventTuiToastShow`.
- `/mission history` command.
- Side-channel parentID propagation for mission-verify (so it works even when `getSession` cannot reach the opencode server).
- Structured emit (tool instead of free text) for verify report to remove JSON-parsing fragility.