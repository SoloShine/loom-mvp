# 通知 onClick 交互化 — P2.2

## Goal

系统通知从"仅展示"变为可交互：点击通知按 invoke 语义分发该 App 清单声明的命令并唤起面板。
解决 roadmap 记录的缺口——「闲置回收、连连看求解完成等通知点不出任何东西」。
来源：`docs/post-mvp-plan.md` P2.2（用户已批准的 roadmap）。

## 确认事实（代码证据）

- 现状：`notificationApi.show`（core.ts:152-157）只吃 title/body，`new Notification(...).show()`
  无 click 处理；dispatcher:165-167 只透传 title/body（body 兜底为 ctx.appId）。
- SDK `host.notification.show`（sdk/src/index.ts:252-254）签名 `{ title, body? }`。
- 四个 App 已在用通知：clipboard-tool、hello(selftest)、file-organizer(移动去向)、
  lianliankan(main.ts:580 求解完成通知)——全部无点击行为。
- **验收载体（用户定调不用连连看）**：连连看的求解依赖真实游戏画面，环境随机、输出不稳定。
  file-organizer 的「移动去向」通知（main.ts:89，`moved > 0` 必现）是确定性流程——
  App 启动时从 storage 恢复 lastDir（main.ts:108-110），停机预置 storage 即可全 CLI 驱动；
  且它 ui type window（720×560 面板），点击「已移动 N 个文件」→ 面板展示报告，
  是 UX 配对最自然的组合。
- 循环依赖约束：core.ts 不能 import manager（manager → dispatcher → core 成环）；
  既有解法是回调注入（`setWindowActivityHook` 先例，spec 有案）。
- 通知生命周期 > App 运行周期：通知留在通知中心，App 可能已被 stop/重启——
  点击处理必须无状态（命令 id + 清单声明），不能依赖 App 侧订阅存活
  （这也是不做成 SDK 事件回调式 onClick 的理由，见 design 取舍表）。
- invoke 语义（PRD pinned）：可自动启动已停止的 App、计入活跃、进 history invoke 事件。

## Requirements

- **R1 SDK**：`host.notification.show` 增加可选 `clickCommand?: string`
  （JSDoc 说明语义：点击时分发清单声明命令并唤起面板；未声明点击无副作用）。
- **R2 dispatcher**：透传 `clickCommand`（字符串、≤80 字符，与 invoke 的 command 校验同口径）
  与该 App 清单声明的命令 id 列表（dispatcher 经 registry 取）。
- **R3 core.ts**：`notificationApi.show` 校验 clickCommand 必须在声明列表内
  （不在 → 抛中文错误回 SDK，开发者当场发现拼写错）；合法时挂 Electron `click` 事件 →
  经注入的分发回调执行（回调由 manager 启动时注入 `setNotificationClickDispatcher`，
  破 manager↔core 环，沿用 setWindowActivityHook 模式）。
- **R4 manager**：注入的分发回调 = `invoke(appId, clickCommand)`（invoke 全语义：
  自动启动、活跃、history、日志）+ `windows.focusApp(appId)`（面板唤起，
  对已隐藏面板的运行中 App 生效）；invoke 失败仅 warn 不阻断 focus。
- **R5 file-organizer 接线（验收载体，用户定调不用连连看——其环境随机、输出不稳定）**：
  清单加 `show` 命令（title Show panel）+ invoke case 调 `host.window.focusSelf()`；
  「移动去向」通知（main.ts:89，`moved > 0` 必现）加 `clickCommand: "show"`。
  点击「已移动 N 个文件」→ 面板展示报告，UX 配对最自然。
- **R6 测试**：纯校验函数（clickCommand ∈ 声明列表）进契约测试
  （electron-free 模块，esbuild→cjs 模式）。
- **R7 文档**：roadmap P2.2 实施记录；spec 平台服务层 notification 行与 SDK api-surface 同步。

## Acceptance Criteria

- [ ] 契约测试：clickCommand 合法/未声明/非字符串三分支。
- [ ] 真机（确定性流程）：预置 `data/storage/file-organizer.json` 的 lastDir 指向
      已知临时目录（含若干 .txt 等）→ run → `mini invoke preview` → `execute` →
      「已移动 N 个文件」通知必现 → 点击通知 → invoke `show` 执行（history 有 invoke 事件、
      活跃计时刷新）+ 面板唤起（focusApp/focusSelf 双保险）。
- [ ] 真机对照：clipboard-tool 清剪贴板通知（未声明 clickCommand）→ 点击无任何副作用。
- [ ] `show` 时传未声明命令 → SDK promise 拒绝，错误中文可读。
- [ ] `npm test` 全绿（44 + 新增）；既有四 App 通知行为不变（不传 clickCommand 的调用零差异）。

## Out of Scope

- SDK 事件订阅式 onClick 回调（通知生命周期长于 App 运行周期，无状态命令分发更稳；
  见 design 取舍表）。
- 闲置回收通知（host 自发，无 App 上下文）的点击行为——维持纯展示。
- 通知按钮/多动作（Electron Windows 侧 toast 按钮支持有限，roadmap 未要求）。
- 连连看的通知接线（用户定调不作为验收载体；其求解完成通知维持纯展示，
  后续要接的话按 file-organizer 同款模式一行接入）。

## Open Questions

（无——机制由 roadmap P2.2 原文 + invoke 既有语义确定；回调式 vs 命令分发的取舍见 design。）
