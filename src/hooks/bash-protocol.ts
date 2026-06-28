// ─────────────────────────────────────────────────────────────────────────────
//  Bash background protocol
//
// Detects long-running dev-server commands (npm run dev / vite / next dev /
// flask run / uvicorn / python -m http.server, including `cd <dir> && <cmd>`
// pipelines) and rewrites them into background-launched form so the bash
// tool returns immediately instead of blocking the LLM turn.
//
// Public API:
// - matchesStrictDevPattern(segment) — single-segment pattern check
// - looksLikeDevServer(cmd)          — pipeline-aware detection (split on && / ;)
// - wrapInBackground(cmd, opts)      — emit a platform-specific launcher
// - registerBashProtocolHooks(opts)  — returns the 3-hook bundle
// ─────────────────────────────────────────────────────────────────────────────

import { mkdirSync } from "node:fs"
import { join, posix, win32 } from "node:path"
import { log } from "../utils/log.js"

const TOOL_ID = "bash"
const MAX_TRACKED = 256

// Appended to the bash tool's description so the LLM knows dev servers
// will be background-launched automatically. We APPEND (not replace) so
// the opencode-supplied description is preserved.
const PROTOCOL_BLOCK = `

<bash_background_protocol>
Long-running dev server commands (npm run dev / vite / next dev / flask run / uvicorn / python -m http.server, including \`cd <dir> && <cmd>\` pipelines) are automatically rewritten to background-launch form by the opencode-mission plugin. The bash tool will return quickly with a \`background started: pid=...\` line; the server logs to <workspace>/.opencode/server-logs/<slug>.log. To probe a running server, call bash with \`curl http://localhost:<port>/<path>\` or \`Invoke-RestMethod\` (Windows) in a separate bash call. To stop a background server, use \`Get-Process -Id <pid> | Stop-Process\` (Windows) or \`kill <pid>\` (Unix), or close the opencode session and the plugin will sweep leftover processes on session.idle.
</bash_background_protocol>`

// ── Detection ─────────────────────────────────────────────────────────────

/**
 * Optional prefix accepted by most dev-server patterns: `npx <bin>`,
 * `bunx <bin>`, `pnpm exec <bin>`, `npm exec <bin>`. Anchored at the start
 * of the segment, so the LLM's `npx vite` / `bunx vite` / `pnpm exec vite`
 * invocations are detected the same way as plain `vite`.
 *
 * `String.raw` keeps `\s` as the 2-char sequence `\s` so the interpolated
 * string passed to `RegExp` is a valid regex source.
 */
const PREFIX = String.raw`(?:npx\s+|bunx\s+|pnpm\s+exec\s+|npm\s+exec\s+)?`

/**
 * Strict dev-server patterns. Each pattern is anchored at the start of the
 * segment; the segment must equal the pattern or have whitespace / end-of-
 * string after the last matched token. Conservative: false negatives are
 * recoverable (the LLM can append `&` explicitly), false positives are
 * catastrophic (we detach a command the LLM wanted to run synchronously).
 */
const DEV_PATTERNS: ReadonlyArray<RegExp> = [
  new RegExp(`^${PREFIX}npm(?:\\s+run)?\\s+dev\\b`),                                  // npm run dev, npx npm run dev
  new RegExp(`^${PREFIX}npm(?:\\s+run)?\\s+start\\b`),                                // npm start, npx npm start
  new RegExp(`^${PREFIX}pnpm(?:\\s+run(?:-script)?)?\\s+(?:dev|start)\\b`),           // pnpm dev / pnpm run dev / pnpm run-script dev
  new RegExp(`^${PREFIX}yarn(?:\\s+run)?\\s+(?:dev|start)\\b`),                       // yarn dev / yarn run dev
  /^bun(?:\s+run)?\s+dev\b/,                                                          // bun run dev / bun dev (no npx wrapper for bun runtime)
  new RegExp(`^${PREFIX}bun(?:\\s+run)?\\s+dev\\b`),                                  // npx bun run dev (rare but possible)
  new RegExp(`^${PREFIX}vite(?:\\s+dev)?$`),                                          // vite / vite dev / npx vite
  new RegExp(`^${PREFIX}next\\s+(?:dev|start)\\b`),                                   // next dev / npx next dev
  new RegExp(`^${PREFIX}nuxt\\s+dev\\b`),                                             // nuxt dev
  new RegExp(`^${PREFIX}flask\\s+run\\b`),                                            // flask run
  new RegExp(`^${PREFIX}uvicorn(?:\\s|$)`),                                           // uvicorn <anything> / npx uvicorn
  new RegExp(`^${PREFIX}python\\s+-m\\s+http\\.server\\b`),                           // python -m http.server
  new RegExp(`^${PREFIX}python\\s+-m\\s+flask\\s+run\\b`),                            // python -m flask run
]

