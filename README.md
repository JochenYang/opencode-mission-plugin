# opencode-mission

一个 OpenCode 插件，给主会话加"自主目标模式"：主人定一个目标，agent 跨多个 turn 自主工作直到目标完成、暂停或阻塞。

## 核心特性

| 特性                | 说明                                                                |
| ------------------- | ------------------------------------------------------------------- |
| **5 态状态机**       | `active / paused / blocked / budget_limited / complete`，区分用户主动 / 系统限制 / 自主阻塞 |
| **3 维度预算**       | `turn / token / wallclock`，可独立设上限；超限自动转 `budget_limited` 而非 `blocked` |
| **3-turn block 阈值** | agent 自主声明 blocked 需连续 3 次同因（防误判）                            |
| **judge react cap**  | 验证连续 5 次失败自动 budget_limited（防 verify 死循环）                       |
| **4 个独立工具**     | `CreateMission` / `UpdateMission` / `GetMission` / `SetMissionBudget` |
| **独立 verify 子智能体** | 4 维评分（completeness/correctness/integration/robustness） → 自动 mark complete |
| **状态自适应 system prompt** | `<mission_status>` 块 + 动态命令列表 + 3-turn 提醒 + wrap-up 指令          |
| **自我批判**         | 每 turn 续跑 prompt + system 都强制 4 维自检                              |
| **中断语义**         | 用户 Esc → `paused`（冻结 wallclock）/ runtime error → `blocked`           |
| **自管 JSON 存储**   | `~/.config/opencode/missions/<workspace>/<sessionID>.json`，跨端（Windows / macOS / Linux），跨项目隔离 |

## 安装

### 推荐：npm 全局安装（自动配置）

```bash
npm install -g opencode-mission
# 或 bun add -g opencode-mission
```

`postinstall` 会自动：

1. 把 `dist/index.js` 拷到 `~/.config/opencode/plugins/opencode-mission.js`
2. 在 `~/.config/opencode/opencode.json` 的 `plugin` 数组里追加 `./plugins/opencode-mission.js`（已存在则跳过）
3. 卸载时（`npm uninstall -g opencode-mission`）自动从 `opencode.json` 移除条目

