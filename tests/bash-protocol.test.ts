// Unit tests for the bash background protocol. Run with: bun test
//
// Coverage:
// 1. looksLikeDevServer (positive, negative, skip conditions, pipeline form)
// 2. wrapInBackground (Windows and Unix output shape, slug stability)
// 3. registerBashProtocolHooks (description append, before/after mutation,
//    enabled flag, env var override, mkdir idempotency)

import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { posix, win32, join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  looksLikeDevServer,
  matchesStrictDevPattern,
  registerBashProtocolHooks,
  slugify,
  wrapInBackground,
} from "../src/hooks/bash-protocol.js"

/** Make a throwaway temp directory. Caller is responsible for rmSync. */
function tmp(): string {
  return mkdtempSync(join(tmpdir(), "bash-protocol-"))
}

// ─── matchesStrictDevPattern ──────────────────────────────────────────────

describe("matchesStrictDevPattern", () => {
  test("matches the documented dev-server patterns", () => {
    expect(matchesStrictDevPattern("npm run dev")).toBe(true)
    expect(matchesStrictDevPattern("npm start")).toBe(true)
    expect(matchesStrictDevPattern("pnpm dev")).toBe(true)
    expect(matchesStrictDevPattern("pnpm start")).toBe(true)
    expect(matchesStrictDevPattern("yarn dev")).toBe(true)
    expect(matchesStrictDevPattern("yarn start")).toBe(true)
    expect(matchesStrictDevPattern("bun run dev")).toBe(true)
    expect(matchesStrictDevPattern("bun dev")).toBe(true)
    expect(matchesStrictDevPattern("vite")).toBe(true)
    expect(matchesStrictDevPattern("vite dev")).toBe(true)
    expect(matchesStrictDevPattern("next dev")).toBe(true)
    expect(matchesStrictDevPattern("next start")).toBe(true)
    expect(matchesStrictDevPattern("nuxt dev")).toBe(true)
    expect(matchesStrictDevPattern("flask run")).toBe(true)
    expect(matchesStrictDevPattern("uvicorn app:app --reload")).toBe(true)
    expect(matchesStrictDevPattern("uvicorn")).toBe(true)
    expect(matchesStrictDevPattern("python -m http.server 8000")).toBe(true)
    expect(matchesStrictDevPattern("python -m flask run")).toBe(true)
  })

  test("rejects non-dev commands", () => {
    expect(matchesStrictDevPattern("npm install")).toBe(false)
    expect(matchesStrictDevPattern("npm test")).toBe(false)
    expect(matchesStrictDevPattern("node build.js")).toBe(false)
    expect(matchesStrictDevPattern("ls -la")).toBe(false)
    expect(matchesStrictDevPattern("echo npm run dev")).toBe(false)
  })

  test("rejects empty / whitespace", () => {
    expect(matchesStrictDevPattern("")).toBe(false)
    expect(matchesStrictDevPattern("   ")).toBe(false)
  })
})

// ─── looksLikeDevServer ───────────────────────────────────────────────────

