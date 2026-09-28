# 技术设计 — Launcher React 化

## 构建拓扑（核心决策）

**两遍 Vite 构建**，不做单工程多 HTML 入口。原因：Rollup 的 `iife` 输出格式
不支持多入口（"Multiple inputs are not supported for output formats iife/umd"），
而 IIFE + `cssCodeSplit: false` 是 file:// + CSP 的硬约束
（`.trellis/spec/mini-host/frontend/quality-guidelines.md`），不可为省一遍构建去破。

```
scripts/build.mjs
├─ pass 1: vite build（ui/vite.config.ts，现状不动）        → ui/dist        → 拷 host/dist/management
├─ pass 2: vite build -c vite.config.launcher.ts（新增）     → ui/dist-launcher → 拷 host/dist/launcher
├─ normalizeHtml()：抽公共函数，两页 index.html 各自归一化 + 断言
└─ 无 ui/node_modules：两遍都不跑，两页走既有原生 esbuild 产物（现有 for 循环已覆盖 launcher，不动）
```

`ui/vite.config.launcher.ts`：与主配置同约束（base:"./"、modulePreload 关、
`cssCodeSplit: false`、iife + inlineDynamicImports），差异仅
`rollupOptions.input: { launcher: "launcher.html" }` 与 `outDir: "dist-launcher"`。

## 文件布局

```
ui/
├── launcher.html                    # 新入口（空 #root + module script 指向 /src/launcher/main.tsx）
├── vite.config.launcher.ts          # 第二遍构建配置
└── src/
    ├── launcher/
    │   ├── main.tsx                 # initTheme() 先于 render（防闪屏序列照搬 management）
    │   ├── LauncherApp.tsx          # 面板 UI：搜索框 + 分组列表 + 错误条 + hint
    │   └── bridge.ts                # window.__launcher ?? launcher mock（demoMode 同构 lib/bridge.ts）
    ├── lib/fuzzy.ts                 # score() 从 host/src/launcher/ui.ts 平移（纯函数）
    ├── types.ts                     # + LauncherAppInfo / LauncherBridge 契约类型
    └── mocks.ts                     # + launcherApps 假数据
```

- `lib/fuzzy.ts`、`lib/theme.ts`、`components/ui/*` 复用或纯新增，**不改管理中心页面**。
- 打分函数为何平移而非共享：`ui/` 与 `host/` 是独立工程（无跨包 import 通道），
  原生页冻结为回退产物、不再演进，React 版持有新实现；两份 `score()` 的对齐由
  验收用例（同查询同排序）保证。
- `ui/node_modules` 缺失时：`viteBin` 探测已存在，launcher 同受其门控
  （build.mjs 现有 `reactManagement` 布尔扩义为 "react 可用"，原生回退路径零改动）。

## 数据流与契约

- `bridge.ts`（launcher 版）：`window.__launcher` 存在则真桥，否则演示 mock + `demoMode`。
  类型 `LauncherBridge` 与 preload `host/src/preload/launcher.ts` 的暴露面一字对齐
  （getApps / startApp / invokeCommand / hide / openManagement / onError / onRefresh）。
- `LauncherApp` 状态全部本地：`items`（refresh 拉取）、`query`、`active` 索引；
  `filtered` 为派生（useMemo）。打分排序 = `score()` + 收藏加权 + lastUsedAt 降序
  （语义沿用原生 `refilter()`）。
- 分组（仅无查询时）：收藏 → 最近使用（有 lastUsedAt 的按时间取前 N）→ 其余按名称；
  有查询时平铺相关度列表（roadmap："搜索时相关度优先"）。
- 事件：`onRefresh` → 重新 getApps；`onError` → 错误条（顶部插入，`role="alert"`，
  风格沿用管理中心 toast 的 error 语义色）。
- `run(item)`：app → `startApp`、command → `invokeCommand`；返回 true → `bridge.hide()`。
  命令项在 App 未运行时照常可执行（主进程语义，UI 只提示"将自动启动"）。

## 键盘与焦点（对等性关键）

- input `autoFocus` + `window` focus 事件把焦点还给输入框（原生页行为照搬，
  含注释里的原因：否则方向键无效）。
- ↑/↓ 移动 active（越界钳制 + `scrollIntoView({block:"nearest"})`）、Enter 执行、
  Esc → `bridge.hide()`。键盘处理在 input 的 onKeyDown（面板打开即聚焦输入框，
  不需要全局 keydown）。
- 布局：`flex h-screen flex-col`——搜索框固定顶部（底边描边），列表
  `flex-1 overflow-y-auto`，hint 行固定底部。

## 主题

- 复用 `initTheme/resolveTheme/saveTheme/watchSystemTheme`：launcher 分区内
  localStorage + 系统兜底。与管理中心的选择互不同步——**故意的**（分区隔离，
  prd Out of Scope 已声明；后续如需统一走 host settings，另行设计）。
- 面板配色全走语义 token（`bg-card`、`border-border`、`text-muted-foreground`…），
  `dark` 类由 theme.ts 挂在 `<html>` 上，机制与管理中心完全一致。

## 兼容与回滚

- 回滚开关 = 删 `ui/node_modules`（与管理中心同机制、同验证方式）；原生页文件一行不动。
- 主进程/preload 零改动 → 无 IPC 兼容面；产物加载路径不变
  （`launcher.ts` 的 `loadFile(hostDist/launcher/index.html)`）。
- build.mjs 的既有断言（script tag 匹配失败即 throw、CSP 未注入即 throw）扩展到
  两页逐页断言——回退路径的 index.html 归一化逻辑保持现状。

## 取舍记录

| 取舍 | 选择 | 理由 |
|------|------|------|
| 两遍构建 vs 多入口 | 两遍 | iife 多入口被 Rollup 禁止；秒级构建成本换零架构变更 |
| score() 平移 vs 共享 | 平移 | 独立工程无跨包 import；原生页冻结，React 版持新实现 |
| 主题跨窗同步 | 不做 | 分区隔离是现状；统一到 host settings 属新范围（Out of Scope） |
| 虚拟列表 | 不引入 | top 30 截断沿用现状，30 项无需虚拟化 |
| 分组实现 | 无查询时分组 | roadmap 原文语义；查询态相关度平铺保持命令面板手感 |
