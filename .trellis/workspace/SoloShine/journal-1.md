# Journal - SoloShine (Part 1)

> AI development session journal
> Started: 2026-09-28

---



## Session 1: Trellis 接入 + spec 引导 + P1.1 Launcher React 化
<!-- trellis-session: v=2 fp=cf8f370af886e9e1 -->

**Date**: 2026-09-29
**Task**: Trellis 接入 + spec 引导 + P1.1 Launcher React 化
**Package**: mini-host
**Branch**: `main`

### Summary

确认 trellis-bridge 生效后完成 bootstrap 任务:三包 spec 以真实代码重写(mini-host backend/frontend、mini-cli、sdk;guides 增 windows-pitfalls 与 testing-and-acceptance),删除不适用模板,提交 7671b98。随后 P1.1 Launcher React 化走完整 Trellis 流程:PRD/design/implement 三件套获批准,trellis-implement 实现 ui/ 第二遍 Vite 构建(iife)+ LauncherApp(分组/相关度/键盘/主题/演示模式),build.mjs 归一化抽函数逐页断言,host 侧冻结零改动;trellis-check PASS-with-nits(35/35 测试、回退演练、tsc 干净);真机热键唤起+搜索+状态保留实测通过(截图落 data/shots/)。P1.2 首项遗留:LauncherApp onError/onRefresh effect 需加清理(见任务 implement.md 实施记录)。

### Git Commits

| Hash | Message |
|------|---------|
| `7671b98` | chore(trellis): adopt Trellis workflow — bootstrap specs from real codebase |
| `f4400dd` | feat(ui): migrate Launcher palette to React (P1.1, post-mvp roadmap) |
| `89c488a` | docs(roadmap): record P1.1 launcher-react completion (f4400dd) |

### Status

[OK] **Completed**


## Session 2: P1.2 dev 模式 UI 热更新(ui.devUrl)
<!-- trellis-session: v=2 fp=fd5356edfa646bff -->

**Date**: 2026-09-29
**Task**: P1.2 dev 模式 UI 热更新(ui.devUrl)
**Package**: mini-host
**Branch**: `main`

### Summary

走完整 Trellis 流程落地 roadmap P1.2:三件套获批后 trellis-implement 实现manifest ui.devUrl(http/https 校验)与窗口创建时探测(fetch 400ms,任何响应即可达→loadURL 带 __miniWindowId,不可达回退产物+日志),决策函数独立 electron-free 的 services/devTarget.ts,未声明路径逐字不变;顺带闭环 P1.1 遗留(launcher preload onError/onRefresh 返回退订+LauncherApp effect 清理)。trellis-check PASS-with-nits,按其建议加固 detached promise 末尾 loadFile 的 try/catch(mid-load 销毁的 unhandled rejection 主进程致命);37/37 测试(35+2 新契约)。真机 CUA 实测:dev 页加载+桥接跨源落日志+秒级 Vite 热更+停 server 回退+hello/Launcher 回归全过;临时 demo App 验收后已清理。CUA 经验:Vite 整页 reload 会使截图目标失效,改用无障碍树文本验证。

### Git Commits

| Hash | Message |
|------|---------|
| `d2db390` | feat(host): dev-mode UI hot reload via manifest ui.devUrl (P1.2, post-mvp roadmap) |

### Status

[OK] **Completed**


## Session 3: P1.3 mini create 模板(minimal|react),UI 线收官
<!-- trellis-session: v=2 fp=8a65023aedb57b21 -->

**Date**: 2026-09-29
**Task**: P1.3 mini create 模板(minimal|react),UI 线收官
**Package**: mini-host
**Branch**: `main`

### Summary

走完整 Trellis 流程落地 roadmap P1.3:--template minimal|react(缺省 minimal 逐字节不变,旧版双实现机械比对);react 模板 React 19+Vite 7、app.yaml 声明 ui.devUrl:5174,vite 仅 dev server,生产 ui.js 统一 mini build esbuild(.tsx+jsx:automatic,对 roadmap 原文的偏移已获批);CLI 泛化(ui.tsx 入口、能力 lint 覆盖 tsx);create 内联 npm install。验收期修两真问题:react 模板误含 @mini/sdk 假依赖致 install 404;既有 host bug requireApp 不重扫陈旧 manifestIssues(带窗口新 App 立即 run 必误报缺产物,已自愈)。真机:minimal 681ms/react 5.7s 含 install 全周期,React 产物 UI+ping/pong+HMR+回退全过;41/41 测试。roadmap P1(UI 线)三项全部收官,下一步 P2 平台能力层五项。

### Git Commits

| Hash | Message |
|------|---------|
| `7930a73` | feat(cli): mini create --template minimal\|react (P1.3, post-mvp roadmap) |

### Status

[OK] **Completed**


## Session 4: P2.1 窗口几何持久化
<!-- trellis-session: v=2 fp=0563c6f3e24460b9 -->

**Date**: 2026-09-29
**Task**: P2.1 窗口几何持久化
**Package**: mini-host
**Branch**: `main`

### Summary

