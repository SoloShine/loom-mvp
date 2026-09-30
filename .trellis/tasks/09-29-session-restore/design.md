# P2.3 设计

## 现状证据(已核实)

- boot 顺序(host/src/main/index.ts:30):initDataDir → initLogging → state.initState → configureLogging → **history.initRuns()** → registry.initRegistry → ipc/management/launcher → `return startControlChannel()`。initRuns 此刻把无终态 run 补 interrupted 并清空 active-runs——恢复依据必须在这一步拿走,事后翻 history 无法区分「本次 boot 的 interrupted」与上次遗留。
- initRuns(host/src/main/history.ts:39)当前返回 void;惰性调用点(begin/finish/commit 里 `if (!active) initRuns()`)只在 active 未初始化时触发,生产路径 boot 已先显式调用,改返回值对它们零影响。
- manager.start(host/src/main/runtime/manager.ts:121)即全语义:requireApp(自愈重扫 + APP_DISABLED + BROKEN_MANIFEST)、热键注册、utilityProcess fork、manifest 窗口创建(P2.1 几何恢复自动生效)、recordUse、start 事件。恢复不需要新分支,直接复用。
- 设置链路:PATCH /settings → settingsCommit.patchHostSettings(浅合并、失败回滚)→ state.patchSettings(未知字段按 defaults 拒绝 + validSettings 全量校验)。新增顶层字段需同步:defaults、validSettings、normalizeSettings(旧文件迁移)、ui/src/types.ts、ui/src/mocks.ts。
- enabled 守卫:控制通道 start 端点有(controlChannel.ts:153),requireApp(:355)本身也抛 APP_DISABLED——恢复循环 catch 即可,无需重复检查。
- 契约测试隔离:core-fs.test.cjs 用 MINI_DATA_DIR 临时目录 + 打包 bundle 跑 history;state 同款在 host-contract.test.cjs。initRuns 幂等/埋终态用例已存在,可直接扩展。

## 决策

| # | 决策 | 理由 / 放弃项 |
| --- | --- | --- |
| D1 | 设置字段为顶层 `restoreSession: boolean`,默认 false;不建嵌套段 | 单字段建 recycle 式嵌套段是过度结构;patchSettings 浅合并下顶层最薄。UI 放「常规」卡,不新增 Card |
| D2 | `initRuns(): string[]` 返回本次标 interrupted 的 appId(保序去重);boot 捕获返回值 | 事后扫 history 区分本次 boot 的 interrupted 不可靠(上次 boot 也可能留 interrupted);惰性调用方忽略返回值,无行为变化 |
| D3 | manager 新导出 `restoreInterrupted(ids)`:开头查 `settings().restoreSession` 门(关→直接返回),循环内查 draining,串行 await start 逐项 try/catch;boot 在 startControlChannel 成功后 fire-and-forget | 门放 manager 内使 index.ts 只传数据不传策略;串行避免并发 fork 抖动;control channel 就绪后再恢复,恢复期 CLI 可观测 |
| D4 | HistoryEvent kind 联合加 `"restored"`;**不进** TERMINAL_KINDS;success/failure 都写,failure 带 message;不写 runId | restored 是伴随事件不是终态——若入 TERMINAL_KINDS,反向扫描会把该 runId 误判已终结。runId 归 start 事件,restored 只表达「尝试恢复」这一动作 |
| D5 | 恢复项不做预检过滤:缺失/禁用/损坏一律交给 start 抛错 → restored failure | requireApp 已有全部判定与自愈逻辑,预检是重复实现;失败原因原样进事件与日志 |

## 交互细节

- 恢复循环遇 draining(Host 正在退出)立即停止,剩余项放弃(Host 都要退了,恢复无意义)。
- 恢复顺序 = active-runs 记录顺序(近似崩溃前启动顺序)。
- 设置读取时机:restoreInterrupted 开头读一次,boot 不重复读。
- history.event 写失败(返回 false)不特殊处理,其内部已 logHost。

## 测试计划

- core-fs.test.cjs(history bundle):
  - initRuns 返回值——多 run 交错终态时只返回本次补 interrupted 的 appId,保序去重;二次调用返回 []。
  - event() 接受 kind:"restored" 且可 query;restored 事件不抑制后续终态判定(TERMINAL_KINDS 未含它)。
- host-contract.test.cjs(state bundle):旧文件无 restoreSession → normalize 后为 false 且不判损坏;patchSettings 接受 boolean、拒绝非 boolean;round-trip。
- UI:ui tsc 干净 + build 通过;设置页无独立单测(与 recycle 开关同待遇)。
- 三条闸门:npm test、ui tsc、smoke。

## 风险

- taskkill 时 App 可能正在写 storage:恢复只是重新 start,storage 一直由 atomicWrite 保护,无新增风险。
- 恢复期间用户手动 stop/start 与循环竞争:start 内部状态机会抛(stopping 等),记 failure 即可,窗口极小。
- 恢复的 App 带窗口时 P2.1 几何恢复接管位置——行为一致,无冲突。