describe("looksLikeDevServer", () => {
  test("matches positive cases (single segment)", () => {
    expect(looksLikeDevServer("npm run dev")).toBe(true)
    expect(looksLikeDevServer("vite")).toBe(true)
    expect(looksLikeDevServer("next dev")).toBe(true)
    expect(looksLikeDevServer("flask run")).toBe(true)
    expect(looksLikeDevServer("uvicorn app:app --reload")).toBe(true)
    expect(looksLikeDevServer("python -m http.server 8000")).toBe(true)
  })

  test("matches `pnpm/yarn run` and `pnpm run-script` invocations", () => {
    // P0-3: pnpm dev / pnpm run dev / pnpm run-script dev / yarn run dev
    // were false negatives before the PREFIX + run(?:-script)? groups landed.
    expect(looksLikeDevServer("pnpm run dev")).toBe(true)
    expect(looksLikeDevServer("pnpm run-script dev")).toBe(true)
    expect(looksLikeDevServer("yarn run dev")).toBe(true)
  })

  test("matches npx/bunx/exec-wrapped dev commands", () => {
    // P0-3: the PREFIX group covers `npx <bin>` / `bunx <bin>` /
    // `pnpm exec <bin>` / `npm exec <bin>`. Each was a false negative
    // before the PREFIX landed.
    expect(looksLikeDevServer("npx vite")).toBe(true)
    expect(looksLikeDevServer("npx next dev")).toBe(true)
    expect(looksLikeDevServer("npx uvicorn app:app --reload")).toBe(true)
    expect(looksLikeDevServer("bunx vite")).toBe(true)
    expect(looksLikeDevServer("pnpm exec vite")).toBe(true)
    expect(looksLikeDevServer("npm exec vite")).toBe(true)
  })

  test("PREFIX does not over-fire on unrelated npx/exec targets", () => {
    // P0-3: the PREFIX is a CLOSED list of dev-server bin names; the
    // bin name itself still has to match the strict pattern. So
    // `npx something-else` and `npm exec jest` are NOT dev servers.
    expect(looksLikeDevServer("npx something-else")).toBe(false)
    expect(looksLikeDevServer("npm exec jest")).toBe(false)
  })

  test("matches pipeline form with cd", () => {
    expect(looksLikeDevServer("cd backend && npm run dev")).toBe(true)
    expect(looksLikeDevServer("cd /tmp/foo ; vite")).toBe(true)
    expect(looksLikeDevServer("cd /tmp/foo; vite")).toBe(true)
    expect(looksLikeDevServer("cd backend && cd frontend && npm run dev")).toBe(true)
  })

  test("trims surrounding whitespace", () => {
    expect(looksLikeDevServer("  npm run dev  ")).toBe(true)
  })

  test("rejects non-dev commands", () => {
    expect(looksLikeDevServer("npm install")).toBe(false)
    expect(looksLikeDevServer("npm test")).toBe(false)
    expect(looksLikeDevServer("node build.js")).toBe(false)
    expect(looksLikeDevServer("ls -la")).toBe(false)
  })

  test("rejects already-redirected / backgrounded / piped / nohup", () => {
    expect(looksLikeDevServer("npm run dev > log.txt")).toBe(false)
    expect(looksLikeDevServer("npm run dev >> log.txt")).toBe(false)
    expect(looksLikeDevServer("npm run dev &")).toBe(false)
    expect(looksLikeDevServer("nohup npm run dev")).toBe(false)
    expect(looksLikeDevServer("npm run dev | tee log")).toBe(false)
    expect(looksLikeDevServer("npm run dev | tail -f log")).toBe(false)
  })

  test("rejects dev string used as an argument to another command", () => {
    // The dev pattern is anchored at segment start, so wrapping it with
    // `echo` / `cat` / etc. doesn't match.
    expect(looksLikeDevServer("echo npm run dev")).toBe(false)
    expect(looksLikeDevServer("cat README.md && echo vite")).toBe(false)
  })

  test("rejects comments and empty input", () => {
    expect(looksLikeDevServer("")).toBe(false)
    expect(looksLikeDevServer("   ")).toBe(false)
    expect(looksLikeDevServer("# npm run dev")).toBe(false)
  })

  test("rejects non-bash-tool input shape but doesn't crash", () => {
    // No throw on odd inputs.
    expect(() => looksLikeDevServer("a && b && c")).not.toThrow()
    expect(looksLikeDevServer("a && b && c")).toBe(false)
  })
})

// ─── slugify ──────────────────────────────────────────────────────────────

describe("slugify", () => {
  test("produces a stable slug for the same command", () => {
    expect(slugify("npm run dev")).toBe(slugify("npm run dev"))
  })

  test("produces different slugs for different commands", () => {
    expect(slugify("npm run dev")).not.toBe(slugify("npm start"))
  })

  test("slug contains lowercase + dash + hash suffix", () => {
    const s = slugify("npm run dev")
    expect(s).toMatch(/^[a-z0-9-]+-[a-z0-9]{4}$/)
  })

  test("falls back to 'bg' for fully non-alphanum input", () => {
    const s = slugify("###")
    // Non-alphanum becomes "-", trimmed to "bg"
    expect(s.startsWith("bg-")).toBe(true)
  })
})

// ─── wrapInBackground ─────────────────────────────────────────────────────

