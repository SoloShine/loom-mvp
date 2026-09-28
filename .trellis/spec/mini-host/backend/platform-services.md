# 平台服务层（services/）与新增能力清单

## dispatcher 模式（services/dispatcher.ts）

服务路由是显式 switch，签名统一：

```ts
dispatch(ctx: ServiceCtx, service: string, method: string, args: any): Promise<unknown>
```

- `ServiceCtx = { appId, appPath, pushEvent }`——所有 App 上下文从这来，不透传原始事件。
- 未知 service/method 组合 `break` 落到统一 throw，错误经 SDK promise 回到调用方，
  **不向主进程顶层抛**。
- 参数在 handler 边界做类型规整（`String(args?.path)` 一类），脏参数在边界拒绝，
  服务实现里拿到的是规整过的值。

参考文件：`host/src/main/services/dispatcher.ts`、`services/core.ts`（clipboard/files/notification/storage 实现）。

## 现有服务速览

| service | 实现 | 要点 |
|---------|------|------|
| log | dispatcher 内联 | 落 `logs/apps/<appId>.log`，级别 info/warn/error |
| storage | core.ts | 按 appId 命名空间隔离；磁盘优先于缓存；损坏文件 `.corrupt-*` 隔离 |
| files | core.ts | `files.move/copy` 无覆盖语义：目标存在即失败，跨卷走 copy+verify 链 |
| clipboard / notification | core.ts | 直通 Electron API；通知 onClick 交互化是 roadmap P2 |
| screen | screen.ts | **物理像素收口**：`physicalOrigin`(×主屏 scale) + `physicalRect`；`selectRegion` = ms-screenclip + 剪贴板取图 + locate-region.py 模板匹配；截屏必须在弹出截图工具之前完成 |
| mouse / keyboard | input.ts | 经 `input-helper.ps1`（SetProcessDpiAwarenessContext(-4)）；waitClick 提供零换算选区 |
| hotkeys | hotkeys.ts | `registerWithRetry`（unregister 异步释放）；本机 Ctrl+Shift+L / Ctrl+Alt+L 被系统占用 |
| window | windows.ts | 归属表 + hide/focus 语义，见 [ipc-preload-contracts](./ipc-preload-contracts.md) |
| process | processSvc.ts | helper 子进程；stdout/stderr 逐行转发并 tee 进 App 日志 |

## helper 子进程约定

- 非 TS 入力（Python / PowerShell / 原生程序）一律 helper 进程，stdin/stdout JSON Lines
  （SDK 侧 `host.process.spawnJson`）。**entry 只能是 TS/JS**（PRD §3 pinned 决策）。
- helper 属主进程管理（processSvc），崩溃/退出要回报；helper 打印非 JSON 行只进日志不进协议。
- 新增 .ps1 必须走 `scripts/build.mjs` 的 copyWithBom（PowerShell 5.1 BOM 坑，见
  guides/windows-pitfalls.md）；Python 解释器用 `MINI_PYTHON` 环境变量可覆盖。
- 需要屏幕坐标的 helper 全部工作在物理像素空间（windows-pitfalls「坐标系」节）。

## 加一个新 host.* 能力（完整清单）

1. `services/<svc>.ts`（或并入 core.ts）实现 + dispatcher 加 case。
2. `sdk/src/index.ts` 加 API 面（全部 async；见 [sdk 规范](../../sdk/backend/index.md)）。
3. 若 App 窗口也要用：`preload/app-window.ts` 白名单 + `windows.ts` 归属路由。
4. `permissions`：manifest 能力声明按 `service` 前缀（CLI 的能力 lint 以
   `host.<Svc>.` 调用 vs 声明比对），确定该能力是否要强制声明。
5. 契约测试进 `tests/host-contract.test.cjs`；PRD 第 7 节有对应小节的，同步该节。

## 防循环导入

manager 与 windows 之间已有先例：用**注入回调**（`setWindowActivityHook`）而不是互相 import。
服务间新增双向需求时优先加回调/事件，不让模块图成环。
