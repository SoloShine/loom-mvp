# 执行计划 — dev 模式 UI 热更新（ui.devUrl）

前置：无（不新增依赖；探测用 Node 内置 fetch）。

## 步骤 1：manifest 契约 + 窗口加载决策（host 侧）

- [ ] `host/src/main/manifest.ts`：`UiDef.devUrl?: string` + parseManifest 校验
      （存在即必须是 http(s) 字符串，错误文案 `ui.devUrl 非法(需 http/https 地址): …`）
- [ ] `host/src/main/services/windows.ts`：
      - 导出 `resolveDevTarget(devUrl, probe?)`（默认 probe = fetch+400ms timeout，任何响应即可达）
      - `createWindow` 接 design.md 的 detached-promise 流程（loadURL 带 `__miniWindowId`；
        loadURL reject 时 catch 回退 loadFile + 日志；未声明 devUrl 走现状路径）
- [ ] `host/src/preload/launcher.ts`：onError/onRefresh 返回退订函数
- 验证：`npm run build`（tsc 闸门）

## 步骤 2：ui/ 清理 + CLI 提示

- [ ] `ui/src/types.ts` LauncherBridge 签名（onError/onRefresh → `() => void`）
- [ ] `ui/src/launcher/bridge.ts` 透传退订；`ui/src/launcher/LauncherApp.tsx`
      两个 effect 返回清理函数
- [ ] `cli/src/index.ts` cmdDev：devUrl 提示行
- 验证：`cd ui && npx tsc --noEmit`；`npx vite build -c vite.config.launcher.ts` 成功

## 步骤 3：契约测试

- [ ] `tests/host-contract.test.cjs` 新增：
      ① manifest devUrl 合法/非法（scheme 与类型）用例；
      ② `resolveDevTarget` 三分支（注入假 probe：可达/不可达/未声明）
- 验证：`npm test` 全绿（基线 35 + 新增）

## 步骤 4：真机验收（用户配合，脚本见下）✅ 2026-09-29 完成(主会话 CUA 实测)

- [x] 造 demo：`node cli/dist/mini.js create devdemo --ui window` →
      `apps/devdemo/app.yaml` 的 ui 节加 `devUrl: http://localhost:5173`
- [x] scratch dev server：`data/devdemo-ui/` 放 `index.html`（调 `host.log.info` 的按钮），
      `npx vite --root data/devdemo-ui --port 5173`（vite 用 `ui/node_modules/.bin/vite`）
- [x] `mini run devdemo`：窗口显示 dev 页 → 点按钮 → `logs/apps/devdemo.log` 出现记录
- [x] 改 `index.html` 保存 → 窗口 <1s 更新（Vite 热更）
- [x] 停 dev server → 重开 devdemo 窗口 → 回退产物 + host.log 回退提示
- [x] Launcher 面板回归（热键唤起/搜索/启动）；管理中心正常
- [x] 清理：删 devdemo 临时产物、停 scratch server；`docs/post-mvp-plan.md` P1.2 追加实施记录
- 风险文件：`host/src/main/services/windows.ts`（窗口创建主路径——保持未声明 devUrl 分支
  逐字不变是回归底线）、`host/src/main/manifest.ts`（契约面，校验只增不改）。

## 回滚点

- 步骤 1-3 全部可用 git checkout 逐文件回退；manifest 新字段不影响旧清单。
- 步骤 4 的 demo 是临时产物，删目录即净。

## task.py start 前检查

- [x] implement.jsonl / check.jsonl 已填真实条目
- [x] prd.md 收敛通过（无 Open Question、无重复段落）
- [x] 用户已明确批准本规划摘要

## 实施记录（2026-09-29 完成）

- 实现（trellis-implement）+ 检查（trellis-check PASS-with-nits）+ 主会话按检查建议加固
  （detached promise 末尾 loadFile 包 try/catch，防 mid-load 销毁的 unhandled rejection）。
  闸门：`npm run build` 过、ui tsc 干净、`npm test` 37/37（35 基线 + 2 新契约用例）。
- 与设计偏差（均合理）：resolveDevTarget 独立成 electron-free 模块 services/devTarget.ts
  （契约测试免 stub）；detached 块内两处 isDestroyed 守卫（探测 400ms 窗口期可被 stop/关窗竞速）；
  loadURL 失败日志用 warn 级。
- 真机实测（截图在 data/shots/）：devdemo 窗口加载 `http://localhost:5173/?__miniWindowId=win-1`
  （host.log 有 `[vite] connected`）；dev 页点击按钮 → host.log.info 落
  `logs/apps/devdemo.log`（dev 源下 SDK 桥可用）；改 index.html v1→v2 秒级生效
  （无障碍树读到 v2 文本，Vite 整页 reload 会使 CUA 截图目标短暂失效，属预期）；
  停 vite 后重建窗口回退 `file://…dist/index.html?__miniWindowId=win-2` + host.log
  `devUrl 不可达,回退产物`；hello（未声明 devUrl）路径不变；Launcher 面板回归正常。
- 已知显示层小坑（不影响功能）：Git Bash 控制台 grep 中文日志显示乱码（编码问题，日志文件本身 UTF-8）。
