# 执行计划 — Launcher React 化

前置：`cd ui && npm install --registry=https://registry.npmmirror.com`
（`ui/node_modules` 缺失时；本机必须用 mirror，主源吐损坏 tarball）。

## 步骤 1：ui/ 侧源码（纯新增，不接 host，可独立验证）✅ 2026-09-28 完成

- [x] `ui/src/lib/fuzzy.ts`：`score()` 从 `host/src/launcher/ui.ts` 平移，保持
      "子串命中 > 子序列"语义与排序权重（收藏 > lastUsedAt）
- [x] `ui/src/types.ts`：`LauncherAppInfo`（id/name/version/status/favorite/lastUsedAt/commands）
      与 `LauncherBridge` 契约类型
- [x] `ui/src/launcher/bridge.ts`：`window.__launcher ?? mock`，`demoMode` 导出
      （结构同构 `lib/bridge.ts`；错误清洗不需要 errorMessage——launcher 无 invoke 拒绝包装）
- [x] `ui/src/mocks.ts`：launcher 假数据 ≥4 App（覆盖 favorite / 近期使用 / 多命令 / 无命令）
- [x] `ui/src/launcher/LauncherApp.tsx`：搜索框（常驻焦点）+ 无查询分组
      （收藏/最近/全部）+ 查询态相关度列表 + active 高亮滚动 + 错误条 + 底部 hint
- [x] `ui/src/launcher/main.tsx` + `ui/launcher.html` + `ui/vite.config.launcher.ts`
      （initTheme 先于 render；outDir dist-launcher；iife 约束齐全）
- 验证：`cd ui && npx vite build -c vite.config.launcher.ts` 成功且产物为经典脚本 +
  外链 CSS；`npx vite` 开发服打开 `/launcher.html`（演示模式全功能可点）。

## 步骤 2：build.mjs 接线（唯一触碰 host 产物路径的步骤）✅ 2026-09-28 完成

- [x] 抽 `normalizeHtml(page, html)`（现 management 分支的三段替换 + 断言原样搬入）
- [x] pass 2：spawn `vite build -c vite.config.launcher.ts`；`ui/dist-launcher` →
      `host/dist/launcher`（react 可用时）；两页逐页 normalize + 断言
- [x] 回退路径不动：`reactManagement === false` 时既有原生 for 循环继续覆盖两页
- 验证：
  - `npm run build` → 检查 `host/dist/launcher/index.html`（无 `type="module"`、含 CSP meta、
    script defer）与 `host/dist/management/index.html`（同标准，确认未回归）
  - 临时改名 `ui/node_modules` 再跑 `npm run build` → 两页均为原生产物；改回
  - `npm test`（host-contract CSP 契约断言绿）

## 步骤 3：真机验收（用户配合项）

- [ ] `npm run host`：Ctrl+Shift+M 唤起体感 <300ms；失焦隐藏；Esc 隐藏后可再唤起
- [ ] 搜索命中与排序抽查（子串词、前缀词、乱序词）；收藏 App 置顶分组正确
- [ ] 启动未运行 App / 唤起运行中 App / 执行未运行 App 的命令（"将自动启动"路径）
- [ ] 明暗两态目检（注意 IAB 内置页初始为深色主题，先确认当前态再调）
- [ ] 管理中心按钮跳转；托盘右键菜单不受影响（未改动区，抽验即可）
- 风险文件：`scripts/build.mjs`（管线断言是最后防线）、`ui/vite.config*.ts`（约束常量）。

## 回滚点

- 步骤 1 全部在 `ui/` 内、host 产物未接线：直接弃置即可。
- 步骤 2 后回滚 = `git checkout scripts/build.mjs` + `rm -rf host/dist/launcher`；
  原生页文件全程未动，删除 `ui/node_modules` 是终极回退（与管理中心同一开关）。

## task.py start 前检查（已通过）

- [x] implement.jsonl / check.jsonl 已填真实条目
- [x] prd.md 收敛通过（无 Open Question、无重复段落）
- [x] 用户已明确批准本规划摘要

## 实施记录（2026-09-28）

- 实现（trellis-implement）与检查（trellis-check）均完成；检查结论 PASS-with-nits。
  闸门实测：`npm run build` 双页归一化断言过、回退演练过、`npm test` 35/35、ui tsc 干净。
  host/src/ 冻结区零改动（git 验证）。
- 与设计的偏差（均为合理最小修正）：build.mjs 产物 launcher.html→index.html 改名
  （主进程加载路径冻结）；管理中心按钮放底部 hint 行；.gitignore 补 ui/dist-launcher/。
- 遗留给 P1.2（dev 热更新）的第一件事：LauncherApp 的 onError/onRefresh effect 无清理，
  生产包与演示模式不可达（StrictMode 双调仅 dev；演示回调是空操作），但 P1.2 在 Vite dev
  下挂真桥时会变成双监听 bug——届时给 preload 桥加退订或用 ref 守卫一次性注册。
- 测试基线备忘：套件已从 29 涨到 35（idle-stop 等批次加入），prd 里的 29 按历史基线理解。
