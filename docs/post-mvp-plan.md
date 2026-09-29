# MVP 之后的设计规划

## 定位

MVP 已判卷(2026-09-28,9/10 §21 指标达标,见 `docs/acceptance-record.md`)。本文规划其后的设计路线,覆盖:UI 线收尾(`docs/mvp-acceptance-plan.md` 明确"另行安排"的部分)、平台能力第二层(由两个验收 App 的实际痛点反推)、生态雏形(按需)。它不推翻任何已定架构决策——Host 只提供基础设施、App 业务逻辑不下沉、PRD §18 非目标清单全部延续。

## 现状基线(2026-09-28,实施前已核实)

已完成且不再重复设计:宿主全服务 + 契约收口(files.move/storage/history)、双进程冒烟 R1、计时 harness R3、管理中心 React 版全功能接入(含主题、唤起、闲置回收策略层)、两个验收 App 达线、Launcher IPC sender 校验已落地(`host/src/main/launcher.ts` 的 `launcherSender`,`docs/host-next-phase-plan.md` 契约 1 的该项缺口已消除)。

已核实的缺口(即本规划的输入):

1. **Launcher 未迁移**:`ui/src/pages/` 仅 `apps.tsx`/`settings.tsx`;`host/dist/launcher` 仍是原生页。产品的门面(Ctrl+Shift+M 命令面板)与管理中心视觉断裂。
2. **dev 模式 UI 热更新未接线**:host 侧无 loadURL/devUrl 逻辑;main/runtime 修改已达标(474ms),但 UI 改动要手动重开窗口。
3. **`mini create` 单一最小模板**(`cli/src/create.ts`):四种 ui 类型共用一套 vanilla TS 模板,无技术栈变体。
4. **App 窗口几何无持久化**(`host/src/main/services/windows.ts` 无 bounds 落盘):重开回 manifest 默认尺寸;双屏用户每次拖到副屏都要重拖。
5. **通知仅展示**:`notification.show` 无点击行为;闲置回收、连连看求解完成等通知点不出任何东西。
6. **Host 重启不恢复会话**:运行中 App 在 Host 猝死/升级重启后一律标 interrupted,需手动逐个再启动。

收官挂起项(不阻塞本规划,但 P0 必须收口):手动清单未勾项(热键录制式回滚重测、文件整理器"移动去向"重测、副屏连连看/screen-inspector 复测)、三项未验证(overlay 真机、旧二进制读新数据、Win10 真机)。

## 阶段总览

| 阶段 | 内容 | 前置 | 规模 |
| --- | --- | --- | --- |
| P0 | MVP 收官:手动验收日 + 发布快照纪律 | 无 | 用户配合约半天 |
| P1 | UI 线收尾:Launcher React 化、dev UI 热更新、模板决策 | P0 可并行 | 约 2 天 |
| P2 | 平台能力第二层(5 项,各自独立) | P1 完成后逐项排 | 每项约半天 |
| P3 | 生态雏形:install 命令、两个实用 App | 按需,无硬依赖 | 按需 |

## P0:MVP 收官

