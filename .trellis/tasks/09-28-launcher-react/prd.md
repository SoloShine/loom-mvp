# Launcher React 化（P1.1）

## Goal

产品的门面（Ctrl+Shift+M 命令面板）从原生页迁移到与管理中心相同的 React 技术栈，
消除两者的视觉断裂；复用已验证的 Vite IIFE+CSP 管线，**零新架构**。
价值：统一的 Linear 风格视觉与明暗主题能力，Launcher 后续迭代进入与管理中心
相同的组件/规范轨道（来源：`docs/post-mvp-plan.md` P1.1，用户已批准的 roadmap）。

## 确认事实（代码证据）

- 现状原生页：`host/src/launcher/index.html`（33 行）+ `host/src/launcher/ui.ts`（164 行）。
  功能面 = 模糊搜索（子串命中优先于子序列，`score()`）+ App/命令扁平项（top 30 截断）+
  ↑↓/Enter/Esc 键盘操作 + 错误条（`role="alert"`）+ 管理中心按钮 + 失焦自动隐藏 +
  窗口 focus 回焦点到输入框。原生页为固定深色（无主题能力）。
- 通道：preload `host/src/preload/launcher.ts` 暴露 `window.__launcher`
  （getApps / startApp / invokeCommand / hide / openManagement + onError / onRefresh 事件）；
  主进程 `host/src/main/launcher.ts` 全部 handler 带 `launcherSender` 校验（isTrustedPage）。
  **本任务不动任何通道与主进程行为。**
- `getApps` 已过滤 broken/disabled（`launcher.ts:150-152`）——原生页里的
  unavailable 分支是历史死代码，React 版不迁移。
- `startOrFocus` 语义：运行中→`focusApp`；窗口丢失且有 UI→按 manifest 重建；未运行→start。
  命令项在 App 未运行时可执行（"将自动启动"提示）。
- 面板窗口：520×400 无边框、skipTaskbar、不可调整、主屏 workArea 顶部 25% 居中、
  blur 即 hide、partition `persist:mini-control-launcher`。
- 构建管线（管理中心侧已验证）：`ui/` 独立 Vite 工程，`vite.config.ts` IIFE +
  `cssCodeSplit: false`；`scripts/build.mjs` spawn vite → 拷到 `host/dist/management/` →
  HTML 归一化（module→defer、去 crossorigin、注 CSP meta，含逐项断言）；
  `ui/node_modules` 缺失自动回退原生 esbuild 产物。
- 主题：`ui/src/lib/theme.ts` = localStorage `mini-theme` + `prefers-color-scheme` 兜底 +
  `watchSystemTheme`；`initTheme()` 必须先于 React render（空 #root 防闪屏）。
  **management 分区是 `persist:mini-control-management`**，与 launcher 分区的
  localStorage 互不可见——主题选择跨窗口不同步。

## Requirements

- **R1 构建管线**：`ui/` 内新增 launcher 入口；`build.mjs` 双入口分别产出拷贝
  （management、launcher 各自目录）；IIFE + `cssCodeSplit: false` + CSP 归一化全部沿用；
  无 `ui/node_modules` 时 launcher 同样回退现有原生页。
- **R2 交互（Raycast 式，roadmap P1.1 原文）**：置顶搜索框常驻焦点（窗口 focus 回焦点）；
  ↑↓ 选择 + Enter 启动/执行；Esc 隐藏（hideApp 语义，不销毁）；
  无查询时按收藏/最近使用分组展示；搜索时相关度优先（沿用现有打分语义）；
  执行成功后隐藏面板。
- **R3 数据与语义对等**：getApps/startApp/invokeCommand 行为与现状完全一致；
  禁用/损坏项不出现（主进程已过滤，渲染层不写死代码分支）；top 30 截断沿用。
- **R4 主题**：复用 `theme.ts`；明暗两态均可用；launcher 分区内持久化选择、
  未选择时跟随系统；跨窗口主题同步不在本任务范围。
- **R5 演示模式**：`ui/src/mocks.ts` 补 Launcher 假数据；纯浏览器打开 launcher 入口
  可看全功能（无 `__launcher` 桥时落演示数据）。
- **R6 视觉**：沿用管理中心组件与设计 token（13px 基准、语义色、低对比描边、lucide 图标）；
  保持面板形态 = 无边框紧凑卡片 + 底部快捷键提示行。

## Acceptance Criteria

- [ ] `npm run build` 产出 `host/dist/management/` 与 `host/dist/launcher/` 两套 React 版；
  两个 index.html 均通过 build.mjs 归一化断言（非 module script、含 CSP meta）。
- [ ] 回退路径：临时移走 `ui/node_modules` 再 build，两页回退原生版；
  `npm test` 的 host-contract CSP 契约断言保持绿。
- [ ] 功能对等：fuzzy 命中与排序（子串优先、收藏/最近加权）、↑↓/Enter/Esc、
  命令项"将自动启动"提示、错误条展示（onError 链路）。
- [ ] 明暗两主题目检通过（注意 IAB `prefers-color-scheme` 初始为深色，先确认当前态）。
- [ ] 真机：Ctrl+Shift+M 唤起体感 <300ms（面板窗口预建 + show，React 包体不进打开路径）、
  失焦隐藏、托盘/热键唤回正常、与管理中心视觉一致。
- [ ] `npm test` 全绿（29 项基线）。

## Out of Scope

- P1.2 devUrl 热更新、P1.3 `mini create` 模板（roadmap 独立条目）。
- 跨窗口主题同步（管理中心与 launcher 主题选择独立；后续如需可统一到 host settings）。
- 通道/主进程行为变更（preload 五条消息、startOrFocus、托盘菜单、全局热键全不动）。
- 托盘菜单 React 化（托盘是原生 Menu，不在页面迁移范围）。

## Open Questions

（无——交互、回退、验收均由 `docs/post-mvp-plan.md` P1.1 原文确定；
技术选型与取舍见 `design.md`。）
