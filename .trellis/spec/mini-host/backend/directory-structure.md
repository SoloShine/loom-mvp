# 目录结构（host/）

```
host/
├── package.json                 # name: mini-host；入口 dist/main/index.js
├── tsconfig.json
└── src/
    ├── main/                    # Electron 主进程（esbuild 打包 → dist/main/index.js）
    │   ├── index.ts             # 入口：窗口/托盘/全局装配
    │   ├── config.ts            # paths：MINI_ROOT / MINI_APPS_DIR / MINI_DATA_DIR 等环境变量收口于此
    │   ├── manifest.ts          # app.yaml 解析与校验（唯一事实，CLI 也 import 它）
    │   ├── registry.ts          # App 注册表：扫描 apps/ 目录 + 状态合并
    │   ├── state.ts             # host 状态持久化（AppMeta、settings；atomicWrite 在此）
    │   ├── appManagement.ts     # enable/disable 等编排（per-id 串行队列 + reconcile）
    │   ├── settingsCommit.ts    # 设置补丁串行提交队列（含热键变更回调）
    │   ├── controlChannel.ts    # CLI 控制通道：localhost 随机端口 + token → data/runtime.json
    │   ├── controlPage.ts       # 控制页 sender 校验（isTrustedPage）
    │   ├── management.ts        # 管理中心 IPC 面（对接 ui/ 渲染层）
    │   ├── launcher.ts          # Launcher 窗口与 IPC（launcherSender 校验）
    │   ├── idleStop.ts          # 闲置回收策略解析（manifest 例外名单优先）
    │   ├── history.ts           # 运行历史 jsonl + active-runs.json 恢复
    │   ├── logging.ts           # host 日志 + 按 App 日志（大小/保留期受 settings 约束）
    │   ├── shutdown.ts          # 退出编排（drain → 超时强杀 → quit；防重复 before-quit）
    │   ├── runtime/
    │   │   └── manager.ts       # 每 App 一个 utilityProcess；svc 调用路由、事件回传、崩溃隔离
    │   └── services/
    │       ├── dispatcher.ts    # host.* 服务路由（service/method → 实现）
    │       ├── core.ts          # clipboard / files / notification / storage
    │       ├── screen.ts        # 截屏、显示器、选区（物理坐标换算收口）
    │       ├── input.ts         # 鼠标/键盘（经 input-helper.ps1）
    │       ├── processSvc.ts    # helper 子进程 spawn/kill/流转发
    │       ├── hotkeys.ts       # 动态全局热键（registerWithRetry）
    │       ├── windows.ts       # App 窗口生命周期、归属表、hide/focus
    │       ├── shared.ts        # 跨服务小类型（Rect）
    │       ├── input-helper.ps1 # 鼠标/键盘注入（DPI 感知，构建期加 BOM）
    │       └── locate-region.py # 截屏模板匹配定位（MINI_PYTHON 可覆盖解释器）
    ├── preload/                 # 三种窗口各一个 contextBridge 桥
    │   ├── app-window.ts        # App 窗口：window.__miniHost（svc call / app↔ui 消息）
    │   ├── management.ts        # 管理中心：window.__management
    │   └── launcher.ts          # Launcher：window.__launcher
    ├── runtime/
    │   └── bootstrap.cjs        # App runtime 引导（纯 CJS 无构建）：宿主↔App 消息协议在此
    ├── launcher/                # Launcher 原生页（index.html + ui.ts；React 化见 docs/post-mvp-plan.md P1.1）
    └── management/              # 管理中心旧原生页（ui/node_modules 缺失时的回退页）
```

## 归属约定

- `ui/`（React 管理中心，仓库根目录）在构建产物上属于 mini-host：
  `scripts/build.mjs` 将其构建到 `host/dist/management/`。改 UI 规范见
  [`../frontend/`](../frontend/index.md)。
- manifest 解析**只有一处**：`host/src/main/manifest.ts`。CLI 直接
  `import { parseManifest } from "../../host/src/main/manifest"`（见 `cli/src/index.ts`），
  禁止复制一份校验逻辑。
- 路径/环境变量收口在 `config.ts` 的 `paths`。需要新目录/新环境变量时加在那里，
  不要在业务模块里散落 `process.env`。
