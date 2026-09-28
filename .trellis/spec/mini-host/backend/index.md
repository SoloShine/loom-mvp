# mini-host 后端规范（Electron 主进程 + preload）

> 覆盖 `host/`（Electron 44 主进程、preload 桥、App runtime 引导）。
> 渲染层 UI 见 [`../frontend/`](../frontend/index.md)；Windows 平台坑见
> [`guides/windows-pitfalls.md`](../../guides/windows-pitfalls.md)——改主进程前必读。

## 架构一句话

每个 App 一个 Electron `utilityProcess`（崩溃隔离），App 通过构建期注入的
`@mini/sdk` 经 MessagePort 调 host.* 服务；CLI 通过 localhost+token 控制通道
驱动 Host。Host 只提供基础设施，不做业务（PRD §2.1）。

## 规范索引

| 文档 | 内容 | 何时读 |
|------|------|--------|
| [目录结构](./directory-structure.md) | main / preload / runtime bootstrap / 内置页面的职责划分 | 新建文件前 |
| [Manifest 与 App 生命周期](./manifest-and-lifecycle.md) | app.yaml 契约、registry、manager、启停/闲置回收 | 动 manifest、启停、history 相关代码 |
| [IPC 与 preload 契约](./ipc-preload-contracts.md) | 通道协议、sender 校验、窗口归属表 | 加/改任何 IPC、preload、窗口代码 |
| [平台服务层](./platform-services.md) | dispatcher 服务模式、screen/input helper、加新服务清单 | 加 host.* 能力 |
| [质量守则](./quality-guidelines.md) | 状态持久化、日志、测试、验证命令 | 任何改动后 |

## 铁律（违反即返工）

1. **App 崩溃绝不许带倒 Host**——隔离边界在 `runtime/manager.ts`，别把 App 异常抛进主进程顶层。
2. **物理像素是唯一对外坐标空间**——对外 API/数据文件一律物理像素（见 windows-pitfalls）。
3. **spawn Electron 不加 `windowsHide: true`**（全仓纪律，见 windows-pitfalls）。
4. **所有 host.* API 异步**——同步实现会阻塞主进程；错误经 promise 回传，不向主进程抛。
5. **App 数据按 appId 隔离**——storage/logs/窗口归属都以 `ServiceCtx.appId` 为准，不接受调用方自报。
