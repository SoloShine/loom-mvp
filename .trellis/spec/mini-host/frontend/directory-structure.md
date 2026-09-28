# 目录结构（ui/）

```
ui/
├── index.html            # 空 #root；构建后经 scripts/build.mjs 归一化
├── launcher.html         # Launcher 面板入口（构建时改名 index.html 拷入 host/dist/launcher/）
├── vite.config.ts        # React 插件 + Tailwind v4 插件；cssCodeSplit:false、iife
├── vite.config.launcher.ts  # Launcher 第二遍构建（iife 不支持多入口，独立 pass）
├── package.json          # @loom/ui；独立 npm 工程（不在根 workspaces）
└── src/
    ├── main.tsx          # 入口：initTheme() 先于 React render（防闪屏），挂 ToastProvider
    ├── App.tsx           # 壳：侧栏导航 + 视图切换（view: "apps" | "settings"）+ 主题切换
    ├── pages/
    │   ├── apps.tsx      # 应用列表/详情/操作/历史/日志
    │   └── settings.tsx  # 设置页（含闲置回收策略）
    ├── launcher/         # Launcher 面板（main.tsx / LauncherApp.tsx / bridge.ts）
    ├── components/
    │   ├── ui/           # shadcn 风格基础件：button / card / badge / input / switch
    │   └── toast.tsx     # ToastProvider + useToast（2.8s 自动消失，error 红色）
    ├── lib/
    │   ├── bridge.ts     # window.__management ?? 演示 mock；errorMessage() 清洗 IPC 错误
    │   ├── fuzzy.ts      # 命令面板打分（子串命中 > 子序列；自 host/src/launcher/ui.ts 平移）
    │   ├── theme.ts      # mini-theme localStorage + prefers-color-scheme + watchSystemTheme
    │   ├── status.ts     # statusMeta：App 状态 → 中文标签 + 状态点样式（单一事实）
    │   └── utils.ts      # cn()（clsx + tailwind-merge）
    ├── types.ts          # DTO 契约：AppInfo / HostSettings / HistoryEvent / ManagementBridge / LauncherBridge
    ├── index.css         # Tailwind 入口 + 设计 token（CSS 变量）
    └── mocks.ts          # 演示模式假数据（管理中心 + Launcher）
```

## 约定

- import 一律走 `@/` alias（tsconfig paths + vite resolve 对齐）。
- **页面级数据只经 `lib/bridge.ts`**，组件不直接碰 `window.__management`；
  桥方法与 `types.ts` 的 `ManagementBridge` 一一对应。
- 新页面：`pages/<name>.tsx` + `App.tsx` 的 `View` 联合类型加一项 + 侧栏 nav 数组加一项。
- `lib/status.ts` 是状态展示的单一事实——新增 App 状态（host 侧 registry/manager）时同步这里。
- 文件命名：组件与页面 PascalCase（`apps.tsx` 页面例外，沿用现名），lib 小写连字符。
