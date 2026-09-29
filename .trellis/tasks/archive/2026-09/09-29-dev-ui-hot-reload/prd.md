# dev 模式 UI 热更新（ui.devUrl）— P1.2

## Goal

App UI 的开发迭代速度对齐 main 进程（main 侧 edit→live 已实测 474ms，UI 侧却要重建产物重开窗口）：
manifest 声明 `ui.devUrl` 后，App 窗口在 dev server 可达时直接 `loadURL` 接 Vite HMR，
不可达自动回退打包产物——产线加载路径、CSP 机制、构建管线零改动。
来源：`docs/post-mvp-plan.md` P1.2（用户已批准的 roadmap）+ P1.1 遗留清理项。

## 确认事实（代码证据）

- 窗口加载收口在 `host/src/main/services/windows.ts` 的 `createWindow`（:110-130）：
  `ensureShellHtml` 写入 App dist 下的壳 html（`#root` + `./ui.js`）→ `win.loadFile(shell, { query: { __miniWindowId } })`
  → `ready-to-show` 才 show。`windowOptions` 固定 `show: false`（:23）——创建后到 load 完成前窗口不上屏，
  异步探测后决定加载目标不影响可见性。
- `__miniWindowId` 查询参数全仓只有生产方（windows.ts:125），无消费方——loadURL 时照抄该约定即可。
- 调用方全部同步取 windowId：`createAppWindow`（manager.ts:170 / launcher.ts:26 / management.ts:66 /
  controlChannel.ts:149）与 SDK 动态窗口 `createWindow`（dispatcher.ts:142）。
  **保持 createWindow 同步签名**（探测在内部 detached promise 里做），不加涟漪。
- App 窗口的 IPC 信任模型：归属靠 `trackWindow` 的 `appByWebContents` 注册（创建时、与 URL 无关），
  不走 controlPage 式 URL 校验——dev 源（http://localhost）加载后 preload 照常注入 `__miniHost`，
  SDK 桥可用；dev 页面是 App 作者自己的代码，信任等级与打包产物相同。
- manifest 校验：`host/src/main/manifest.ts` `parseManifest` 返回 `{ok, manifest?, errors[]}` 模式，
  新字段照该模式加校验。
- `mini dev`（cli/src/index.ts:180-208）：buildApp + ensureHost + start + fs.watch(src/, app.yaml)
  → rebuild + `mini reload`（200ms 防抖）。reload 只重建 runtime，不重建窗口——UI 热更本就要靠 HMR 而非 reload。
- P1.1 遗留：`host/src/preload/launcher.ts` 的 onError/onRefresh 注册 `ipcRenderer.on` 不返回退订；
  `ui/src/launcher/LauncherApp.tsx` 的 effect 无清理。生产包与演示模式不可达（StrictMode 双调仅 dev），
  但 P1.2 的 dev 语义落地后（含 ui/ 自身 vite dev 调试）会变成双监听——本任务一并修。
- 验收环境：仓库当前没有 React 模板 App（P1.3 才有），但 Vite dev server 对 vanilla html/js
  同样提供 <1s 热更新——用临时 demo App + scratch vite root 验证机制与体感，不留仓库垃圾。

## Requirements

- **R1 manifest**：`ui` 节新增可选 `devUrl`；`parseManifest` 校验：可选字符串、必须 `http://` 或
  `https://` 前缀，非法进 `errors[]`（中文文案，沿用现有风格）。
- **R2 窗口加载决策**（host 侧）：声明了 devUrl 的 App，其窗口创建时先探测 devUrl
  （fetch，短超时；任何 HTTP 响应即视为可达）——可达 → `loadURL(devUrl?__miniWindowId=…)`，
  不可达 → 现状 `loadFile` 产物 + `logHost` 提示一行。未声明 devUrl 的 App 走现状路径，零探测开销。
- **R3 mini dev 提示**：cmdDev 启动时若清单声明 devUrl，打印一行提示（dev server 未起时窗口回退产物；
  起/停 dev server 后通过重开窗口切换——reload 不重建窗口，这是既有语义）。
- **R4 契约测试**：manifest devUrl 校验用例 + 窗口加载目标解析（可达/不可达两分支）进
  `tests/host-contract.test.cjs`（node:test 现场编译模式）。
- **R5 P1.1 遗留清理**：`preload/launcher.ts` 的 onError/onRefresh 返回退订函数；
  `ui/src/launcher/bridge.ts` 与 `types.ts` 的 `LauncherBridge` 签名同步；
  `LauncherApp.tsx` 两个 effect 返回清理函数。
- **R6 文档**：`docs/post-mvp-plan.md` P1.2 节追加实施记录（同 P1.1 惯例）。

## Acceptance Criteria

- [ ] `mini validate`：带合法 devUrl 的清单通过；`devUrl: ftp://x` 之类被拒绝且错误文案中文可读。
- [ ] 真机：临时 demo App（`mini create devdemo --ui window` + manifest 加 devUrl 指向 scratch
  vite dev server）窗口显示 dev 页面；页面里调 `host.log.info` → 落 `logs/apps/devdemo.log`
  （证明 dev 源下 SDK 桥可用）。
- [ ] 真机：修改 scratch 页面文件 → 窗口内 <1 秒看到变化（Vite 热更）。
- [ ] 真机：关掉 dev server 再开窗口 → 回退产物正常显示 + host.log 有回退提示；未声明 devUrl 的
  App（如 hello）窗口行为不变。
- [ ] `npm test` 全绿（含新增 devUrl 契约用例）；ui tsc 干净；Launcher 面板真机回归正常（清理后）。
- [ ] 浏览器 vite dev 下反复开合 Launcher 页不再叠加 onError/onRefresh 监听（代码审查 + dev 目检）。

## Out of Scope

- `mini create --template react`（P1.3）；本任务不新增模板，devUrl 由 demo App 手工写入 manifest。
- 跨进程完整 HMR / main.ts 的热更（main 仍走 rebuild + reload 现状，roadmap 已定）。
- dev server 的生命周期管理（由开发者自起自停，mini 不代管）。
- 管理中心窗口的 devUrl（只做 App 窗口）。

## Open Questions

（无——机制、边界、验收均由 roadmap P1.2 原文确定；验收载体用临时 demo App 属实施细节，
记录于 implement.md。）
