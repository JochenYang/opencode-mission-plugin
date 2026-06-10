# Handoff: opencode-misson 完整开发记录

> Topic slug 原文（含拼写）：`写在opencode-misson项目下，完整的开发记录`
> 生成时间：2026-06-10 18:45
> 用途：把当前 opencode-mission 项目的开发状态打包成可交接工件，便于 reset 后立即 resume。
>
> **修订（2026-06-10，路径清理）**：主人确认项目已从原工作空间迁出，作为独立项目独立部署。本 handoff 已全面清除作者机器上的绝对路径，文件清单统一改为项目内相对路径，与 `Key Files` 段的相对风格一致。**历史叙述（迁移前的 git 上下文）以"原 handoff 表述"形式保留在 `Repository State` 段尾的引用块里**，仅作历史轨迹参考，已不再指代真实路径。

## Task

- Objective: 在 `opencode-mission` 项目根生成完整的开发记录（架构、文件清单、设计决策、验证、风险、后续）
- Current phase: 项目已构建可运行（`dist/index.js` 56,155 B 存在），但**项目根尚未 `git init`，26 个文件处于裸盘状态**（2026-06-10 修订：项目已从原工作空间迁出独立，与原工作空间无版本化关系）
- Requested outcome: 任何下一会话读这份 handoff 就能在不重新探索的情况下 resume

## Repository State

- Repo: `opencode-mission/`（**项目自身即 git 根**，已从原工作空间迁出独立）
- Git root: `<项目根>/.git`（**尚未 init**，下一次操作前需 `git init`）
- Branch: N/A（无 git，初始化后默认 `main` 或 `master` 取决于 git 全局配置）
- Working tree: 26 个文件（10 根级 + 18 个 `.ts`）+ 1 个 ignored 目录 `dist/` + 1 个 ignored 单文件 `*.log`（仅日志；`test-mission-run/` `hello*.txt` 已从 `.gitignore` 移除，与已删的 `smoke-mission/` 冒烟产物对齐）
- Relevant commit: 无（项目尚未 init，0 commit）
- Build artifact: `dist/index.js` 存在（56,155 B），被 `.gitignore` 排除

> **原 handoff 表述（已过时，仅作历史轨迹）**：项目曾作为子目录嵌入原工作空间仓内，父目录即 git 根、`main` 分支、26 个 untracked 子树文件、与原工作空间 5 个 workspace commit 共存。**本引用块仅说明"曾有嵌套关系"**，不再含具体路径或 commit hash 细节。

## Changed Files

- Evidence source: **无 git**（项目根尚未 init；`scripts/git_changes.py` 不适用）。下方清单来自会话内 `Get-ChildItem -Recurse` + 早段 `git ls-files` 推断，**session-derived 模式**。所有 entry 的 `confidence = high`（文件存在与行数通过读工具直接核实），但**未经过 git 校验**，不视为已签入状态。
- Working tree on disk:
  - 10 个根级文件：`.gitignore` (11 行，2026-06-10 修订)、`AGENTS.md` (196 行)、`DESIGN.md` (277 行)、`README.md` (167 行)、`README.en.md` (168 行)、`TESTING.md` (130 行)、`package.json` (32 行)、`tsconfig.json` (19 行)
  - 3 个目录：`src/` (18 `.ts`)、`dist/` (1 `index.js`, 56,155 B, gitignored)、`repo/` (含本 handoff)
  - 0 个 `node_modules/`
- `.gitignore` (session-derived) — Line ranges: `new 1-11` (修订后)
  - Summary: 11 行，忽略 `node_modules/`、`dist/`、`*.log`、`.vscode/`、`.idea/`、`*.swp`（**已删除** `test-mission-run/` 和 `hello*.txt` —— 与已删 `smoke-mission/` 冒烟产物对齐）
  - Snippets:
    - `# Build artifacts`
    - `dist/`
    - `# Logs`
- `AGENTS.md` (session-derived) — Line ranges: `new 1-196`
  - Summary: 项目说明 + 设计亮点 + 验证清单 + 已知限制 + 后续工作
- `DESIGN.md` (session-derived) — Line ranges: `new 1-277`
  - Summary: 完整设计文档
- `README.md` (session-derived) — Line ranges: `new 1-167`
  - Summary: 中文 README
- `README.en.md` (session-derived) — Line ranges: `new 1-168`
  - Summary: 英文 README