/**
 * Match a single command segment against the strict dev-server patterns.
 * Returns true only for an exact, unambiguous dev-server invocation.
 */
export function matchesStrictDevPattern(segment: string): boolean {
  const s = segment.trim()
  if (!s) return false
  for (const re of DEV_PATTERNS) {
    if (re.test(s)) return true
  }
  return false
}

/**
 * Detect long-running dev-server commands, including `cd <dir> && <cmd>` and
 * `cd <dir> ; <cmd>` pipelines. Returns true only if the LAST segment of
 * the pipeline matches a strict dev pattern AND the command is not already
 * backgrounded / redirected / piped.
 */
export function looksLikeDevServer(cmd: string): boolean {
  const trimmed = cmd.trim()
  if (!trimmed) return false
  if (trimmed.startsWith("#")) return false

  // Split on `&&` or `;` (any whitespace around them is fine). The LLM
  // typically writes `cd <dir> && <dev-cmd>` so the last segment is the
  // dev command; intermediate segments are usually just `cd` lines.
  const segments = trimmed
    .split(/&&|;/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (segments.length === 0) return false

  // Per-segment skip conditions. After splitting on `&&`, any remaining
  // single `&` is background syntax; we don't try to disambiguate shell-
  // meaningful `&` from arg-text. Being conservative is safer.
  for (const seg of segments) {
    if (seg.includes("&")) return false // already backgrounded
    if (/\bnohup\b/.test(seg)) return false // nohup already detaches
    if (/>\s|>>/.test(seg)) return false // already redirected
    if (/\|\s*tee\b/i.test(seg)) return false // LLM is reading output
    if (/\|\s*tail\b/i.test(seg)) return false // LLM is tailing output
  }

  // Only the LAST segment runs the dev server.
  const last = segments[segments.length - 1]
  return matchesStrictDevPattern(last)
}

// ── Slug ──────────────────────────────────────────────────────────────────

/**
 * Stable, filesystem-safe slug for a command. The base is the command
 * lowercased and non-alphanum-replaced; a 4-char base36 hash of the
 * ORIGINAL command (so the suffix disambiguates similar commands) makes
 * the slug stable across runs while avoiding collisions.
 */
export function slugify(cmd: string): string {
  const cleaned = cmd
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  const base = cleaned.slice(0, 36) || "bg"
  // 32-bit FNV-1a hash; takes 4 base36 chars and zero-pads to keep length stable.
  let hash = 0x811c9dc5
  for (let i = 0; i < cmd.length; i++) {
    hash ^= cmd.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const suffix = hash.toString(36).slice(0, 4).padStart(4, "0")
  return `${base}-${suffix}`
}

// ── Wrap ──────────────────────────────────────────────────────────────────

export interface WrapOptions {
  cwd: string
  logDir: string
  platform: NodeJS.Platform
}

export interface WrapResult {
  command: string
  slug: string
}

/**
 * Wrap a dev-server command into a platform-specific background launcher.
 * The launcher detaches the process, redirects stdout/stderr to
 * <logDir>/<slug>.log and <logDir>/<slug>.err.log, and returns a short
 * "background started: pid=..." line within ~400ms so the bash tool exits
 * and the LLM turn can continue.
 *
 * Pure function: no filesystem I/O. The caller (the hook) is responsible
 * for mkdir'ing <logDir> beforehand.
 */
export function wrapInBackground(
  originalCmd: string,
  opts: WrapOptions,
): WrapResult {
  const slug = slugify(originalCmd)
  const pathMod = opts.platform === "win32" ? win32 : posix
  const outLog = pathMod.join(opts.logDir, `${slug}.log`)
  const errLog = pathMod.join(opts.logDir, `${slug}.err.log`)

  const command =
    opts.platform === "win32"
      ? wrapWindows(originalCmd, opts.cwd, outLog, errLog)
      : wrapUnix(originalCmd, opts.cwd, outLog, errLog)

  return { command, slug }
}

/** PowerShell single-quote escape: a single ' inside '...' becomes ''. */
function psSingleQuoteEscape(s: string): string {
  return s.replace(/'/g, "''")
}

/** POSIX shell single-quote escape: a single ' inside '...' becomes '\''. */
function shSingleQuoteEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Windows launcher. Spawns a child powershell with the original command
 * as a single -Command argument, redirects its output to the log files,
 * detaches with -NoNewWindow so the parent shell returns immediately,
 * and checks liveness after 400ms.
 */
function wrapWindows(
  originalCmd: string,
  cwd: string,
  outLog: string,
  errLog: string,
): string {
  const escCmd = psSingleQuoteEscape(originalCmd)
  const escCwd = psSingleQuoteEscape(cwd)
  const escOut = psSingleQuoteEscape(outLog)
  const escErr = psSingleQuoteEscape(errLog)
  return [
    `$__bg_cmd = '${escCmd}'`,
    `$__bg_dir = '${escCwd}'`,
    `$__bg_out = '${escOut}'`,
    `$__bg_err = '${escErr}'`,
    `$__bg_p = Start-Process -FilePath powershell -ArgumentList @('-NoProfile','-NoLogo','-Command', $__bg_cmd) -NoNewWindow -RedirectStandardOutput $__bg_out -RedirectStandardError $__bg_err -WorkingDirectory $__bg_dir -PassThru`,
    `Start-Sleep -Milliseconds 400`,
    `if (Get-Process -Id $__bg_p.Id -ErrorAction SilentlyContinue) { Write-Output ("background started: pid=" + $__bg_p.Id + " log=" + $__bg_out) } else { Write-Output ("background FAILED to start; see " + $__bg_err) }`,
  ].join("\n")
}

/**
 * Unix launcher. cd into the workspace, redirect output, fork the command
 * with `&` to detach it from the parent shell, then poll liveness after
 * 0.4s. We do NOT `wait` — the parent shell returns right away.
 */
function wrapUnix(
  originalCmd: string,
  cwd: string,
  outLog: string,
  errLog: string,
): string {
  const escCwd = shSingleQuoteEscape(cwd)
  const escCmd = shSingleQuoteEscape(originalCmd)
  const escOut = shSingleQuoteEscape(outLog)
  const escErr = shSingleQuoteEscape(errLog)
  return [
    `cd ${escCwd} && ${escCmd} > ${escOut} 2> ${escErr} &`,
    `__bg_pid=$!`,
    `sleep 0.4`,
    `if kill -0 $__bg_pid 2>/dev/null; then echo "background started: pid=$__bg_pid log=${outLog}"; else echo "background FAILED to start; see ${errLog}"; fi`,
  ].join("\n")
}

// ── Hook bundle ───────────────────────────────────────────────────────────

/**
 * Subset of the bash tool's args. We only read `command` and `cwd`;
 * `description` and `timeout` are optional and we only WRITE description.
 */
interface BashArgsShape {
  command?: unknown
  cwd?: unknown
  description?: unknown
  timeout?: unknown
}

export interface BashProtocolOptions {
  /** Default true. Honoring env var OPENCODE_MISSION_BASH_BG=0 forces false. */
  enabled?: boolean
  /** Used as the logDir base; default = process.cwd(). */
  workspaceDir?: string
}

interface TrackedRewrite {
  originalCmd: string
  logPath: string
}

/**
 * Create the 3-hook bundle. Each call returns a fresh set of hooks with
 * its own per-factory tracking map, so multiple instances (e.g. tests)
 * don't share state.
 */
export function registerBashProtocolHooks(
  opts: BashProtocolOptions = {},
): Required<
  Pick<Hooks, "tool.definition" | "tool.execute.before" | "tool.execute.after">
> {
  // Track original commands by callID so tool.execute.after can append a
  // useful marker. Bounded to avoid leaks on long-running sessions.
  const tracked = new Map<string, TrackedRewrite>()

  const enabled = resolveEnabled(opts)

  return {
    "tool.definition": async (input, output) => {
      if (input.toolID !== TOOL_ID) return
      // Append, don't replace — the opencode-supplied description is preserved.
      output.description = (output.description ?? "") + PROTOCOL_BLOCK
    },

    "tool.execute.before": async (input, output) => {
      if (input.tool !== TOOL_ID) return
      if (!enabled) return
      const args = output.args as BashArgsShape | null | undefined
      if (!args || typeof args !== "object") return
      const command = args.command
      if (typeof command !== "string" || !command) return

      if (!looksLikeDevServer(command)) return

      // Resolve cwd: explicit args.cwd first, then workspace, then process.cwd().
      const cwd =
        (typeof args.cwd === "string" && args.cwd) ||
        opts.workspaceDir ||
        process.cwd()

      const logDir = join(cwd, ".opencode", "server-logs")
      try {
        mkdirSync(logDir, { recursive: true })
      } catch (err) {
        // mkdir failure is non-fatal: don't wrap (let the dev server run
        // synchronously). The LLM would see a blocking bash call, but we
        // don't silently lose output by wrapping to a non-existent dir.
        log(
          `bg-wrap mkdir failed session=${input.sessionID} dir=${logDir} err=${(err as Error).message}`,
        )
        return
      }

      const { command: wrapped, slug } = wrapInBackground(command, {
        cwd,
        logDir,
        platform: process.platform,
      })

      // Mutate args in place — opencode reads output.args after this hook returns.
      args.command = wrapped
      args.description = `background-launched: ${
        command.length > 80 ? command.slice(0, 80) + "…" : command
      }`

      const logPath = join(logDir, `${slug}.log`)
      tracked.set(input.callID, { originalCmd: command, logPath })
      // Bounded map: drop the oldest entry if over cap.
      if (tracked.size > MAX_TRACKED) {
        const firstKey = tracked.keys().next().value
        if (firstKey !== undefined) tracked.delete(firstKey)
      }

      log(
        `bg-wrap session=${input.sessionID} pid=${input.callID} cmd=${command.slice(0, 40)}`,
      )
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== TOOL_ID) return
      const entry = tracked.get(input.callID)
      if (!entry) return
      tracked.delete(input.callID)

      if (typeof output.output !== "string") return
      // Idempotent: don't re-append if upstream already attached our marker.
      if (output.output.includes("[opencode-mission] background process launched")) {
        return
      }

      const errPath = entry.logPath.replace(/\.log$/, ".err.log")
      const marker = [
        "",
        "[opencode-mission] background process launched: original=" + entry.originalCmd,
        "logs: " + entry.logPath + " and " + errPath,
        "use `Get-Process` / `kill` to stop, or wait for session.idle cleanup",
      ].join("\n")
      output.output = output.output + marker
    },
  }
}

function resolveEnabled(opts: BashProtocolOptions): boolean {
  if (process.env.OPENCODE_MISSION_BASH_BG === "0") return false
  return opts.enabled !== false
}

// Type-only re-export so consumers don't need to import from @opencode-ai/plugin.
import type { Hooks } from "@opencode-ai/plugin"