走完整 Trellis 流程落地 roadmap P2 首项:AppMeta.winBounds(DIP,moved/resized+500ms 防抖,最大化/最小化不写,win.destroy 不发 close 故不靠关闭钩子);恢复经 electron-free services/winBounds.ts 可见性校验(零相交回退默认+日志,部分越界钳回工作区,≥64×48 可见);仅 manifest 窗口持久化,SDK 动态窗口零变化。trellis-check PASS(六断言数学独立复算)。验收期修两真问题:①create→立即 mini run 竞态——controlChannel GET/POST 预检查 registry 缓存 404/TypeError,加 rescan 自愈(实测 462ms 一次成功);②Electron 跨 scale 显示器一次性 setBounds 宽高按 targetScale/primaryScale 缩放(480×320→320×213 实测),恢复拆先移动后 setSize 绕开。观测器教训:list-windows.ps1 是 DPI-unaware 虚拟化坐标(各屏物理÷该屏 scale),已连同跨屏 setBounds 怪癖记入 windows-pitfalls。真机五项全过:真实拖拽保存/同屏精确恢复/副屏恢复/过期坐标(5000,5000)回退+日志/最小化停启正常;44/44 测试、smoke 5/5。

### Git Commits

| Hash | Message |
|------|---------|
| `a1e49af` | feat(host): persist app window bounds across restarts (P2.1, post-mvp roadmap) |

### Status

[OK] **Completed**


## Session 5: P2.2 通知 onClick 交互化
<!-- trellis-session: v=2 fp=3127f26238a6f83a -->

**Date**: 2026-09-29
**Task**: P2.2 通知 onClick 交互化
**Package**: mini-host
**Branch**: `main`

### Summary

走完整 Trellis 流程落地 roadmap P2.2:host.notification.show 增加可选 clickCommand(必须为清单声明命令,show 时即校验,SDK 中文拒绝),点击按 invoke 全语义分发(自动启动/活跃/history)+ focusApp 唤起面板;分发回调 manager 注入(setNotificationClickDispatcher,setWindowActivityHook 同款破环),click 回调异常全吞;校验器抽 electron-free notificationClick.ts 契约测试三分支。验收载体用户定调 file-organizer 确定性流程(storage 预置 lastDir),不用连连看。真机:user 人肉点击双侧通过——File Organizer 通知点击→invoke show success(history 实录)+面板弹出;clipboard-tool 对照无副作用。经验:专注模式把 toast 横幅压成 0 高度窗口(无 a11y 内容),通知中心行 AXPress=展开非激活,toast 物理点击是唯一无法自动化的验收环节。45/45 测试、smoke 5/5、既有四 App 通知行为零差异。

### Git Commits

| Hash | Message |
|------|---------|
| `e115245` | feat(host): interactive notifications via clickCommand (P2.2, post-mvp roadmap) |

### Status

[OK] **Completed**


## Session 6: P2.3 会话恢复(默认关)实现与真机验收
<!-- trellis-session: v=2 fp=dbda6952ce1cfd94 -->

**Date**: 2026-09-30
**Task**: P2.3 会话恢复(默认关)实现与真机验收
**Package**: mini-host
**Branch**: `main`

### Summary

settings.restoreSession(默认关,旧文件自动迁移);initRuns() 返回本次标 interrupted 的 appId 作为恢复依据;manager.restoreInterrupted 串行 start、逐项 restored 伴随事件(不入 TERMINAL_KINDS)、不预检由 requireApp 判定;boot 在控制通道就绪后 fire-and-forget。测试 45→48,smoke 5/5(须先 npm run build)。真机三场景:强杀重启自动恢复(截图)、APP_DISABLED 单项失败不阻塞、关开关行为不变;恢复出的 run 正常落 stop 终态。P2 仅剩内存观测层(2.5)。

### Git Commits

| Hash | Message |
|------|---------|
| `fc50ccc` | feat(session): restore interrupted apps on boot behind restoreSession toggle (default off) |

### Status

[OK] **Completed**


## Session 7: P2.5 内存观测层实现与真机验收(P2 收官)
<!-- trellis-session: v=2 fp=d2bcbe67361394f5 -->

**Date**: 2026-09-30
**Task**: P2.5 内存观测层实现与真机验收(P2 收官)
**Package**: mini-host
**Branch**: `main`

### Summary

管理中心详情新增内存行(memoryMB,只观测):getAppMetrics 按 pid 对号,纯函数 appMetrics.ts 双形状兼容——验收期实测发现 Electron 44 ProcessMetric.memory 实为 { workingSetSize(KB), peakWorkingSetSize, privateBytes },旧文档 workingSetMB 形状不存在,合成数据契约测试曾测绿错误形状,修复为 KB→MB 换算;教训(对 Electron API 字段写契约前先实测真实返回)记入 platform-services.md。真机:运行中 86 MB 与 Get-Process 86.3MB 交叉核对一致,停止后显示 —;49/49 测试、ui tsc 干净、smoke 5/5。P0/P1/P2 全部收官,剩横切小项与 P3 按需。

### Git Commits

| Hash | Message |
|------|---------|
| `d7909d2` | feat(host): per-app memory observation in management detail (P2.5, closes P2) |

### Status

[OK] **Completed**
