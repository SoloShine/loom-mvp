# API 面（sdk/src/index.ts）

## 服务清单（与 host dispatcher 一一对应）

`host.log / host.storage / host.clipboard / host.files / host.screen / host.mouse /
host.keyboard / host.hotkey / host.window / host.notification / host.process / host.ui / host.app`

- `notification.show({title, body?, clickCommand?})`：clickCommand 必须是清单 commands
  声明的命令 id（show 时校验，拒绝中文报错）；点击按 invoke 语义分发并唤起面板；
  不传则点击无副作用。不做事件订阅式 onClick（通知寿命 > App 运行周期，命令分发无状态）。

- 每个方法一行 `call(service, method, args)`，不包业务逻辑；
  例外是 `process.spawn`（包装 handleId → SpawnHandle）与 `hotkey.register`
  （注册成功后本地 subscribe 回调）。
- `SpawnHandle` 的 stdout/stderr/onExit 均返回退订函数；`wait()` 复用 exit 事件 promise。
- `host.ui`（runtime → 窗口）/ `host.app`（窗口 → runtime）是消息总线对：
  `send` 失败静默（`void call(...).catch(() => {})`），`onMessage` 走 `ui:message` 事件键。

## 消息协议（与 host/src/runtime/bootstrap.cjs 同源）

```
app → host: {type:"mini-svc", id, service, method, args}
host → app: {type:"mini-svc-res", id, ok, result|error}
host → app: {type:"mini-svc-event", key, event, data}
```

- 事件键约定：`<handleId>:stdout|stderr|exit`（process 服务）、`hotkey:<combo>`、`ui:message`。
  新事件键在此登记并保持 `<主体>:<事件>` 形状。
- **事件监听器异常必须吞掉**（try/catch per listener）——监听器崩不得影响宿主与其他订阅者；
  `spawnJson` 对非 JSON 行**丢弃不抛**（helper 会打人类可读日志）。

## 加一个新 host.* API（完整清单）

1. `sdk/src/index.ts`：类型 + `call()` 方法（全部 async、JSDoc 标注坐标/单位语义）。
2. `host/src/main/services/`：实现 + `dispatcher.ts` 加 case（见 mini-host 后端规范）。
3. App 窗口也要用 → `host/src/preload/app-window.ts` 白名单 + windows.ts 归属路由。
4. `host/src/main/manifest.ts`：如该能力需要 `permissions` 声明，确认前缀规则
   （CLI 能力 lint 按 `host.<Svc>.` 比对）。
5. 契约测试：`tests/host-contract.test.cjs`（协议/校验）+ PRD §7 对应小节同步。

## 错误约定

- `call` reject `new Error(m.error)`：host 侧错误消息是中文、面向用户，SDK 不再包装。
- 环境错误（无传输层）reject 中文一次性说明（现文案见 index.ts），不重试。
- 不引入错误码体系——MVP 以消息文本为准（与 CLI/host 一致）。