1. **手动验收日**:按 `docs/manual-test-checklist.md` 逐项勾选;重点是三组复测——①多屏坐标修复后的副屏连连看选区/点击与 screen-inspector 副屏截图;②热键录制式输入改造后的设置页回滚;③文件整理器"移动去向"列表与通知文案。
2. **overlay 真机确认**:临时 overlay App 挂屏、置顶层级、失焦行为(§21 #7 最后残余)。
3. **发布快照纪律**:打 `v0.1.0-mvp` git tag + data 目录快照。acceptance-record 里"旧二进制读新数据未验证"源于当时无快照;仓库已是 git,此后每个功能批次结束打 tag,该死角自然消除。
4. **产出**:acceptance-record.md 终稿;未验证项要么补验、要么显式转为"已知限制"。

**P0 实施记录(2026-09-28 完成)**:用户手动验收日完成,清单全项闭环——副屏两项复测(连连看选区/点击、screen-inspector 两屏截图)、热键录制式回滚、文件整理器去向与通知、overlay 真机确认全部通过;§21 十条指标全部达标(acceptance-record.md 已更新为终稿)。发布快照落地:git tag `v0.1.0-mvp` + data 目录快照。剩余未验证项仅两项(旧二进制读新数据、Win10 真机),均已挂明去向。

## P1:UI 线收尾

### 1.1 Launcher React 化(最高优先)

- **复用管理中心已验证的管线**:`scripts/build.mjs` 双入口(management + launcher)分别产出拷贝;IIFE + `cssCodeSplit: false` + CSP 注入 + 无 ui/node_modules 时回退旧原生页(回滚 = 删依赖重建),全部机制原样照搬,零新架构。
- **交互设计**(Raycast 式):置顶搜索框常驻焦点、↑↓ 选择 + Enter 启动、Esc 隐藏(隐藏 = `hideApp` 语义,不销毁);收藏/最近使用分组,搜索时相关度优先;禁用/broken 项保持过滤(现状语义不变)。
- **通道不变**:preload 桥沿用 `mini:launcher:*` 现有五条消息;`ui/src/mocks.ts` 补 Launcher 假数据以支持纯浏览器开发。
- **验收**:fuzzy 搜索命中与排序、暗/亮主题、真机热键唤起体感 <300ms、回退路径可用。

**实施记录(2026-09-28 完成,commit f4400dd,Trellis 任务 09-28-launcher-react)**:ui/ 第二遍 Vite 构建(`vite.config.launcher.ts`,Rollup iife 不支持多入口故两遍)→ `build.mjs` 归一化抽 `normalizeHtml()` 逐页断言 → `host/dist/launcher/index.html`;交互按本节原文落地(分组/相关度/键盘/错误条/演示模式/主题复用)。host 侧零改动(preload、主进程、原生回退页冻结)。闸门:`npm test` 35/35、回退演练过、ui tsc 干净;真机热键唤起、搜索过滤、状态保留(hideApp 语义)已实测。遗留:P1.2 需先给 LauncherApp 的 onError/onRefresh effect 加清理(dev 热更下会双监听,见任务 implement.md)。

### 1.2 dev 模式 UI 热更新

- **设计**:manifest `ui` 节新增可选 `devUrl`;`mini dev` 检测到 devUrl 且该地址可达 → App 窗口 `loadURL(devUrl)` 而非加载打包文件;dev server 不在 → 自动回退产物并在日志提示。产线路径完全不动。
- **边界**:只服务本机开发;file:// 产线 IIFE 机制、CSP 不变;不做跨进程完整 HMR(PRD §14 的态度:没必要为 HMR 把架构搞复杂——Vite 自身的 HMR 已覆盖 UI 局部刷新,main/runtime 仍是 reload 语义)。
- **验收**:改一个 React App 的 tsx,窗口内 <1 秒看到变化;关掉 dev server 后窗口回退到产物且不白屏。

**P1.2 实施记录(2026-09-29 完成,Trellis 任务 09-29-dev-ui-hot-reload)**:manifest `ui.devUrl`(必须 http(s) 地址)落地;窗口创建时探测(fetch 400ms,任何响应即可达),可达 `loadURL` 接 Vite 热更、不可达回退产物并记日志,loadURL 半路失败也 catch 回退(窗口永不白屏);决策函数独立在 `host/src/main/services/devTarget.ts`(electron-free,可契约测试),未声明 devUrl 的路径行为不变;preload launcher 桥 onError/onRefresh 返回退订(P1.1 遗留清理完成);`mini dev` 起动时打印 devUrl 提示。闸门:`npm test` 37/37(含 devUrl 校验与 resolveDevTarget 三分支用例);真机实测 dev 页加载、SDK 桥经 dev 源落日志、改文件秒级热更、停 server 回退产物。

### 1.3 `mini create` 模板决策

- **建议**:`mini create <id> [--template minimal|react]`,默认 minimal 保持 PRD §13 的「30 秒 Hello World」承诺。
- **react 模板**:App 自带 vite + React(与管理中心同栈),`app.yaml` 声明 `ui.devUrl`、build 脚本产 IIFE 产物。理由:管理中心迁移后,外部 Agent 生成 React App 的语料远比内嵌 ui.ts 字符串充足;复杂 UI 的 App(面板类)收益立现。
- **边界**:Host 构建管线只认 esbuild 产物 `dist/main.js`,react 模板的 UI 构建是 App 自有 package.json 的事,Host 不加任何特例。
- **验收**:两条模板各自 create → run → invoke ping <30 秒;react 模板样例过 `mini validate`。

**P1.3 实施记录(2026-09-29 完成,Trellis 任务 09-29-create-templates)**:`mini create --template minimal|react` 落地(缺省 minimal,输出经旧版双实现比对逐字节一致);react 模板 = React 19 + Vite 7(app.yaml 声明 ui.devUrl:5174,vite 仅 dev server),生产 ui.js 统一走 mini build 的 esbuild(ui 入口接受 .tsx + jsx:automatic,能力 lint 覆盖 .tsx)——与 roadmap「App 自有 build 脚本产 IIFE」的偏移及理由见任务 design.md 取舍表。create 内联 npm install(npmmirror)。验收期修两真问题:react 模板误含 @mini/sdk 假依赖致 install 404;既有 bug requireApp 不重扫陈旧 manifestIssues(带 ui 的新 App 立即 run 必误报,已自愈)。真机:minimal 681ms / react 5.7s(含 install) 全周期,React 产物 UI + HMR + 回退全过。UI 线(P1)至此收官。

## P2:平台能力第二层

每项独立交付,按痛点排序;均给验收信号,不预支实现细节以外的承诺。

### 2.1 窗口几何持久化(双屏用户最高频痛点)

- **设计**:`host-state.json` 增 per-App `windowBounds` 节;窗口关闭/隐藏时记录,创建/show 时恢复;恢复前校验与现存显示器相交,不相交(拔屏/改布局)回 manifest 默认;坐标沿用现有 DIP 口径与 `physicalRect` 校验。
- **归属**:窗口由 Host 创建,几何归 Host 管——存 host-state 而非 App storage,App 卸载无残留。
- **验收**:App 拖到副屏 → 停止 → 重开,位置尺寸不变;拔掉副屏后重开不丢窗口、不出负坐标异常。

### 2.2 通知交互化

- **设计**:Electron Notification 的 click 事件接线;SDK `host.notification.show` 增加可选 onClick 回调,Host 侧映射为向该 App 分发一个 manifest 声明的命令(如 `on-notification-click`);未声明则维持纯展示。语义与 invoke 一致(计入活跃、可日志追踪)。
- **验收**:连连看求解完成通知点击 → 面板唤起(focusApp 语义);未声明命令的 App 点击无副作用。

### 2.3 会话恢复(默认关)

- **设计**:设置页「启动时恢复上次运行的 App」开关(默认关);依据 = 启动时被标 interrupted 的 active 记录,boot 完成后逐个重新 start;单项失败不阻塞其余,结果进日志与 history(新事件 `restored`)。
- **验收**:开开关 → 启动两个 App → taskkill Host → 重启,两 App 自动回来且各有一条 restored 事件;关开关行为不变。

### 2.4 截图落盘通道(只挂重评估条件,本轮不实现)

- 旧决策:不新增 Host bytes/stream API,截图 dataURL 由 App 自有 helper 解码落盘。该方案从未实证。
- **决策**:维持旧决策,在 P3 的 screenshot-notes App 中实证 helper 模式;仅当出现第二个截图类 App 且 helper 模式被证明繁琐时,才重新评估 `screen.captureRegion` 增加 `saveTo` 选项(Host 直接写用户选定目录;`files.write` 的文本语义仍不动)。

### 2.5 内存观测层(数据说话)

- **设计**:管理中心 App 详情显示 utilityProcess 当前内存(`app.getAppMetrics()` 按 pid 对号);只观测不回收。闲置回收已解决"隐式常驻",运行中 App 的内存增长先积累数据,再决定是否需要上限回收(预期多数情况不需要)。

## P3:生态雏形(按需)

1. **`mini install <目录>`**:拷贝目录进 apps/ → validate → enable。只是省去手工拷贝,不是商店(PRD §18 边界内):无 registry、无版本管理、无远端。
2. **两个实用化示例 App**:`clipboard-snippets`(回应"clipboard-tool 看不懂有什么用"——片段保存/检索/模板粘贴,manifest hotkey 唤起,日志不记正文)+ `screenshot-notes`(截图备注导出,兼作 2.4 的 helper 模式实证)。
3. **App 分享约定**(可选):App 目录 README 的自描述格式(依赖、权限、helper 需求、已知限制),让"把 App 目录发给另一台机器装上"有章可循。
4. **file-organizer 专项重设计**(用户点名,2026-09-28 P0 验收反馈):「说是归档,但没说如何归档、精细化配置等」。专项内容:明确归档语义(移动/复制/归档目录结构的定义与取舍)、精细化规则配置(自定义分类与目标、按文件名/大小/时间多条件、例外清单)、去向可解释性。重设计不回退既有安全边界(不覆盖、拒跨卷、只动顶层普通文件)。

## 横切:稳定性与运维

- **Win10 真机**:借机器或虚拟机过一遍手动清单 §一/§三/§四,结果补进 acceptance-record(PRD 目标平台含 Win10,当前记录仅 Win11 26200)。
- **tag 纪律**:每功能批次结束打 tag + data 快照,保持"旧二进制可比对"状态。
- **Host 自身观测**:管理中心关于区域显示 Host 运行时长/重启次数(成本低,长期驻存的排查价值高)。

## 明确不做(延续 PRD §18 与前两轮非目标)

Plugin Store/账号/云同步/自动更新/AI Chat/内置 Coding Agent/远程控制/多人协作/商业分发/跨平台;强制权限沙箱;数据库迁移;通用 bytes/stream API(除非 2.4 的重评估条件触发);业务逻辑下沉 Host;Launcher/管理的远程访问。

## 顺序与理由

P0 与 P1 的 1.1 无依赖,可并行(P0 需要用户配合,1.1 可由 Agent 先行起草)。P1 → P2:P2 的痛点清单以 UI 线结束后的真实使用为最终确认。P2 各项按用户痛点即时排序交付,不设批次墙。P3 仅在用户提出实际需求时启动。
