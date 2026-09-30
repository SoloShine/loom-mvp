# P2.5 设计

## 现状证据(已核实)

- 两条 API 面均已暴露运行 pid:controlChannel `appToApi`(controlChannel.ts:52,`pid: run === "running" ? runInfo?.pid : undefined`)与 management `api()`(management.ts:30,同义)。pid 在 proc spawn 后即真值(history.updateRunPid 同源)。
- `app.getAppMetrics()` 返回 ProcessMetric[](pid、type、memory.workingSetMB/peakWorkingSetMB 等),一次调用即全进程快照——每请求算一次、复用给全部 App,而不是每 App 调一次。
- utilityProcess fork 时 serviceName=`mini:<id>`(manager.ts:147 附近),但按 serviceName 匹配不如按 pid 直接:pid 已在 statuses 里,且对号天然排除 Electron 自家 Utility(音频服务等)与渲染进程。
- 详情页(ui/src/pages/apps.tsx)选中即取 `bridge.getApp`,无轮询;`sub`(history/logs 面板)独立 state,由选中变化清空。
- 模块 electron-free 惯例:history/winBounds/devTarget/notificationClick 均为纯模块 + 契约测试 bundle 跑法(tests/host-contract.test.cjs 有 sanitizeRestoredBounds 先例)。
- controlChannel 已有惰性 require("electron") 先例(shutdown 分支),顶层不 import electron。

## 决策

| # | 决策 | 理由 / 放弃项 |
| --- | --- | --- |
| D1 | 按 pid 对号,不做 type 过滤 | pid 是 statuses 现成真值;type 名单跨 Electron 版本易漂移,且按 pid 天然排除一切非本 App 进程 |
| D2 | 纯函数 `services/appMetrics.ts`:`memoryForPid(pid, metrics): number \| undefined`(electron-free,入参用最小结构类型不 import electron 类型) | 契约测试可 bundle 直跑;健壮性(脏条目/非数值)收在函数内 |
| D3 | 两条 API 面都带 `memoryMB`(working set 四舍五入整数);快照每请求一次复用;appToApi 加可选参数,不传即 undefined | detail/list 一次取齐;action 类响应不传快照(内存值允许缺省,详情轮询会补) |
| D4 | UI 仅详情页显示;running 时每 5s 轮询 getApp(独立 effect,只 setDetail 不动 sub/busy),非 running 显示 — | roadmap 要「观测」而非快照;列表行不加,避免噪音 |
| D5 | 值语义 = workingSetMB 当前值;peak 不暴露 | roadmap 只要当前;YAGNI |

> **勘误(验收期实测)**:D2/D5 假设的 `ProcessMetric.memory.workingSetMB` 在 Electron 44
> 真实返回中不存在——实测为 `{ workingSetSize, peakWorkingSetSize, privateBytes }`,单位 KB。
> 实现改为双形状兼容,workingSetSize 按 KB→MB 换算;教训已记 platform-services.md。

## 交互细节

- 轮询守卫:`detail?.status === "running" && !busy`,间隔 5s,组件卸载/换选中/变非 running 即停;轮询响应到达晚于用户操作时以 alive 标志丢弃。
- 停止中的 App 详情显示 —,不显示上次值(避免误导)。
- broken App:api() 走 broken 分支(无 pid),memoryMB 自然缺省。

## 测试计划

- tests/host-contract.test.cjs(bundle 跑法照抄 sanitizeRestoredBounds 用例):memoryForPid 命中(四舍五入)、pid undefined → undefined、metrics 中无该 pid → undefined、脏条目(缺 memory / workingSetMB 非数值 / pid 非数值)跳过不抛。
- UI 无独立单测(与其它页面同待遇):ui tsc + build 闸门。
- 三条闸门:npm test、ui tsc、npm run build && npm run smoke。

## 风险

- getAppMetrics 快照与 statuses pid 之间存在窗口极小的错配(App 恰在此刻重启):表现为一次 undefined/旧值,下轮轮询自愈,不做加锁。
- 任务管理器与 workingSetMB 采样时点不同,数值允许合理偏差,验收看量级不看精确值。
