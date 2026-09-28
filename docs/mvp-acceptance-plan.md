# MVP 收官设计:发布回归与契约收口(UI 线之外)

## 定位与已验证基线

本文覆盖 UI 线(管理中心 React 化,已完成接入)之外的全部 MVP 收尾工作,对应 `docs/host-next-phase-plan.md` 的批次 D,并把该计划中遗留的契约缺口一并收口。目标只有一个:**对照 `docs/loom-mvp-prd.md` §21 逐条给出"已验证/未验证"的证据链,拿到 MVP 验收结论**。

已验证基线(2026-09-28,本设计的前提,不重复实施):

- 两个验收 App 均达线:连连看完全体;文件整理器 v0.2.0 目录级整理 + dry-run + 冲突保护,CLI 端到端实测通过(2026-09-27)。
- Host 契约:严格 CSP(产物含 React 版管理页)、disabled/broken DTO、退出协调器、history 稳定 eventId 去重与 cursor 分页(`host/src/main/history.ts:29,93-113`)、日志设置即时生效、热键所有权统一。
- 测试 18/18(`tests/`:cli 契约、host 契约、state 迁移、file-organizer 业务)。
- 手动验收清单已沉淀:`docs/manual-test-checklist.md`(含 PRD §21 对照表)。

## 实施前核实的缺口(均为本设计要消除项)

1. **`scripts/smoke-host.cjs` 不存在**。批次 A 明确"实现前门槛:双进程 smoke,脚本不存在即门槛未通过"。当前 18 个测试全部是模块级契约,没有任何"拉起真实 Electron → 断言进程树/事件文件 → 重启恢复"的端到端用例。
2. **`files.move` 跨卷回退会静默覆盖目标**(`host/src/main/services/core.ts:30-40`):`renameSync` 失败即 `cpSync + rmSync`——`cpSync` 默认覆盖已存在目标,复制中断则源已被删。文件整理器在 App 层拒了跨卷,但 Host 原语本身不安全,任何新 App 都可能踩中。
3. **`storage.set` 先改缓存后写盘**(`core.ts:85-88`,写入在 `saveStore` 75-80):写盘失败时内存与磁盘永久分叉;`loadStore` 对坏 JSON 静默置 `{}`(`core.ts:62-71`),用户数据无声清零。
4. **history 终态去重无界读**(`history.ts` 的 `hasTerminal` 与 `initRuns` 终态集合):设计文档最初误记"query 全量读文件"——核实后 query 本就是尾部 1 MiB 窗口读(设计语义:只保证尾部可查);真正每次全量读的是终态去重路径(每次终结事件追加、每次启动恢复都 O(整个文件) 内存)。
5. **PRD §21 计时指标从未实测**:`mini create ≤1 分钟`、`修改 → 生效 ≤2 秒`目标值无任何计时记录(`mini create`/`cmdDev` 已实现,`cli/src/index.ts:273,180`)。
6. **overlay 窗口模式无真机记录**(`host/src/main/services/windows.ts:36` 有代码路径)。

## 主线一:双进程冒烟脚本 `scripts/smoke-host.cjs`

隔离优先:每个用例独立的临时 `MINI_ROOT / MINI_DATA_DIR / MINI_APPS_DIR`,断言对象是文件(active-runs.json、history.jsonl)与进程树,不碰用户真实数据。拉起 Electron 用 `spawn(electron, ["host"])`,**不加 `windowsHide`**(已证会毒化窗口可见性)。

| 用例 | 步骤 | 断言 |
| --- | --- | --- |
| S1 正常启停 | 启动 Host → 等 `data/runtime.json` → `mini list` 在线通过 → `mini invoke hello selftest` → `mini stop` → 杀 Host 进程树 | 两进程退出码;selftest 结果 ok;无孤儿 node/python 进程 |
| S2 App 崩溃隔离 | 启动 hello → 从外部 kill 其 utilityProcess → 继续调 `mini list` 与另一个 App 的 invoke | Host 存活;crash 状态;history 恰好一条 crash 终结事件 |
| S3 Host 猝死后恢复 | 启动 App(不清 active)→ `taskkill /F` 整树杀 Host → 重启 Host | 重启后 active run 恢复为唯一 `interrupted`;同 runId 不产生第二条终结事件;App 可再次启动 |
| S4 stop 卡死强杀 | 注册一个 spawn 后挂住不退的假 helper 的临时 App → `mini stop` 超时路径 | stop 返回超时错误而非假成功;helper 树被强杀;`SHUTDOWN_INCOMPLETE` 可观测 |
| S5 产物一致性 | `mini build` 后改动源码 → `mini reload` | 过期产物自动重建,`mini validate` 通过 |

