# 状态与数据（ui/）

## 取数：bridge 单入口

- `lib/bridge.ts`：`window.__management`（preload `host/src/preload/management.ts` 暴露）
  存在则真桥，否则落 `mocks.ts` 演示数据并置 `demoMode = true`。
  **任何组件不得绕过 bridge 直接访问 window 或 ipcRenderer。**
- 新增桥方法（如 roadmap 的 dev 热更、通知交互化）三处成对改：
  1. `host/src/preload/management.ts` 白名单方法；
  2. `host/src/main/management.ts` handler（sender 校验见 host 后端规范）；
  3. `ui/src/types.ts` 的 `ManagementBridge` + bridge.ts 的演示实现。
- IPC 拒绝的错误串用 `errorMessage()` 清洗后再展示。

## 状态管理：本地 state，无全局库

- React 19 自带能力（`useState` / `useEffect` / Context）就够，仓库**无** redux/zustand/react-query。
  引入新状态库前先证明现有模式不够用。
- 数据在页面组件持有（`useState` + `useEffect` 拉取），跨页共享的只有主题与 toast（Context）。
- 轮询/刷新：apps.tsx 按既有节拍刷新列表；新的常驻轮询要在页面卸载时清理。

## 类型契约（types.ts 即文档）

- `AppInfo / HostSettings / RecycleSettings / HistoryEvent / IdleStopInfo / ManagementBridge`
  全部显式接口，字段带中文注释说明语义（如 idleStop 三字段的含义）。
- 主进程 handler 返回的 DTO 形状以 `ui/src/types.ts` 为准做对齐；两边不一致是最常见的
  「列表空了/字段 undefined」根因——改 host 侧 DTO 时同步这里并手测页面。
- 可选字段（`version? / pid? / lastUsedAt?`）在 UI 侧必须容错渲染，不要假设存在。

## 主题

- `lib/theme.ts`：显式选择存 localStorage `mini-theme`；无选择时跟随
  `prefers-color-scheme`，且 `watchSystemTheme` 监听系统切换实时跟随。
- `initTheme()` 必须先于 React render（main.tsx 里已如此）——页面是空 #root，无闪屏。
  新的独立入口（如 P1.1 Launcher）必须复制这一防闪屏序列。
