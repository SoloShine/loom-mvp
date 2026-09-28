# IPC 与 preload 契约

## 通道面（三种窗口三个桥，不要混用）

| 窗口 | preload | 渲染侧入口 | 主进程入口 |
|------|---------|-----------|-----------|
| App 窗口 | `host/src/preload/app-window.ts` | `window.__miniHost` | `runtime/manager.ts`（svc）+ `services/windows.ts`（ui 消息） |
| 管理中心 | `host/src/preload/management.ts` | `window.__management` | `management.ts` |
| Launcher | `host/src/preload/launcher.ts` | `window.__launcher` | `launcher.ts` |
| 控制页 | `controlPage.ts` 自带 | — | `controlPage.ts` |

- preload 里只放**显式白名单方法**的 contextBridge，不透传 ipcRenderer / 任意 channel。
- 新增渲染层能力 = preload 桥方法 + 主进程 handler 两处成对改；DTO 类型在
  `ui/src/types.ts`（渲染）与主进程各自声明，改动时两处同步。

## sender 校验（安全边界，全部受测）

- **先验 sender 再干活**：校验 URL 是预期的 file:// 产物页、`isDestroyed()` 为 false、
  webContents 归属正确。现成实现：`controlPage.ts` 的 `isTrustedPage(wc, expectedWc, file)`
  （伪造/销毁/导航过三种情况都拒绝，见 host-contract 用例）；`launcher.ts` 的
  `launcherSender` 同款纪律。给管理中心/新窗口加 IPC 时照抄这个模式。
- **窗口归属表**：`windows.ts` 用 `appByWebContents` 把 webContentsId 映射到 appId，
  svc 调用按归属表定 appId，**不信任事件参数里的 appId**。
- **归属表失效 = 静默死亡**。历史事故：清理 closed 处理时把 `.set()` 注册行一起删了，
  所有 App 窗口 IPC 全灭且无报错。现在有 ownershipDump + "svc ownership FAIL" 守卫日志。
  规矩：删任何"注册行 + 注销行"成对出现的位置时，先 grep 引用，确认归属表仍会被填充。

## 窗口语义（services/windows.ts）

- 三种窗口类型来自 manifest（`window / floating / overlay`），窗口按需创建。
- **统一关闭语义**：浮窗/面板类 App 的"关闭"= `hideApp()`（隐藏到托盘，渲染状态保留，
  focus 可唤回）；真销毁走 `close(windowId)` / `mini stop`。改关闭链路时保持这条分层。
- `focusApp`：已运行则提窗最前；窗口丢失按 manifest 重建。Launcher 的"启动"= 启动或唤起，
  对已运行 App 纯 start() 是空操作。
- `closed` 事件回调里禁止访问 `win.webContents`（已 destroyed）；要用的 id 在关闭前捕获。

## 控制通道（controlChannel.ts）

- localhost 随机端口 + 随机 token，地址写 `data/runtime.json`；CLI 与控制页凭 token 访问。
  token 缺失/不匹配一律拒绝——不要为调试临时放宽，用 `npm run smoke` 的隔离实例调试。
- Host 未运行时 CLI 会拉起 Host（ensureHost）：spawn electron **禁止 windowsHide**。
