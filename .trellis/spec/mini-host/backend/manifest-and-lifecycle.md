# Manifest 与 App 生命周期

## app.yaml 契约（host/src/main/manifest.ts）

- `parseManifest(text, dirName): ParsedManifest` 返回 `{ ok, manifest?, errors[] }`，
  **校验失败靠返回值，不抛异常**；错误文案是面向用户的中文（`缺少 id`、
  ``id 非法(需 ${ID_RE}): ${id}``）。沿用这个模式：能收集的错误都收集完一次报出。
- 字段：`id / name / version / entry / ui{type,width,height,devUrl?} / lifecycle? / commands / hotkeys / permissions`。
  `ui.type ∈ none|window|floating|overlay`；`lifecycle.idleStopMinutes`（0/缺省=关）；
  `ui.devUrl`（可选，必须 http(s) 地址）：dev server 可达时 App 窗口 loadURL 此地址接 Vite 热更，
  不可达回退产物（`services/devTarget.ts` 的 resolveDevTarget + windows.ts 创建时探测）。
- 硬规则：`id` 必须匹配 `^[a-z0-9][a-z0-9-]*$` 且**与目录名一致**。
  新增字段必须：manifest.ts 校验 + 相关消费者 + `tests/host-contract.test.cjs` 契约用例同步改。

## 注册表与状态

- `registry.ts` 扫描 `apps/` 目录（`config.paths.apps`），用 parseManifest 校验后合并
  `state.ts` 里的 AppMeta（enabled/favorite/addedAt/lastUsedAt/useCount）。
- 状态写入一律走 `state.ts` 的 `atomicWrite`（临时文件+改名）。**先落盘再更新内存缓存**
  （storage 的磁盘优先于缓存同此纪律）；读到损坏文件隔离为 `.corrupt-*` 再重建，不要整目录清空。

## 启停与运行（runtime/manager.ts + appManagement.ts + shutdown.ts）

- **每 App 一个 `utilityProcess`**，入口 `host/src/runtime/bootstrap.cjs`（纯 CJS，无构建步骤）。
  宿主↔App 协议：`mini-start / mini-invoke{reqId} / mini-stop / mini-svc-event` →
  `mini-ready / mini-started / mini-start-failed / mini-invoke-res / mini-stopped`。
  改协议要同时改 bootstrap.cjs、manager.ts、`sdk/src/index.ts` 三处，并补契约测试。
- **崩溃隔离**：App 退出/崩溃在 manager 的 proc 回调里做清理 + history 记录，异常不外抛。
  历史教训：active-runs 里 pid 恒 0 的缺陷源于 `utilityProcess.pid` 在 fork 时未就绪——
  要在 `proc.on("spawn")` 里回填（`history.updateRunPid`），fork 调用点拿到的 pid 不可信。
- **enable/disable 编排**走 `appManagement.setEnabledAndReconcile`：per-id promise 链串行化
  （disable 先 stop 再落状态）。同类"读改写"编排都应串行，不要并行竞争。
- **历史**：`history.jsonl` 追加 + `active-runs.json`（epoch 校验）；启动恢复把上次活跃 run
  补一条 `interrupted` 终态事件，重复启动不重复补（见 host-contract 用例）。`initRuns()`
  返回**本次**实际补了 interrupted 的 appId（保序去重，二次调用返回 `[]`）——恢复依据必须在
  boot 这一步拿走，事后翻 history 无法区分本次与上次遗留；惰性调用点（begin/finish/commit）
  忽略返回值。事件 kind 除终态外还有伴随事件 `restored`（success/failure，failure 带 message，
  **不写 runId**）：它表达「尝试恢复」这一动作，**绝不能加进 `TERMINAL_KINDS`**，否则反向
  终态扫描会把该 run 误判已终结、抑制后续 stop。查询是尾部
  1 MiB 反向分块扫描（`scanHistoryBackward`），别改成全文件读。
- **会话恢复（P2.3，设置 `restoreSession` 默认关）**：boot 在 `startControlChannel()` 就绪后
  fire-and-forget 调 `manager.restoreInterrupted(initRuns() 的返回值)`（见 index.ts）。开关关闭
  或名单为空直接返回；循环内查 draining（Host 退出中即放弃剩余），串行 `await start`，恢复项
  **不做预检**——缺失/禁用/清单损坏一律交给 start 抛错（requireApp 自带判定与自愈），单项失败
  写 `restored` failure 不阻塞其余；每次尝试同时落 host 日志。循环**绝不向调用方抛错**
  （fire-and-forget 调用方无 catch）。
- **闲置回收**：`idleStop.ts` 解析策略（manifest 例外名单 > 全局设置）；活跃信号 =
  invoke / 启动 / 窗口 show / focus——`windows.ts` 通过 `setWindowActivityHook` 回调上报，
  **避免 manager↔windows 循环导入**，加新活跃信号走同一机制。
- **退出**：`shutdown.ts` 编排 drain→超时强杀→quit；`before-quit` 防重入。杀进程后
  退出码 1 不是崩溃证据（taskkill /F 语义），判定看 history 终态事件。

## 验证

- 契约测试：`npm test`（host-contract 含 shutdown 编排、history 恢复、sender 校验用例）。
- 全链路：`npm run smoke`（S1 启停 / S2 崩溃隔离 / S3 猝死恢复 / S4 超时强杀 / S5 产物重建）。
- 改主进程代码后重启 Host 生效；dev 模式也一样。
