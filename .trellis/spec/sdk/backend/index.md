# @mini/sdk 规范（`sdk/`）

> App 调用宿主能力的唯一 API 面。单文件 `sdk/src/index.ts`，无构建产物——
> **SDK 由 Host 在构建期经 esbuild alias 注入 App 产物，App 不安装、不固定版本**
> （PRD pinned 决策；`package.json` 的 main/types 直接指 `src/index.ts`）。

## 运行环境与传输（api 的前提）

SDK 运行在两种环境之一，自动探测：

| 环境 | 通道 | 入口对象 |
|------|------|----------|
| App runtime 进程（Electron utilityProcess） | `process.parentPort` MessagePort | `host.*`（node 侧全部可用） |
| App 窗口渲染进程 | preload `window.__miniHost` | `host.*`（ui/app 消息受限） |

两者都缺失时 `call()` reject 中文错误（`@mini/sdk: host.<svc> 只能运行在 Mini App Host 内`）——
这是故意的失败方式：SDK 不做 fallback、不打假数据。

## 规范索引

| 文档 | 内容 | 何时读 |
|------|------|--------|
| [API 面](./api-surface.md) | 服务清单、消息协议、加新 API 清单 | 加/改 host.* 能力 |
| [质量守则](./quality-guidelines.md) | 契约测试、兼容性、禁止清单 | 任何改动后 |

## 铁律

1. **全部 API 异步**（跨 IPC）；事件订阅返回**退订函数**（现有一律 `subscribe()` 实现）。
2. 对外坐标/图像一律**物理像素**（`Rect / CapturedImage / MonitorInfo` 注释已声明）。
3. SDK 是共享面：改它 = 同时改 host dispatcher（+ 窗口侧 preload，如适用）+ 契约测试。
4. 单文件纪律：`src/index.ts` 是唯一实现文件，新增大块能力也保持单文件
   （SDK 面越小越好；真放不下再讨论拆分，并同步 alias 注入路径）。
