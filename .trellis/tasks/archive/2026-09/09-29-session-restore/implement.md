# P2.3 实施清单

按依赖顺序;1~4 为 host 侧,5~7 为 ui 侧,8~9 为测试,10~11 为文档。

1. **host/src/main/state.ts**:Settings 加顶层 `restoreSession: boolean`;defaults 加 `restoreSession: false`;validSettings 加 `typeof s.restoreSession === "boolean"`;normalizeSettings 加缺字段补 false(与 recycle 字段同款)。
2. **host/src/main/history.ts**:HistoryEvent 的 kind 联合加 `"restored"`;initRuns 在补 interrupted 处收集 appId(数组保序 + Set 去重),签名改 `initRuns(): string[]`;TERMINAL_KINDS 不动。确认惰性调用点忽略返回值即可。
3. **host/src/main/runtime/manager.ts**:新导出 `restoreInterrupted(ids: string[]): Promise<void>`——开头 `if (!ids.length || !state.settings().restoreSession) return;`;for-of 串行:`if (draining) break;` try { await start(id); history.event({ appId: id, kind: "restored", outcome: "success" }); logHost("info", ...) } catch (e) { history.event({ appId: id, kind: "restored", outcome: "failure", message: String(e?.message ?? e) }); logHost("warn", ...) }。确认 state/settings 的 import(manager 现用 recordUse,按现有 import 风格补)。
4. **host/src/main/index.ts** boot():`const interruptedApps = history.initRuns();`;末尾改 `return startControlChannel().then(() => { void manager.restoreInterrupted(interruptedApps); });`。
5. **ui/src/types.ts**:HostSettings 加 `restoreSession: boolean`。
6. **ui/src/mocks.ts**:mockSettings 加 `restoreSession: false`。
7. **ui/src/pages/settings.tsx**:新增 state restoreSession;getSettings 回填;save 的 patch 带上;保存成功后从 fresh 回填;「常规」卡新增一行——标题「启动时恢复上次运行的 App」,说明「Host 意外退出后,下次启动自动拉起当时运行中的 App;正常关闭不恢复」,右侧 Switch(复用现有 Switch 组件,aria-label 同名)。
8. **tests/core-fs.test.cjs**:按 design 测试计划补 initRuns 返回值与 restored 事件用例(bundle 跑法照抄现有 initRuns 用例)。
9. **tests/host-contract.test.cjs**:settings 迁移/校验用例(照抄 winBounds 用例的 bundle 模式)。
10. **spec 更新**:manifest-and-lifecycle.md 补 restored 事件与恢复语义(事件清单、initRuns 返回值、boot 接线点);如该文件有 settings 字段清单则同步。
11. **验收后**:docs/post-mvp-plan.md P2.3 实施记录(照 P2.1/P2.2 格式)。

闸门:npm test 全绿、cd ui && npx tsc --noEmit 干净、smoke 通过;真机验收按 PRD 验收标准 1~4 由主会话执行。