describe("wrapInBackground", () => {
  test("Windows: contains Start-Process, NoNewWindow, log paths, original command", () => {
    const cwd = win32.join("C:", "work")
    const logDir = win32.join(cwd, ".opencode", "server-logs")
    const { command, slug } = wrapInBackground("npm run dev", {
      cwd,
      logDir,
      platform: "win32",
    })
    expect(command).toContain("Start-Process")
    expect(command).toContain("NoNewWindow")
    expect(command).toContain("-FilePath powershell")
    expect(command).toContain("RedirectStandardOutput")
    expect(command).toContain("RedirectStandardError")
    expect(command).toContain("npm run dev")
    expect(command).toContain(win32.join(logDir, `${slug}.log`))
    expect(command).toContain(win32.join(logDir, `${slug}.err.log`))
    expect(command).toContain("Get-Process")
    expect(command).toContain("background started: pid=")
    expect(slug.length).toBeGreaterThan(0)
  })

  test("Windows: original command survives single-quote escaping (contains 'npm run dev')", () => {
    const { command } = wrapInBackground("npm run dev", {
      cwd: "C:\\w",
      logDir: "C:\\w\\.opencode\\server-logs",
      platform: "win32",
    })
    // The wrapped command should embed the original command verbatim
    // (after PS single-quote escaping, which is the no-op ' -> '').
    expect(command).toContain("npm run dev")
  })

  test("wrapInBackground escapes single quotes in originalCmd on Windows", () => {
    // P1-1 (D.1): PowerShell single-quote escape. A literal `'` inside
    // a `'...'` literal must be written as `''` so the parser keeps it
    // as part of the string instead of terminating the literal.
    const { command } = wrapInBackground("node server.js --name=\"O'Brien\"", {
      cwd: "C:\\app",
      logDir: "C:\\app\\.opencode\\server-logs",
      platform: "win32",
    })
    // psSingleQuoteEscape doubles every ' → original 'O'Brien' becomes 'O''Brien'.
    // The wrapper places the whole thing inside '...', so we expect:
    //   'node server.js --name="O''Brien"'
    expect(command).toContain("'node server.js --name=\"O''Brien\"'")
  })

  test("wrapInBackground preserves $ literally inside PowerShell single-quoted strings", () => {
    // P1-1 (D.1): PowerShell does NOT interpolate inside single-quoted
    // strings, so $HOME must appear verbatim. We verify the wrapper
    // emits the assignment inside a '...' literal rather than a
    // double-quoted string (which would interpolate $HOME).
    const { command } = wrapInBackground("echo $HOME", {
      cwd: "C:\\app",
      logDir: "C:\\app\\.opencode\\server-logs",
      platform: "win32",
    })
    expect(command).toContain("$__bg_cmd = 'echo $HOME'")
  })

  test("Unix: contains original command, &, kill -0, log paths", () => {
    const cwd = "/work"
    const logDir = posix.join(cwd, ".opencode", "server-logs")
    const { command, slug } = wrapInBackground("npm run dev", {
      cwd,
      logDir,
      platform: "linux",
    })
    expect(command).toContain("npm run dev")
    expect(command).toMatch(/&\s*$|\&\s*\n/m) // trailing & to detach
    expect(command).toContain("kill -0")
    expect(command).toContain("background started: pid=")
    expect(command).toContain(posix.join(logDir, `${slug}.log`))
    expect(command).toContain(posix.join(logDir, `${slug}.err.log`))
  })

  test("Unix: also handles 'darwin' as a non-win32 platform", () => {
    const { command } = wrapInBackground("vite", {
      cwd: "/w",
      logDir: "/w/.opencode/server-logs",
      platform: "darwin",
    })
    expect(command).toContain("kill -0")
    expect(command).not.toContain("Start-Process")
  })

  test("wrapInBackground Unix escapes single quotes", () => {
    // P1-1 (D.1): POSIX single-quote escape. A literal ' inside '...'
    // is written as '\'' (close, literal ', reopen). The whole string
    // is then wrapped in '...'.
    const { command } = wrapInBackground("echo 'hello world'", {
      cwd: "/app",
      logDir: "/app/.opencode/server-logs",
      platform: "linux",
    })
    // shSingleQuoteEscape("echo 'hello world'") produces:
    //   'echo '\''hello world'\'''
    // We assert the inner middle portion is present (without the
    // surrounding outer quotes, so a leading/trailing quote elsewhere
    // in the wrapper doesn't accidentally satisfy the assertion).
    expect(command).toContain("echo '\\''hello world'\\''")
  })

  test("slug is independent of cwd / logDir", () => {
    const a = wrapInBackground("npm run dev", {
      cwd: "/a",
      logDir: "/x",
      platform: "linux",
    })
    const b = wrapInBackground("npm run dev", {
      cwd: "/b",
      logDir: "/y",
      platform: "linux",
    })
    expect(a.slug).toBe(b.slug)
  })

  test("different commands produce different slugs", () => {
    const a = wrapInBackground("npm run dev", {
      cwd: "/a",
      logDir: "/x",
      platform: "linux",
    })
    const b = wrapInBackground("npm start", {
      cwd: "/a",
      logDir: "/x",
      platform: "linux",
    })
    expect(a.slug).not.toBe(b.slug)
  })
})

