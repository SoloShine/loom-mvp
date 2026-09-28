# MVP 验收记录(PRD §21 判卷单)

- 日期:2026-09-28
- 机器:Windows_NT 10.0.26200,Node v24.10.0,Electron 44.4.5,16 核 / 31 GB
- 显示器:主屏物理 3840×2160 @1.5(DIP 2560×1440)+ 副 1920×1200 @1.0(双屏混合 DPI)
- 证据目录:`data/acceptance/run-1790597070106`(TIMING/RB 明细 + topology)、`data/smoke/run-*`(冒烟)
- 复跑方式:`npm run accept`(计时 + 回退演练)、`npm run smoke`(五用例冒烟)、`npm test`(29 项)

## §21 验收指标逐条判定

| # | 指标 | 目标 | 实测 | 结论 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 1 | 创建 Mini App | ≤ 1 分钟 | `mini create` 78ms;create→build→run→首次 invoke 全链 1.03s | ✅ 达标 | acceptance/run-*/TIMING.json |
| 2 | coding agent 修改 → 生效 | ≤ 2 秒 | 5 连测:471 / 457 / 468 / 474 / 463 ms(最大 474ms) | ✅ 达标 | 同上 `editToLive` |
| 3 | 修改后不需要手工操作 Host | 无手工步骤 | 整个计时用例跑在同一 Host 实例上:零重启、零 GUI 操作,`mini reload` 自动重建过期产物 | ✅ 达标 | 同上 |
| 4 | Runtime Error 可通过 CLI 查看 | 可查看 | `mini logs`(含 --follow)已验;invoke 失败带错误码返回;管理面板红字日志为 GUI 侧补充 | ✅ 达标 | smoke S1/S5;手动清单 §一 |
| 5 | App Crash 不影响 Host | 不影响 | 外部强杀 App utilityProcess:Host 存活、状态转 crashed、终结事件恰好一条 | ✅ 达标 | smoke S2 |
| 6 | 外部 Python Helper 完整 start/stop/log | 完整生命周期 | helper 进程树 start/stop/log 已自动化验证(node helper,含超时强杀与清理);Python helper(连连看)在真实游戏上验证过 | ✅ 达标 | smoke S4;apps/lianliankan/README |
| 7 | Window / Floating / Overlay 全部可用 | 三种模式 | window ✅(hello/文件整理器等);floating ✅(连连看);**overlay 待真机确认** | ⚠ 部分已验 | 手动清单 §四(overlay 项) |
| 8 | Global Hotkey 可注册 | 可注册 | Host `Ctrl+Shift+M` + manifest 热键(连连看 `Ctrl+Shift+K`)均实测;冲突回退与释放有自动化覆盖 | ✅ 达标 | smoke 日志;手动清单 §一 |
| 9 | Screen / Mouse 可直接调用 | 可调用 | 连连看全流程(选区→识别→求解→点击)在真实游戏验证(2026-09-26/27) | ✅ 达标 | apps/lianliankan/README |
| 10 | **最高优先级:Coding Agent 除 OS 权限外无需操作 Host GUI** | 成立 | 本项目全部开发/验证工作(冒烟、计时、文件整理器端到端、UI 迁移验收)均由 agent 经 CLI + 文件完成,未操作 Host GUI | ✅ 达标 | 本记录全过程 |

## 汇总

- **9/10 达标,1 项部分已验**:overlay 窗口模式需要用户在真机确认(手动清单 §四,约 10 分钟)。
- 手动清单([docs/manual-test-checklist.md](manual-test-checklist.md))覆盖其余 GUI 项(文件选择器、多屏 DPI、托盘退出核验等),不属于 §21 硬指标。

## 回退演练(批次 R3)

| 演练项 | 结果 | 证据 |
| --- | --- | --- |
| legacy 数据 → 当前版本整机迁移 | ✅ 旧 registry 格式启动成功:禁用状态保留、生成恰好 1 份 `.bak` 迁移备份、迁移后 enable 可写、无崩溃 | acceptance/run-*/RB.json |
| 旧版本二进制读新数据 | **未验证**:仓库非 git、无旧二进制快照。数据面 schema 稳定(schemaVersion 1),旧版本兼容性以 `tests/host-contract.test.cjs` 的 legacy 迁移用例为准;发布前快照流程见批次 D 表格 | — |

## 未验证项清单(不隐藏)

1. overlay 窗口模式真机行为(§21 #7 的残余)。
2. 旧版本二进制读取新版本数据(见上表)。
3. Windows 10 真机(当前记录仅 Windows 11 26200;PRD 目标平台含 Win10)。
