# 技术设计 — 通知 onClick 交互化

## 语义（核心决策）：命令分发，不是事件回调

roadmap 措辞「SDK 增加可选 onClick 回调,Host 侧映射为分发清单声明的命令」——
本设计把 onClick 落为 **`clickCommand` 选项（命令分发）**而非 SDK 事件订阅式回调。

| 取舍 | 选择 | 理由 |
|------|------|------|
| onClick 形态 | `show({ clickCommand })` 命令分发 | 通知留在通知中心，寿命 > App 运行周期：App 被 stop/重启后，订阅式回调的通道已不存在（悬挂句柄）；命令 id + 清单声明是无状态的，点击时按 invoke 语义现算（App 停了就自动启动） |
| 点击附带动作 | invoke + `focusApp` 双动作 | roadmap 验收「点击 → 面板唤起(focusApp 语义)」；invoke 对已停止 App 自动启动（窗口自然出现），对运行中隐藏面板的 App 需 focusApp 补唤起 |
| 校验时机 | show() 时校验 clickCommand ∈ 清单命令 | 拼写错误当场经 SDK promise 拒绝，而不是点击时静默无效 |
| 分发回调注入 | manager 启动时 `setNotificationClickDispatcher`（同 setWindowActivityHook 模式） | core → manager 直接 import 成环（manager → dispatcher → core）；回调注入是 spec 已案的破环手法 |

## 数据流

```
App runtime                      host 主进程
host.notification.show
  ({title, body, clickCommand})
  → mini-svc notification/show ─→ dispatcher: 取 registry 清单命令列表 + 透传
                                    → notificationApi.show({appId,title,body,
                                       clickCommand, declaredCommands})
                                       ├─ clickCommand 不在声明列表 → throw(中文)
                                       └─ new Notification(...).on("click",
                                            () => clickDispatcher(appId, clickCommand))
manager 启动时已注入:
  clickDispatcher = (appId, cmd) => invoke(appId, cmd).catch(warn) → windows.focusApp(appId)
通知 click(可能在任意时刻,App 或已重启) ─→ invoke 全语义(自动启动/活跃/history/日志) + 唤起
```

- click 事件回调内所有 await 包 try/catch——通知回调里不能向主进程顶层抛。
- clickDispatcher 未注入（理论上不可能，manager 启动必注入）时点击为 no-op（可选链）。

## 改动面

| 文件 | 改动 |
|------|------|
| `sdk/src/index.ts` | show 签名加 `clickCommand?: string` + JSDoc |
| `host/src/main/services/dispatcher.ts` | notification case：registry 取命令列表、透传 clickCommand（`typeof args?.clickCommand === "string" && 长度≤80` 否则按未传） |
| `host/src/main/services/core.ts` | notificationApi.show 新签名（appId/declaredCommands/clickCommand）+ click 接线 + `setNotificationClickDispatcher`；校验抛 `通知 clickCommand 未在清单命令中声明: ${x}` |
| `host/src/main/runtime/manager.ts` | 启动时注入分发回调（invoke + focusApp；invoke 失败 warn 不阻断 focus） |
| `apps/file-organizer/{app.yaml,src/main.ts}` | 加 `show` 命令（invoke case → `host.window.focusSelf()`）；「移动去向」通知（main.ts:89）加 `clickCommand: "show"` |
| `tests/host-contract.test.cjs` | 纯校验函数三分支（放 electron-free 位置：校验逻辑抽 `services/notificationClick.ts` 或并入现有纯模块,跟随 winBounds.ts 先例） |

- 校验函数独立成 `services/notificationClick.ts`（`validateClickCommand(clickCommand, declared): string | null`
  返回错误文案或 null），core.ts 调用 —— electron-free 可契约测试（winBounds.ts 同款）。
- dispatcher 的长度/类型口径与 invoke 的 command 校验一致（`typeof === "string"`、≤80）。

## 兼容性

- 不传 clickCommand 的四个既有调用点行为逐字节不变（无 click 监听、签名向后兼容）。
- 闲置回收通知（host 自发）不经 notificationApi → 维持纯展示（PRD Out of Scope）。
- SDK 签名只增不改；旧 App 产物（旧 SDK）不带 clickCommand → 无点击行为，无兼容问题。

## 测试

- 契约：`validateClickCommand` 三分支（合法 → null；未声明 → 错误文案含命令 id；
  非字符串 → null/错误按实现——口径：core 层只在 clickCommand 为 string 时校验，
  非字符串视为未传，由 dispatcher 层挡）。
- 既有 44 项不回归。

## 真机验收路径（file-organizer 确定性全链路）

> 验收载体用户定调：**不用连连看**（求解依赖真实游戏画面，环境随机、输出不稳定）。
> file-organizer 的「移动去向」通知是确定性流程（已知文件 → preview → execute →
> `moved > 0` 通知必现），且点击「已移动 N 个文件」→ 面板展示报告是 UX 配对最自然的选择。

```
1. 准备 data/acctest/sample/（放几个 .txt 等）；
   host 停机 → 预置 data/storage/file-organizer.json 的 lastDir 指向该目录（App 启动恢复）
2. mini run file-organizer → mini invoke preview → mini invoke execute
   → 「已移动 N 个文件」通知必现（确定性）
3. 点击通知 → history 出现 show 的 invoke 事件 + 面板唤起（focusApp/focusSelf 双保险）
   + host.log 干净
4. 对照：mini invoke clipboard-tool clean（通知无 clickCommand）→ 点击无副作用
5. 传未声明命令 → SDK 中文拒绝（错误文案含命令 id）
```

- storage 预置必须在 **host 停机**时做（storage 有宿主内存缓存，运行中改文件会被写回覆盖——
  P2.1 验证过的同款纪律）。
- `isSafeDirectory(savedDir)` 拒绝盘符根目录，data/ 下临时目录合法。
