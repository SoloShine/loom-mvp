# P2.5 内存观测层

## 背景

roadmap P2.5(「数据说话」):闲置回收已解决隐式常驻,运行中 App 的内存增长先积累观测,再决定是否需要上限回收(预期多数不需要)。本任务只加显示,不做任何回收动作。

## 目标

1. 管理中心 App 详情页显示运行中 App 的 utilityProcess 当前内存(MB);非运行态显示占位,不显示旧值。
2. 数据来自 Electron `app.getAppMetrics()`,按 App 的 utilityProcess pid 精确对号;Host 自身/窗口渲染进程/GPU 等 Electron 其它进程不计入。
3. 详情页运行中时数据自动轻量刷新,无需手动切换选择才更新。
4. 只观测:不回收、不告警、不存历史。

## 非目标

- 不做内存上限回收、阈值告警、历史曲线。
- App 用 SDK `process.spawn` 起的 helper 子进程(非 Electron 进程)不在观测范围(`getAppMetrics` 只见 Electron 进程树),边界写进 spec。
- Host 自身运行时长/重启次数显示是横切另列项,不并入。
- CLI list 输出不加内存列。

## 验收标准

1. 真机:App 运行时管理中心详情显示内存值(MB,与任务管理器中同进程 Working set 同量级);停止该 App 后详情显示占位(—)而非旧值。
2. 观测只对号自家 utilityProcess:数值不会被 Host 主进程或其它 App 的进程污染。
3. 契约测试覆盖 pid 匹配纯函数:命中、pid 缺失、未命中、脏指标条目(缺 memory/非数值)全分支。
4. 闸门:npm test 全绿、ui tsc 干净、smoke 5/5(先 npm run build)。