- `TESTING.md` (session-derived) — Line ranges: `new 1-130`
  - Summary: 测试指南（强调"预热全局选项"）
- `package.json` (session-derived) — Line ranges: `new 1-32`
  - Summary: `name=opencode-mission`, `version=0.1.0`, `type=module`, `main=./dist/index.js`
  - Snippets:
    - `"build": "bun build ./src/index.ts --outfile ./dist/index.js --target node --format esm --external @opencode-ai/plugin --external @opencode-ai/plugin/tool --external @opencode-ai/sdk --external @opencode-ai/sdk/v2 --external zod --external effect"`
    - `"typecheck": "tsc --noEmit"`
    - `"test": "bun test"`
- `tsconfig.json` (session-derived) — Line ranges: `new 1-19`
  - Summary: `target=ES2022`, `module=ESNext`, `strict=true`, `noEmit=true`, `include=src/**/*`
- `src\index.ts` (session-derived) — Line ranges: `new 1-114`
  - Summary: Plugin entry。wire 4 个 tool + 6 个 hook；通过 `extractV1Client(input.client)` 拿 runtime 注入的 V1 HeyApi client
- `src\types.ts` (session-derived) — Line ranges: `new 1-159`
  - Summary: 类型定义（Mission、Budget、Status、Actor、VerificationReport）
- `src\mission-store.ts` (session-derived) — Line ranges: `new 1-346`
  - Summary: 状态机 + 预算累计 + 持久化的**唯一 mutation 入口**（含 `assertTransition`）
- `src\command-template.ts` (session-derived) — Line ranges: `new 1-163`
  - Summary: `/mission` 命令模板，含 ABSOLUTE RULE（强制 CreateMission 为首个工具调用）+ bash 协议
- `src\prompts.ts` (session-derived) — Line ranges: `new 1-89`
  - Summary: 续推 prompt 模板 + 4 维自审清单
- `src\prompts-injection.ts` (session-derived) — Line ranges: `new 1-106`
  - Summary: 3 级 system prompt 注入（active/blocked/paused）
- `src\tools\create-mission.ts` (session-derived) — Line ranges: `new 1-72`
  - Summary: CreateMission tool
- `src\tools\update-mission.ts` (session-derived) — Line ranges: `new 1-53`
  - Summary: UpdateMission tool（非 mission-verify 子代理调用会被拒）
- `src\tools\get-mission.ts` (session-derived) — Line ranges: `new 1-40`
  - Summary: GetMission tool（子代理自动读父会话的 mission）
- `src\tools\set-mission-budget.ts` (session-derived) — Line ranges: `new 1-104`
  - Summary: SetMissionBudget tool（单维度/次，封闭 enum 单位）
- `src\hooks\event-hook.ts` (session-derived) — Line ranges: `new 1-211`
  - Summary: 续推（`EventSessionIdle`）+ 中断跟踪 + token 累计
- `src\hooks\chat-message.ts` (session-derived) — Line ranges: `new 1-102`
  - Summary: 验证子代理 context 注入 + JSON 报告解析
- `src\hooks\system-transform.ts` (session-derived) — Line ranges: `new 1-42`
  - Summary: 主会话 system prompt 3 级注入
- `src\hooks\command-execute.ts` (session-derived) — Line ranges: `new 1-32`
  - Summary: `/mission` 命令的 synthetic-化
- `src\utils\session-http.ts` (session-derived) — Line ranges: `new 1-84`
  - Summary: V1 HeyApi client 包装（读/写 `Session.metadata.missionPro`）
- `src\utils\format.ts` (session-derived) — Line ranges: `new 1-113`
  - Summary: 格式化助手（duration、number、status 输出）
- `src\verify\verify-prompt.ts` (session-derived) — Line ranges: `new 1-90`
  - Summary: verify 子代理 system prompt
- `src\verify\verify-context.ts` (session-derived) — Line ranges: `new 1-39`
  - Summary: 子代理 context 注入模板

> 注：`scripts/git_changes.py` 输出里的中文字符在 stdout 阶段出现过编码错乱（显示为 `��`），但这是终端/管道编码问题，不影响实际文件内容（`AGENTS.md` 已经是 UTF-8 中文且读工具正常返回）。