实现约束:纯 Node(不用 Electron API),单文件,`--case S1` 可单跑,默认全跑;每用例输出 JSON(`{case, ok, ms, evidence: {exitCodes, historyLines, activeSnapshot}}`)并落 `data/smoke/` 证据目录;总退出码非 0 即失败。完成后接入 `npm test` 之外的独立入口 `npm run smoke`(不进 CI 常规路径,因为要拉真 Electron)。

**实施记录(2026-09-28,R1 完成)**:S1~S5 全部通过(`npm run smoke`,证据在 `data/smoke/run-*`),测试保持 18/18。冒烟实例用独立 `--user-data-dir` 隔离单实例锁,可与用户真实 Host 并行运行。过程中**发现并修复一个真实缺陷**:active-runs 与 start 事件里的 `pid` 恒为 0(`utilityProcess.pid` 在 fork 时未就绪)→ `history.updateRunPid` + manager 的 spawn 事件回填,S2 对该修复做回归断言(pid 为 0 直接失败)。排查中排除两处假警报:PowerShell 进程查询的自匹配造成的"helper 泄漏"假象(强制停止路径实际健康:utility 被杀、cleanup 执行、错误语义正确、可重试),以及 `taskkill /F` 退出码 1 被误读为 Host 崩溃。

## 主线二:契约缺口收口

**C1 `files.move` 默认不覆盖**。目标存在 → 直接报错(不 rename 不 copy);跨卷(判定保留 `path.parse().root` 比较)→ 改为「copy 到同卷临时名 → 尺寸校验 → rename 就位 → 删源」,任一步失败保源并清理临时文件。`copy` 同理补「目标存在即错」。测试:同卷移动、目标冲突、模拟跨卷(把跨卷判定抽成可注入参数,不必真造第二块卷)、复制中断注入(`cpSync` 抛错)、源为目录。**App 层 `apps/file-organizer` 的 same-volume 预检保留**(防御纵深),Host 修好后可简化但不强求。

**C2 storage 一致性**。写序反转为「临时文件 + rename 成功 → 再更新内存 cache」;`loadStore` 遇坏 JSON 不再静默 `{}`,改为把坏文件改名为 `.corrupt-<ts>` 留证 + 返回空表 + 每次 get 打 `log.warn`(数据不再无声丢失)。测试:写失败注入(把目录置只读)、坏 JSON 恢复、并发 set 串行性(现有单进程模型下即 cache 一致)。

**C3 history 有界扫描**。核实修正:query 已是尾部 1 MiB 窗口读(保持不动,窗口语义不变);改为 `hasTerminal` 与 `initRuns` 的终态去重走 **反向分块流式扫描**(`scanHistoryBackward`:1 MiB 块回读、字节级按 LF 切行防多字节 UTF-8 跨块截断、visit 返回 true 提前终止、内存 O(chunk))。initRuns 只需要 active runId 的终态,找到全部即停。测试:3 万行(≈3.3 MB)文件上埋最老一行终态(强制全量反向扫)验证找到/不存在时终止/去重不追加/initRuns 恢复幂等;小文件(<1 MiB)验证 query 全量分页正确性,大文件验证尾窗口内 newest-first 与游标链。

**C4 overlay 真机项**。不新增自动化,并入 `docs/manual-test-checklist.md` 第四节:临时 overlay App 挂屏、置顶层级、失焦行为、多屏拖动。

## 主线三:PRD §21 验收计时与发布记录

**计时 harness `scripts/acceptance-timing.cjs`**(隔离数据目录,跑真实 CLI):

1. `mini create <临时id>` 全流程计时 → 对照 ≤1 分钟;
2. 模板源码改动 → `mini reload` → `mini invoke <id> <探针命令>` 返回新值的端到端耗时,连测 5 次取最大 → 对照 ≤2 秒;
3. `mini run` 冷启动耗时与 `mini dev` 可用性记录(仅记录,无 PRD 目标值)。

结果追加写入 `docs/acceptance-record.md`:每条 PRD §21 指标一行,列「命令全文 / 退出码 / 实测值 / 目标值 / 证据路径 / 结论」,连同机器拓扑(型号、Windows 版本、双屏 DPI、Electron/Node/Python 版本)。该文件就是 MVP 的验收判卷单,与手动清单互为引用:自动化能证的在 harness 里证,只有 GUI 能证的对着手动清单逐条勾。

