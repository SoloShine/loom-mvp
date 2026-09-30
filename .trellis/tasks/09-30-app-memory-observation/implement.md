# P2.5 实施清单

按依赖顺序;1~3 host 侧,4~6 ui 侧,7 测试,8 spec,9 验收后主会话。

1. **host/src/main/services/appMetrics.ts(新)**:electron-free 纯函数。
   - `export function memoryForPid(pid: unknown, metrics: unknown): number | undefined`
   - 入参最小结构类型(如 `ProcessMetricLite { pid?: unknown; memory?: { workingSetMB?: unknown } }`,metrics 为其数组;不 import electron);
   - pid 非有限数 → undefined;遍历 metrics 找 `entry.pid === pid` 且 `Number.isFinite(entry.memory?.workingSetMB)` 的第一条,返回 `Math.round(workingSetMB)`;找不到 → undefined;整体不抛。
2. **host/src/main/controlChannel.ts**:
   - 顶部或就近惰性 `getElectronApp()`(照 shutdown 分支的 require("electron") 先例,保持模块顶层 electron-free);
   - `appToApi(entry, metrics?)`:在现有 `pid` 旁加 `memoryMB: run === "running" ? memoryForPid(runInfo?.pid, metrics) : undefined`(字段位置与命名风格随现有代码);
   - GET /apps:请求头处算一次快照 `const metrics = electronApp().getAppMetrics()`,map 时传入;GET /apps/:id 同样传入;action 类响应(start/stop/enable/favorite/invoke)不传快照,保持原签名调用。
3. **host/src/main/management.ts**:`api(e, metrics?)` 加 `memoryMB`(broken 分支不加);`getApps` guard 算一次快照传入全部;`getApp` 单次快照传入。
4. **ui/src/types.ts**:`AppInfo` 加 `memoryMB?: number`。
5. **ui/src/mocks.ts**:mockApps 中挑一个 running 态 App 加 `memoryMB`(如 87),演示模式可见。
6. **ui/src/pages/apps.tsx**:
   - 详情元信息区加一行「内存」:运行中且 memoryMB 有值 → `${memoryMB} MB`,否则 `—`(复用详情区现有行结构与样式);
   - 新增独立轮询 effect:依赖 [detail?.id, detail?.status, busy];`detail?.status === "running" && !busy` 才起 setInterval(5_000),回调 `bridge.getApp(detail.id)` 成功且 alive 才 `setDetail`;绝不 `setSub(null)`、不触碰 busy;清理 clearInterval + alive=false。
7. **tests/host-contract.test.cjs**:bundle appMetrics.ts(照 sanitizeRestoredBounds 用例的打包跑法)覆盖:命中含四舍五入、pid undefined、未命中、脏条目跳过(缺 memory / workingSetMB 字符串 / pid 字符串)。
8. **spec**:.trellis/spec/mini-host/backend/platform-services.md 增 services/appMetrics 条目——按 pid 对号语义、每请求一次快照、边界(App helper 子进程不可见,只观测不回收)。
9. **验收后主会话**:docs/post-mvp-plan.md P2.5 实施记录。

闸门:npm test 全绿;cd ui && npx tsc --noEmit 干净;npm run build 后 npm run smoke 5/5。Bash 每条命令显式 cd 绝对路径。