> 注：本会话前面还创建过 `smoke-mission/` 端到端冒烟任务目录（含 `package.json`、`src/add.ts`、`tests/add.test.ts`），是 `/mission` 指令的端到端冒烟任务，**已由主人在写 handoff 前主动删除**（理由：纯测试产物）。本会话早段 `bun test 2 pass / 0 fail` 与 `verdict=passed` 的验证仍然成立。该路径**不**计入 `Changed Files`（git 不再有任何相关记录，也不需要保留）。

## Current Status

- Completed:
  - 项目架构设计：4 状态机、3 维预算、4 维验证、续推/中断机制
  - 全部 18 个 `.ts` 源文件 + 6 个根目录 markdown + 2 个配置文件（`package.json`/`tsconfig.json`） + `.gitignore` 落地
  - 4 个 tool 工具 + 6 个 hook 实现齐全
  - `bun run build` 产物 `dist/index.js` 已生成（56,155 B）
  - ABSOLUTE RULE 写入 `command-template.ts`，确保 agent 不会跳过 CreateMission
  - 4 维自审清单（completeness/correctness/integration/robustness）注入续推 prompt 和 system prompt
  - mission-verify 子代理注册 + 4 维 JSON 报告解析（`verdict=passed` → `markComplete`）
  - 持久化走 V1 HeyApi client 的 `Session.metadata.missionPro`
  - **项目从原工作空间迁出独立**（2026-06-10 主人确认），现为独立 git 仓（`opencode-mission/`）
  - `.gitignore` 精简（删除 `test-mission-run/` `hello*.txt`，与已删 `smoke-mission/` 对齐；2026-06-10）
- In progress:
  - **项目根 `git init` + 首 commit**（26 个文件裸盘状态，迁移后尚无任何版本化）
  - 把 handoff 流程接入项目（已建 `repo/progress/handoffs/` 目录，1 份 handoff 落地）
- Not started:
  - v2 计划项（多 mission 并行、预算池、verify 可视化、`/mission history`、结构化 emit）
  - 在 TUI 交互模式下验证 `EventSessionIdle` 触发（headless `opencode run` 下未观察到）

## Key Files

- `src/mission-store.ts:1-346` — 状态机 + 预算 + 持久化的唯一 mutation 入口；`assertTransition` 定义了所有合法跃迁，改这里必须同步更新 `DESIGN.md §2`
- `src/index.ts:29-107` — 插件入口；4 tool + 6 hook 的 wire 中心；提取 V1 client 后再创建 store
- `src/command-template.ts:1-163` — `/mission` 模板 + ABSOLUTE RULE（必须保留，移除它 agent 会跳过 CreateMission）
- `src/hooks/event-hook.ts:1-211` — 续推（`EventSessionIdle`）+ `EventSessionError` 派发（userAborted → paused；runtimeErrored → blocked）
- `src/utils/session-http.ts:1-84` — V1 HeyApi client 包装；唯一访问 `Session.metadata.missionPro` 的路径
- `AGENTS.md:1-196` — 维护者导读（设计亮点 + 验证清单 + 已知限制 + 后续）
- `DESIGN.md:1-277` — 完整设计文档（state machine 表、persistence、verify 协议等）

## Decisions Already Made

- Decision: 状态机 4 态 `active/paused/blocked/complete`，跃迁由 `mission-store.ts:assertTransition` 集中校验
  - Reason: 把"什么合法"集中在一处，避免散在 hook 里导致非法跃迁
- Decision: 持久化用 V1 HeyApi client（runtime 注入的 `input.client._client`），不直接走 fetch
  - Reason: V1 包装自带 baseUrl/auth/headers/fetch，绕开裸 fetch 的认证问题；reusing 注入的 client 与 opencode 其它工具保持 cookie/auth 一致
- Decision: 存储键固定 `Session.metadata.missionPro`（带 Pro 后缀）
  - Reason: 与其它 mission 插件命名空间共存
- Decision: SetMissionBudget 一次只接受一个 `{value, unit}`，单位是封闭 enum
  - Reason: 避免 LLM 发模糊 wallclock 量；要 3 维就调 3 次
- Decision: 续推主触发器 = `EventSessionIdle`（opencode 1.4.8+ 专用事件），辅以 `EventMessageUpdated` 累计 token
  - Reason: idle 是"agent 当前 turn 结束"的稳定信号；token 累计需要 message 事件补足
