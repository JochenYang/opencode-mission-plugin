# Testing Guide

> 主人晚上回来用这个文件照着测。

## 0. 关键概念：预算完全可选

`SetMissionBudget` 的 3 个维度（`turns` / `tokens` / `time`）**完全可选**。不设预算也能跑——plugin 只会用 100 turn 软上限防止死循环。

**什么时候设预算**：
- ✅ 长任务（>5 turn 或预计 >5 分钟）— 建议设，防止失控
- ✅ 用第三方 API（花钱/有 quota）的任务
- ❌ 短任务（<5 turn）— 别设，少打字

**3 个维度独立设**，一个都不设也行：

```
/mission budget set turns=20        # 最多 20 轮续跑（可选）
/mission budget set tokens=500000   # 最多 500k tokens（可选）
/mission budget set time=30m        # 最多 30 分钟墙钟（可选）
```

## 1. 确认插件安装

```powershell
Test-Path "C:\Users\Administrator\.config\opencode\plugins\opencode-mission.js"
# 应返回 True
```

打开 `~/.config/opencode/opencode.json`，确认 `plugin` 数组里有：
```json
"plugin": [
  "./plugins/opencode-mission.js"
]
```

## 2. 启动 opencode TUI

```powershell
opencode
```

## 3. 测试 1: Smoke mission（短任务，验证基本流程）

在 TUI 里输入（**没设任何预算**）：

```
/mission 在 `demo-smoke/` 目录创建一个简单的 Node.js 包：1) package.json 含 name='demo-smoke', type='module', scripts.test='bun test'；2) src/add.js 导出函数 add(a,b)=a+b；3) src/add.test.js 用 bun:test 写 2 个测试覆盖 add；4) bun test 全部通过。完成标准：2 pass / 0 fail；add(2,3)=5
```

**观察项**：

- [ ] agent **第一个**工具调用是 `CreateMission`（不是 GetMission / todowrite）
- [ ] 写代码 + 跑 `bun test` 通过
- [ ] agent **显式调 task 工具启动 mission-verify 子智能体**
- [ ] 子智能体输出 4 维 JSON 评分 + verdict
- [ ] `GetMission` 返回 "No active mission"（mission 已归档）
- [ ] agent 给一个简短的交付报告（已验证/未验证/下一步）

## 4. 测试 2: 续跑 + budget 边界（中等任务，**带预算**）

> 这一节是测试**设了预算后**的行为。如果主人不设预算，下面的 "budget 耗尽" 观察项不适用。

```
/mission 在 `demo-long/` 目录创建一个 Node.js API：1) Express + TypeScript；2) /api/users 返回 mock 用户列表；3) /api/users/:id 返回单个用户；4) 4+ 个测试用 vitest 全通过；5) tsc --noEmit 无错误。完成标准：vitest 全 pass；tsc 无错误；curl http://localhost:3001/api/users 返回 200
```

然后在 TUI 里输入 `/mission budget set turns=8`（单独设一个维度）。

**观察项**：

- [ ] agent 第一个工具调用还是 `CreateMission`
- [ ] 创建文件时**不被权限弹窗卡住**（bash 协议起作用）
- [ ] budget 接近上限时 agent 收到 "Budget tight" 提示
- [ ] 如果 budget 耗尽，mission 自动转 `budget_limited`（agent 调 `UpdateMission status="blocked"` 走 wrap-up 指令）
- [ ] mission 跑完后 `GetMission` 返回 "No active mission"

## 5. 测试 3: 中断（按 Esc）

启动 mission 后，**在 agent 跑的时候按 Esc**。观察：

- [ ] goal 状态变成 `paused`
- [ ] agent 当前 turn 结束
- [ ] `GetMission` 显示 `Status: PAUSED` + `terminalReason: "User pressed Esc"`

## 6. 测试 4: 长任务（验证续跑真的工作）

> 这一节测试**多个 turn 之间续跑**——所以设一个较宽的 budget（不设也行，plugin 有 100 turn 软上限）。

```
/mission 在 `demo-verylong/` 用 React + Vite + TypeScript 创建一个 TODO 应用：10+ 个组件、5+ 个 page、localStorage 持久化、10+ 个 vitest 测试全通过、tsc 无错误。完成标准：vitest 全 pass；tsc 无错误；应用可以 build
```

**观察项**：

- [ ] mission 跨多个 turn 续跑（continuationCount > 1）
- [ ] 每 turn 续跑 prompt 里看到 `<progress>` 块带 turn / token / wallclock 进度
- [ ] system prompt 注入里有 "Self-audit before declaring done"
- [ ] agent 主动 `mkdir -p` 创建子目录
- [ ] 测试 / build / tsc 都跑通

## 7. 已知应该发生的现象

- ✅ `Remove-Item` / `rm` 等删除命令**仍然弹窗**（主人明确要求保留）
- ✅ `npm install` / `bun test` / `tsc` 等普通命令**不弹窗**（`*`: allow）
- ✅ `Start-Process -NoNewWindow -PassThru` 不卡
- ❌ `;` 串多条命令**整条弹窗**（拆 step）

## 8. 已知不该期望的现象

- ❌ **headless `opencode run` 模式下续跑不触发** — plugin event hook 收不到 `session.idle`（opencode 设计限制）。只在 TUI 实测能验证续跑
- ❌ **没有 UI 进度面板** — 状态变化只在 `GetMission` 输出里可见
- ⚠️ **sub-agent 路由在 1.17.x 可能失败** — `getSession` 用 `globalThis.fetch` 调 `/api/session/{id}`，plugin 进程可能被沙箱隔离。这种情况下 mission-verify 子智能体拿不到 parent 上下文（fail-open 兜底仍能让 mission 完成）

## 9. 调试开关

```powershell
$env:OPENCODE_MISSION_DEBUG = "1"
opencode
# plugin 会把详细日志写到 stderr（包括续跑决策、token 累加、中断追踪）
```

## 10. 报告问题

如果出问题，主人贴回：

1. **截图**（TUI 或 log）
2. **mission 状态**（`/mission status` 输出）
3. **agent 第一个工具调用**（应该在 log 里）
4. **最终 `GetMission` 返回**

阿亚酱据此定位是 plugin bug / opencode 限制 / agent 行为问题。