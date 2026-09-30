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
| clipboard / notification | core.ts | 直通 Electron API；notification.show 可选 `clickCommand`（必须为清单声明命令，show 时校验）→ 点击按 invoke 全语义分发 + focusApp 唤起面板；分发回调由 manager 注入（`setNotificationClickDispatcher`，防环），click 回调内一切异常吞掉不得向主进程顶层抛 |
| screen | screen.ts | **物理像素收口**：`physicalOrigin`(×主屏 scale) + `physicalRect`；`selectRegion` = ms-screenclip + 剪贴板取图 + locate-region.py 模板匹配；截屏必须在弹出截图工具之前完成 |
| mouse / keyboard | input.ts | 经 `input-helper.ps1`（SetProcessDpiAwarenessContext(-4)）；waitClick 提供零换算选区 |
| hotkeys | hotkeys.ts | `registerWithRetry`（unregister 异步释放）；本机 Ctrl+Shift+L / Ctrl+Alt+L 被系统占用 |
| window | windows.ts | 归属表 + hide/focus 语义，见 [ipc-preload-contracts](./ipc-preload-contracts.md) |
| process | processSvc.ts | helper 子进程；stdout/stderr 逐行转发并 tee 进 App 日志 |

## appMetrics 内存观测（services/appMetrics.ts）

`memoryForPid(pid, metrics)` 从 `app.getAppMetrics()` 快照按 pid 精确对号 App 的
utilityProcess 当前内存（MB 四舍五入整数），供两条管理 API 面（controlChannel
`appToApi` / management `api()`）的 `memoryMB` 字段使用。约定：

- **字段形状以实测为准（Electron 44）**:`ProcessMetric.memory` 是
  `{ workingSetSize, peakWorkingSetSize, privateBytes }`,**单位 KB**——旧文档的
  `{ workingSetMB }` 形状在真实返回中不存在;helper 两种形状都收,workingSetSize 按
  KB→MB 换算。教训:对 Electron API 字段做契约测试前先实测一次真实返回,合成数据会
  把错误形状测绿。
- electron-free 纯函数（入参最小结构类型 `ProcessMetricLite`），脏输入（pid 非有限数、
  缺 memory、working set 非数值）一律跳过或返回 undefined，绝不抛；契约测试 bundle 直跑
  （同 winBounds 先例）。
- 快照每请求一次：GET /apps 与 GET /apps/:id 各调一次 `getAppMetrics()` 复用给全部 App；
  action 类响应（start/stop/enable/favorite/invoke 等）不附快照，缺省由详情页 5s 轮询补。
- 按 pid 对号不做 process type 过滤：天然排除 Host 自身/渲染/GPU 等一切非本 App 进程；
  App 用 SDK `process.spawn` 起的 helper 子进程不是 Electron 进程，快照里不可见。
- 只观测不回收：无内存上限回收、无告警、无历史；UI 仅详情页显示，非运行态显示 —。

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