// ─── registerBashProtocolHooks ────────────────────────────────────────────

describe("registerBashProtocolHooks", () => {
  test("tool.execute.before: does not mutate when enabled=false", async () => {
    const hooks = registerBashProtocolHooks({ enabled: false })
    const output: any = { args: { command: "npm run dev", description: "orig" } }
    await hooks["tool.execute.before"](
      { tool: "bash", sessionID: "ses1", callID: "c1" },
      output,
    )
    expect(output.args.command).toBe("npm run dev")
    expect(output.args.description).toBe("orig")
  })

  test("tool.execute.before: rewrites dev command and sets description", async () => {
    const dir = tmp()
    try {
      const hooks = registerBashProtocolHooks({ workspaceDir: dir })
      const output: any = { args: { command: "vite", description: "orig" } }
      await hooks["tool.execute.before"](
        { tool: "bash", sessionID: "ses1", callID: "c1" },
        output,
      )
      expect(output.args.command).not.toBe("vite")
      expect(output.args.command).toContain("vite")
      expect(output.args.description).toContain("background-launched")
      expect(output.args.description).toContain("vite")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("tool.execute.before: long original command is truncated to 80 chars + ellipsis", async () => {
    const dir = tmp()
    try {
      const hooks = registerBashProtocolHooks({ workspaceDir: dir })
      const longCmd = "npm run dev " + "x".repeat(200)
      const output: any = { args: { command: longCmd } }
      await hooks["tool.execute.before"](
        { tool: "bash", sessionID: "ses1", callID: "c1" },
        output,
      )
      // description is `background-launched: <first 80 chars>…` = 80 chars + ellipsis
      const desc = output.args.description as string
      const inner = desc.replace(/^background-launched:\s*/, "")
      expect(inner.endsWith("…")).toBe(true)
      expect(inner.length).toBeLessThanOrEqual(81) // 80 chars + ellipsis
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("tool.execute.before: does not mutate non-dev command", async () => {
    const hooks = registerBashProtocolHooks({})
    const output: any = { args: { command: "ls -la", description: "orig" } }
    await hooks["tool.execute.before"](
      { tool: "bash", sessionID: "ses1", callID: "c1" },
      output,
    )
    expect(output.args.command).toBe("ls -la")
    expect(output.args.description).toBe("orig")
  })

  test("tool.execute.before: does not mutate when mkdir fails", async () => {
    // P1-2 (D.2): when mkdirSync throws (e.g. the resolved logDir path
    // is invalid), the hook must return early and leave args.command
    // untouched. We trigger the throw with a NUL byte in the path —
    // Node.js / bun reject null bytes in fs paths with
    // ERR_INVALID_ARG_VALUE before any syscall.
    const bad = "C:\\app\u0000invalid"
    const hooks = registerBashProtocolHooks({ workspaceDir: bad })
    const input = { tool: "bash", sessionID: "ses_x", callID: "call_1" }
    const output: any = { args: { command: "npm run dev", cwd: bad } }
    await hooks["tool.execute.before"](input as any, output as any)
    expect(output.args.command).toBe("npm run dev") // unchanged
  })

  test("tool.execute.before: ignores non-bash tool", async () => {
    const hooks = registerBashProtocolHooks({})
    const output: any = { args: { command: "npm run dev", description: "orig" } }
    await hooks["tool.execute.before"](
      { tool: "write", sessionID: "ses1", callID: "c1" },
      output,
    )
    expect(output.args.command).toBe("npm run dev")
  })

  test("tool.execute.before: prefers args.cwd over workspaceDir", async () => {
    const wsDir = tmp()
    const explicitCwd = tmp()
    try {
      const hooks = registerBashProtocolHooks({ workspaceDir: wsDir })
      const output: any = {
        args: { command: "vite", cwd: explicitCwd },
      }
      await hooks["tool.execute.before"](
        { tool: "bash", sessionID: "ses1", callID: "c1" },
        output,
      )
      // logDir is under explicitCwd, not wsDir
      const expected = join(explicitCwd, ".opencode", "server-logs")
      expect(existsSync(expected)).toBe(true)
      expect(existsSync(join(wsDir, ".opencode", "server-logs"))).toBe(false)
    } finally {
      rmSync(wsDir, { recursive: true, force: true })
      rmSync(explicitCwd, { recursive: true, force: true })
    }
  })

  test("tool.definition: appends the protocol block for bash", async () => {
    const hooks = registerBashProtocolHooks({})
    const output: any = { description: "existing description", parameters: {} }
    await hooks["tool.definition"]({ toolID: "bash" }, output)
    expect(output.description).toContain("<bash_background_protocol>")
    expect(output.description).toContain("existing description")
    expect(output.description).toContain("background started: pid=")
  })

  test("tool.definition: does nothing for non-bash tools", async () => {
    const hooks = registerBashProtocolHooks({})
    const output: any = { description: "write desc", parameters: {} }
    await hooks["tool.definition"]({ toolID: "write" }, output)
    expect(output.description).toBe("write desc")
    expect(output.description).not.toContain("<bash_background_protocol>")
  })

  test("tool.definition: handles undefined description without throwing", async () => {
    const hooks = registerBashProtocolHooks({})
    const output: any = { description: undefined, parameters: {} }
    await hooks["tool.definition"]({ toolID: "bash" }, output)
    expect(typeof output.description).toBe("string")
    expect(output.description).toContain("<bash_background_protocol>")
  })

  test("env var OPENCODE_MISSION_BASH_BG=0 overrides enabled=true", async () => {
    const prev = process.env.OPENCODE_MISSION_BASH_BG
    process.env.OPENCODE_MISSION_BASH_BG = "0"
    try {
      const hooks = registerBashProtocolHooks({ enabled: true })
      const output: any = { args: { command: "npm run dev", description: "orig" } }
      await hooks["tool.execute.before"](
        { tool: "bash", sessionID: "ses1", callID: "c1" },
        output,
      )
      expect(output.args.command).toBe("npm run dev")
      expect(output.args.description).toBe("orig")
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_MISSION_BASH_BG
      else process.env.OPENCODE_MISSION_BASH_BG = prev
    }
  })

  test("env var OPENCODE_MISSION_BASH_BG=1 still allows wrapping", async () => {
    const prev = process.env.OPENCODE_MISSION_BASH_BG
    process.env.OPENCODE_MISSION_BASH_BG = "1"
    try {
      const dir = tmp()
      try {
        const hooks = registerBashProtocolHooks({ workspaceDir: dir })
        const output: any = { args: { command: "npm run dev" } }
        await hooks["tool.execute.before"](
          { tool: "bash", sessionID: "ses1", callID: "c1" },
          output,
        )
        expect(output.args.command).not.toBe("npm run dev")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_MISSION_BASH_BG
      else process.env.OPENCODE_MISSION_BASH_BG = prev
    }
  })

  test("end-to-end: after rewrite, tool.execute.after appends marker", async () => {
    const dir = tmp()
    try {
      const hooks = registerBashProtocolHooks({ workspaceDir: dir })
      const before: any = { args: { command: "vite", description: "orig" } }
      await hooks["tool.execute.before"](
        { tool: "bash", sessionID: "ses1", callID: "c1" },
        before,
      )
      expect(before.args.command).not.toBe("vite")

      const after: any = { title: "t", output: "server is up on :3000", metadata: {} }
      await hooks["tool.execute.after"](
        { tool: "bash", sessionID: "ses1", callID: "c1", args: before.args },
        after,
      )
      expect(after.output).toContain("server is up on :3000")
      expect(after.output).toContain("[opencode-mission] background process launched")
      expect(after.output).toContain("original=vite")
      expect(after.output).toMatch(/\.log\b/)
      expect(after.output).toMatch(/\.err\.log\b/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("tool.execute.after: no-op when callID wasn't tracked", async () => {
    const hooks = registerBashProtocolHooks({})
    const after: any = { title: "t", output: "ls output", metadata: {} }
    await hooks["tool.execute.after"](
      { tool: "bash", sessionID: "ses1", callID: "c-unknown", args: {} },
      after,
    )
    expect(after.output).toBe("ls output")
  })

  test("tool.execute.after: no-op for non-bash tool", async () => {
    const hooks = registerBashProtocolHooks({})
    const after: any = { title: "t", output: "ok", metadata: {} }
    await hooks["tool.execute.after"](
      { tool: "write", sessionID: "ses1", callID: "c1", args: {} },
      after,
    )
    expect(after.output).toBe("ok")
  })

  test("tool.execute.after: marker is idempotent (doesn't double-append)", async () => {
    const dir = tmp()
    try {
      const hooks = registerBashProtocolHooks({ workspaceDir: dir })
      const before: any = { args: { command: "vite" } }
      await hooks["tool.execute.before"](
        { tool: "bash", sessionID: "ses1", callID: "c1" },
        before,
      )
      // Pre-existing marker in output
      const existing =
        "[opencode-mission] background process launched: original=vite\n"
      const after: any = { title: "t", output: existing, metadata: {} }
      await hooks["tool.execute.after"](
        { tool: "bash", sessionID: "ses1", callID: "c1", args: before.args },
        after,
      )
      const matches = after.output.match(/background process launched/g) ?? []
      expect(matches.length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("tool.execute.after: tracked entry is consumed (second call is no-op)", async () => {
    const dir = tmp()
    try {
      const hooks = registerBashProtocolHooks({ workspaceDir: dir })
      const before: any = { args: { command: "vite" } }
      await hooks["tool.execute.before"](
        { tool: "bash", sessionID: "ses1", callID: "c1" },
        before,
      )
      const after1: any = { title: "t", output: "ok", metadata: {} }
      await hooks["tool.execute.after"](
        { tool: "bash", sessionID: "ses1", callID: "c1", args: before.args },
        after1,
      )
      expect(after1.output).toContain("[opencode-mission]")

      const after2: any = { title: "t", output: "ok2", metadata: {} }
      await hooks["tool.execute.after"](
        { tool: "bash", sessionID: "ses1", callID: "c1", args: before.args },
        after2,
      )
      expect(after2.output).toBe("ok2")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("mkdir of logDir is idempotent across multiple rewrites", async () => {
    const dir = tmp()
    try {
      const hooks = registerBashProtocolHooks({ workspaceDir: dir })
      const logDir = join(dir, ".opencode", "server-logs")

      const out1: any = { args: { command: "npm run dev" } }
      await hooks["tool.execute.before"](
        { tool: "bash", sessionID: "ses1", callID: "c1" },
        out1,
      )
      expect(existsSync(logDir)).toBe(true)

      const out2: any = { args: { command: "vite" } }
      await hooks["tool.execute.before"](
        { tool: "bash", sessionID: "ses1", callID: "c2" },
        out2,
      )
      expect(existsSync(logDir)).toBe(true)

      // No leftover .tmp files (mkdir only, no atomic-rename path)
      // Just sanity: the dir is readable
      expect(existsSync(logDir)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("empty / non-string command is handled safely", async () => {
    const hooks = registerBashProtocolHooks({})
    const cases: any[] = [
      { args: { command: "" } },
      { args: {} },
      { args: null },
      { args: "not-an-object" },
    ]
    for (const output of cases) {
      await expect(
        hooks["tool.execute.before"](
          { tool: "bash", sessionID: "ses1", callID: "c1" },
          output,
        ),
      ).resolves.toBeUndefined()
    }
  })
})
