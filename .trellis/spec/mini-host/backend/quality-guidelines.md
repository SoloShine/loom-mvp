# 质量守则（mini-host 后端）

## 验证命令

```bash
npm run build   # tsc + esbuild 全管线；类型闸门
npm test        # 29 项基线，node --test tests/*.test.cjs
npm run smoke   # S1~S5 生命周期用例；改 manager/shutdown/history 后必跑
```

写法与数据纪律见 [guides/testing-and-acceptance.md](../../guides/testing-and-acceptance.md)。
改 `host/` 主进程后重启 Host 才生效。

## 状态与持久化

- 一切写盘走 `state.ts` 的 `atomicWrite`；**先落盘再更新内存缓存**。
- 损坏状态文件：隔离成 `.corrupt-*` 后按默认值重建，不静默删除用户数据。
- history 只追加（jsonl），读取用反向分块扫描；新事件类型进 `HistoryEvent.kind` 联合类型并补恢复用例。

## 日志

- 主进程用 `logHost`，App 相关用 `logApp(appId, ...)`；不要直接 console.log（丢文件现场）。
- 关键链路插桩是仓库惯例：preload 加载探针、ownership 守卫、shutdown 各阶段都有日志。
  新加跨进程链路时沿例插桩——排障第一现场是 `logs/host.log`。

## 错误处理

- 对 App/渲染层：错误经 promise/IPC 回传，带面向用户的中文消息（如 `未知或清单损坏的 App: ${id}`）。
- 校验失败返回结果对象（`{ok:false, errors[]}`）而非 throw 的场景仅限 parse 类入口。
- 退出码纪律见 windows-pitfalls：`taskkill /F` 的退出码 1 不是崩溃证据；
  错误路径用 `process.exitCode`（CLI 侧）。

## 禁止清单

- ❌ `process.exit()` 在 CLI/宿主逻辑里（undici 连接复用 → libuv 断言）；用 `process.exitCode`。
- ❌ spawn electron 时加 `windowsHide: true`。
- ❌ 裸调 `globalShortcut.register/unregister`（用 hotkeys.ts 的 retry 封装）。
- ❌ 在 service/dispatcher 之外直接读写 `data/` 下文件（一律经 state/各服务收口）。
- ❌ 在 closed 事件回调里访问 `win.webContents`。
- ❌ 新增 .ps1 不走 build.mjs 的 copyWithBom。
- ❌ 复制 manifest 校验/路径解析逻辑（唯一事实在 manifest.ts / config.ts）。