- Decision: ABSOLUTE RULE 放在 `command-template.ts` 开头，强制 CreateMission 是首个工具调用
  - Reason: 实测在 headless `opencode run` 里，agent 倾向先 `GetMission` 探查或先 `todowrite` 计划，绕过 mission 工具 → 整个插件静默失效
- Decision: bash 协议限制（`;` 链式被 opencode 视作一个权限单元、`Start-Process` 必须 `-NoNewWindow -PassThru`）
  - Reason: 这两类失败模式在当前环境下会让 turn 卡死
- Decision: 验证靠独立子代理 `mission-verify`（只读 GetMission/UpdateMission），JSON 报告靠 `experimental.text.complete` 拦截
  - Reason: 把"自审"和"客观核验"解耦，避免主代理自评偏差

## Verification

- Commands run（本会话内）:
  - `Test-Path smoke-mission`（在项目根） → False（创建前）→ passed
  - `bun --version` → `1.3.14` → passed
  - `New-Item -ItemType Directory ... src, tests` → passed
  - `Write` 三文件（`package.json` / `src/add.ts` / `tests/add.test.ts`） → passed
  - `bun test`（在 smoke-mission 目录） → `2 pass / 0 fail, 2 expect() calls, Ran 2 tests across 1 file. [25.00ms]` → **passed**（但该目录现已消失，详见 Risks）
  - `task` 调用 mission-verify 子代理 → 返回 `verdict=passed`, 4 维全 5/5, issues 空数组 → passed
  - `GetMission` 在任务完结后 → `No active mission` → passed（证明 markComplete 已生效）
  - `bun --version` / `git ls-files --others --exclude-standard` / `git check-ignore -v` / `git ls-files --others --directory` / `git log --oneline -10` / `Test-Path smoke-mission`（写 handoff 时复核） → passed
- Tests:
  - `bun test` 在 smoke-mission 目录 → passed（事后已不可复现）
  - `bun run build` → **未在本会话运行**（仅 `dist/index.js` 存在这一事实证据）
  - `bun x tsc --noEmit` → **未在本会话运行**（AGENTS.md 把它列为验证清单第一项）
- Manual checks:
  - 读取 `package.json`/`tsconfig.json`/`src/index.ts`/`.gitignore` 内容核对 → passed
  - `Get-ChildItem` 列项目根目录 → 确认 `smoke-mission/` 不存在 → recorded

## Risks And Blockers

- Resolved 1 — **`smoke-mission/` 冒烟任务目录已由主人主动删除**
  - Status: 不是异常，是有意的清理。主人原话："smoke mission 因为是测试 我删了"
  - 影响: 本会话早段的 `bun test 2 pass / 0 fail` 与 `verdict=passed` 仍为真，**文件系统层面的可重放性不是必要条件**（mission 状态已 complete，verifier 也只读 GetMission）
  - 后续: 未来想再端到端验证时，重跑 `/mission 在 ... 创建冒烟包` 即可；不需要保留历史冒烟包目录
- Blocker 2 — **项目根未 `git init`，26 个文件处于裸盘状态**
  - What is needed: 在项目根跑一次 `git init && git add . && git commit -m "feat: initial opencode-mission plugin"`，把项目从"独立但无版本"变成"可回滚版本"。任何代码调整在没有 init 的状态下风险敞口都是 100%。`.gitignore` 已正确排除 `dist/`，`git add .` 不会把构建产物带进库
  - Mitigation: 部署前必做项；今天可做可不做
- Risk — **`EventSessionIdle` 在 headless `opencode run` 下未观察到**
  - Impact: 续推机制结构正确但端到端只在 TUI 模式验过
  - Mitigation: 真实使用前在 TUI 交互模式跑一次（按 Esc 观察 paused 跃迁）
- Risk — **V1 HeyApi SDK 未声明 `SessionUpdateData.body.metadata`**
  - Impact: 依赖 V1 client 包装层"放行"额外字段；若 opencode SDK 收紧类型会断
  - Mitigation: 写一个最小 `bun run smoke-v1-patch` 脚本验证 metadata 写回；AGENTS.md 已记录此限制
- Risk — **verify 报告 JSON 解析依赖子代理输出严格 `\`\`\`json {verdict, scores} \`\`\`` 块**
  - Impact: 子代理措辞一变解析就会碎
  - Mitigation: 已列入 v2+ 计划（用结构化 tool emit 替代自由文本）