**回退演练**(一次性,记录进 acceptance-record):以当前 dist 为"旧版本",用隔离目录跑一次新数据写入,再把数据目录交给旧版本二进制启动,断言只读兼容(active/history/schema 迁移不炸、不回写新字段)。现有 state 迁移测试已覆盖单模块,此处补的是整机级演练。

## 分批实施与验收

| 批次 | 内容 | 完成判据 |
| --- | --- | --- |
| R1 | `scripts/smoke-host.cjs` 五用例 + `npm run smoke` 入口 | 全用例在隔离目录通过;S2/S3 的 history 断言有证据文件 |
| R2 | C1/C2/C3 收口 + 单元测试 | 新增测试全绿;`npm test` 总量 ≥26;未跑的失败注入不标过 |
| R3 | 计时 harness + acceptance-record.md + 回退演练 | §21 每条指标要么有实测证据,要么在手动清单挂"未验证";无悬空项 |
| R4 | 用户真机日:手动清单执行(含 overlay、多屏 DPI、托盘退出核验) | 清单全勾或挂明原因 |

顺序依赖:R1 → R2 → R3 → R4(R2 的修改需要 R1 的端到端兜底先就位);R3 可与 R2 并行起草。

## 实施记录

**R1(2026-09-28 完成)**:五用例全绿,证据在 `data/smoke/run-*`;详见该节末尾的实施记录段落。

**R2(2026-09-28 完成)**,测试 18 → 29 全绿,host/cli/sdk `tsc --noEmit` 通过,五用例冒烟复跑通过:

- C1:`files.copy/move` 默认不覆盖(`E_EXISTS`);move 同卷 rename 失败即报错(不再静默转复制——旧回退会覆盖目标且复制中断丢源);跨卷走「copy 到同卷临时名 → 尺寸校验 → rename 就位 → 删源」,失败保源清临时;`sameVolume` 判定可注入供测试。
- C2:`storage.set/delete` 改为先写盘(tmp+rename)成功、再更新内存 cache;坏 JSON/非对象 JSON 不再静默清零,改为改名 `.corrupt-<ts>` 留证 + logHost 警告 + 空表起步。故障注入:tmp 路径置同名目录使写盘抛 EISDIR,断言内存/磁盘保持旧值,恢复后可用。
- C3:新增 `scanHistoryBackward`(1 MiB 反向分块、字节级切行、早停),`hasTerminal` 与 `initRuns` 终态去重接入;query 尾窗口语义未动。3 万行夹具验证:埋最老一行的终态可找到、不存在时正常终止、去重不追加、initRuns 恢复幂等(二次启动不重复 interrupted)。
- 兼容性:`files.move` 的同卷 rename 失败从"静默 copy+rm"变为报错——文件整理器 App 层预检(拒绝跨卷、拒绝已存在目标)语义不变;SDK 签名不变(可选第三参仅测试注入用)。

**R3(2026-09-28 完成)**:`scripts/acceptance-timing.cjs`(`npm run accept`)两用例通过,结果判卷进 `docs/acceptance-record.md`:

- TIMING:create 78ms、create→首次 invoke 1.03s(目标 ≤1 分钟 ✅);修改→生效 5 连测最大 474ms(目标 ≤2 秒 ✅,全程同一 Host 实例零手工操作);`mini run` 冷启动 202ms;`mini dev` watcher 可用、重建 195ms。探针用模板 `ping` 注入版本化字段(注意:`mini invoke` 只允许 manifest.commands 里声明的命令,`greet` 未声明会被拒绝——第一版脚本因此踩坑)。
- RB 回退演练:legacy registry 整机迁移通过(禁用状态保留、恰好 1 份 .bak、迁移后 enable 可写);"旧二进制读新数据"如实标注未验证(非 git、无旧快照)。
- 判卷结论:§21 十条指标 9 条达标,overlay 真机确认挂入 R4 手动日;未验证项(overlay、旧二进制、Win10 真机)在记录中显式列出。

## 明确非目标

不做:数据库/SQLite 迁移、App 商店与分发、自动更新、强制权限沙箱、跨平台、Launcher React 化与 dev 模式 HMR(属 UI 线,另行安排)、`mini create` 模板换栈(PRD §13 保持最小模板;模板现代化随 UI 线决策)。

规模估计:R1 约一天,R2 约一天,R3 约半天,R4 需要用户半天配合。