> Windows：`%APPDATA%\opencode\`；macOS / Linux：`~/.config/opencode/`。

### 手动安装（开发或自定义构建）

在 `~/.config/opencode/opencode.json` 中追加：

```json
{
  "plugin": [
    "./plugins/opencode-mission.js"
  ]
}
```

项目级安装：把文件放到 `./.opencode/plugins/` 或项目根的 `opencode.json`。

构建单文件 bundle 后安装：

```bash
bun run build
cp dist/index.js ~/.config/opencode/plugins/opencode-mission.js
```

## 使用

### 启动一个 mission

```
/mission 实现一个工具函数：在 D:\myproject\src\math.ts 里加 add/subtract/mul/div，单元测试全过。完成标准：bun test 4 pass / 0 fail
```

Agent 收到命令后会**强制**：
1. 第一个工具调用必须是 `CreateMission`（**不要先探查**）
2. 写代码 + 跑测试
3. 调 mission-verify 子智能体独立审计
4. audit 通过后自动 mark complete

### 状态

```
/mission status
```

### 生命周期

```
/mission pause     # 暂停（冻结 wallclock）
/mission resume    # 恢复
/mission cancel    # 取消（清除记录）
```

### 预算（**完全可选**，不设也能跑）

`SetMissionBudget` 每次只设一个维度（避免 LLM 搞错单位）。**不设预算也能工作**——plugin 只会用一个软上限（100 续跑 turn）防止死循环。**建议**为长任务设预算，但**短任务完全不用管**：

```
/mission budget set turns=20        # 限制最多 20 轮续跑
/mission budget set tokens=500000   # 限制最多 500k tokens
/mission budget set time=30m        # 限制最多 30 分钟墙钟
/mission budget show                # 查看当前预算
```

支持单位：`turns`、`tokens`、`milliseconds`、`seconds`、`minutes`、`hours`（wall-clock 范围 1s-24h）。

## 工具一览

| 工具                | 主会话 | 子智能体 | 用途                                                       |
| ------------------- | ------ | -------- | ---------------------------------------------------------- |
| `CreateMission`     | ✅     | ❌        | 创建 mission（必填 `objective` + `completionCriterion`）  |
| `UpdateMission`     | ✅     | ❌        | 状态转移：`active / paused / blocked / cancelled`            |
| `GetMission`        | ✅     | ✅（读父）| 读取当前 mission 状态                                       |
| `SetMissionBudget`  | ✅     | ❌        | 调整预算上限（一次一个维度）                                |

## 验证机制

主会话**不**自己声明 mission 完成。完成路径：

1. 主会话起 `mission-verify` 子智能体（via Task 工具）
2. 子智能体读 `GetMission` → 检查代码 → 跑测试 → 输出 4 维 JSON 评分
3. plugin 的 `experimental.text.complete` 钩子自动解析 JSON：
   - `verdict="passed"`（4 维全 ≥ 3 + completeness ≥ 3）→ 自动 mark complete
   - `verdict="failed"` → 报告附回 mission，主会话继续工作

## 自我批判（self-audit）

每 turn 续跑 prompt + active system prompt 都强制 4 维自检：

1. **Completeness** — 完成标准每一条都有当前证据
2. **Correctness** — 代码实际跑过、不是"我打算这么写"
3. **Integration** — 与现有代码风格一致
4. **Robustness** — 边界用例已处理

**禁止**以"计划/摘要/初版"作为完成结果。

## bash 协议（必读）

agent 在 PowerShell-on-Windows shell 里跑，**避免这些**：

- ❌ **不要用 `;` 串多条命令** — opencode shell AST 把整条当一个节点，**任何子命令匹配黑名单（如 `Remove-Item *`）都会让整条弹窗**。**每个 step 单独一个 `bash` 调用**。
- ❌ **不要 `Start-Process` 不带 `-NoNewWindow -PassThru`** — 会卡在 PS 交互模式
- ✅ 后台启 dev server 用：
  ```powershell
  $log = "C:\Users\ADMINI~1\AppData\Local\Temp\opencode\dev.log"
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c","npm run start" `
      -RedirectStandardOutput $log -RedirectStandardError "$log.err" `
      -NoNewWindow -PassThru | Select-Object Id
  Start-Sleep -Seconds 3
  ```
- ✅ Probe 端点用 `Invoke-RestMethod` 或 `curl`
- ✅ 退出前清理：
  ```powershell
  Get-Process node -ErrorAction SilentlyContinue | `
      Where-Object { $_.StartTime -gt (Get-Date).AddMinutes(-2) } | `
      Stop-Process -Force -ErrorAction SilentlyContinue
  ```

## 测试（主人晚上回来用）

启动 opencode TUI：

```bash
opencode
```

在 TUI 里输入：

```
/mission 在 `./test-mission/` 目录创建一个简单的 Node.js 包 (type:module)：1) package.json 含 name='test-mission', version='1.0.0', type='module', scripts.test='bun test'；2) src/index.js 导出函数 add(a,b)=a+b；3) src/index.test.js 用 bun:test 写 2+ 个测试覆盖 add；4) bun test 全部通过。完成标准：bun test 输出 2+ passed 0 failed；add(2,3)=5。预算 turns=10 tokens=100000 time=5m
```

**观察**：
- agent 第一个工具调用应是 `CreateMission`
- mission-verify 子智能体会被调度
- mission 完成后 `GetMission` 返回 "No active mission"

## 已知限制

- **续跑 + 中断追踪依赖 `EventSessionIdle`**：交互 TUI 实测可用；`opencode run`（headless）模式不发送此事件
- **verify JSON 解析** 依赖子智能体严格输出 `\`\`\`json { verdict, scores } \`\`\`` 块；解析失败走 fail-open 兜底（标 `judgeFailed: true` 强制 mark complete，避免用户被困）
- **Sub-agent 路由** 调 `getSession` 走 `globalThis.fetch`，opencode 1.17.x 跨进程网络隔离可能阻；当前 fallback 返回 `null`（主流程无影响）

## 开发

```bash
bun install
bun run typecheck      # tsc --noEmit
bun run build          # bun build -> dist/index.js
```

## 许可

MIT