## Open Questions

- Question: ~~smoke-mission 目录消失是 opencode 会话切换自动清理的产物，还是 `dist/` 构建把 .gitignore 忽略范围扩大导致的？~~
  - Resolved: 主人主动删除（"smoke mission 因为是测试 我删了"），无需进一步处理
  - 衍生意向: 若主人想让 `smoke-mission/` 这类冒烟产物自动归位，建议在 `.gitignore` 加 `smoke-mission/` 行（2026-06-10 已删 `test-mission-run/` `hello*.txt`，但未加 `smoke-mission/` 行，因为是单次测试且目录已删）。**等主人明确要求再加**，不主动改
- Question: 项目是否要走 "opencode plugin marketplace" 发布流程（package 名字 `opencode-mission` 已合法）？
  - Current best guess: 是，AGENTS.md 把它当作 shippable 插件对待（`version 0.1.0`、`main`/`exports` 都指向 `dist/index.js`），但发布动作 owner 还没触发
  - 衍生：项目独立后，是否需要 push 到一个 remote（GitHub / 自建）？当前没有配置任何 remote，`git init` 后只是个本地仓
- Question: AGENTS.md 提到的"预热全局选项"是什么？为什么会 block 端到端测试？
  - Current best guess: 推测是 TESTING.md 详述的 opencode `permission` 全局预热（避免首次 `bash` 触发的 `ask` 对话），主人未来需要时回看 TESTING.md

## Resume Order

1. 读 `AGENTS.md` 了解项目定位、设计亮点、已知限制
2. 跑 `git status` 在 ``（**项目自身就是 git 根**，无父仓关联），确认 `fatal: not a git repository` — 印证需要 init
3. 跑 `bun run build` 在 ``，验证 `dist/index.js` 重新生成
4. 跑 `bun x tsc --noEmit` 在同目录，验证 typecheck
5. 决定下一步：
   - 路径 A：先 `git init` + 首 commit 把项目版本化（**推荐**，见 Next Action）
   - 路径 B：跑一个端到端 `/mission` 任务重做 smoke 测试（验证 `EventSessionIdle` + 验证子代理）

## Next Action

- **下一会话第一件事**：在 `` 执行 `git init && git add . && git commit -m "feat: initial opencode-mission plugin"` 把 26 个文件版本化为独立 git 仓；`dist/index.js` 已被 `.gitignore` 排除，不需要额外处理

## Notes For The Next Session

- Facts that are verified:
  - 18 个 `.ts` 源文件 + 6 个根 markdown + 2 个配置文件 + 1 个 `.gitignore` 全部存在，行数与早段 `scripts/git_changes.py` 报告 + 2026-06-10 `Get-ChildItem -Recurse` 双源核对一致
  - `package.json` `name=opencode-mission` / `version=0.1.0` / `type=module` / `main=./dist/index.js`
  - `tsconfig.json` `include=src/**/*`、`noEmit=true`
  - `dist/index.js` 存在且 56,155 B
  - `bun 1.3.14` 可用
  - 项目根无 `.git`，与原工作空间无版本化关系（已迁出独立）
  - `.gitignore` 当前 11 行（2026-06-10 修订后）
- Assumptions that still need checking:
  - `dist/index.js` 是当前 src 的最新构建（无时间戳对比）
  - `src/index.ts:79-98` 的 config hook 注入 `/mission` 命令和 `mission-verify` 子代理就是当前期望行为（基于 AGENTS.md 一致性推断，未跑过集成测试）
  - `scripts/git_changes.py` 输出里的中文字符 `��` 是 stdout 编码问题，文件本身 UTF-8 完整（**该脚本在项目无 git 后已不直接适用**，仅作历史参考）
- Things to avoid repeating:
  - 不要去原工作空间找本项目 —— 已迁出独立
  - 不要去恢复 `smoke-mission/` —— 它是会话临时产物，按需重做即可
  - 不要在没有先 `bun run build` 的情况下做 plugin 集成测试，否则 `dist/index.js` 是过期的
  - 不要把 `mission-store.ts:assertTransition` 的跃迁表单独修改 —— 必须同步 `DESIGN.md §2`
  - 不要在没有先 `git init` 的情况下跑 `git status` / `git add` —— 会 `fatal: not a git repository`
