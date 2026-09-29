# 执行计划 — mini create 模板：minimal|react

前置：无（npm 依赖安装发生在 create 运行期；npmmirror 已是本机现实）。

## 步骤 1：CLI 泛化（build.ts / index.ts，非 react 特例）

- [ ] `cli/src/build.ts`：ui 分支入口 `src/ui.ts` 优先、回退 `src/ui.tsx`；
      ui esbuild 调用加 `jsx: "automatic"`（vanilla 无影响）
- [ ] `cli/src/index.ts`：`localScan` 能力 lint 覆盖 .ts + .tsx；
      cmdCreate 解析 `--template minimal|react`（缺省 minimal、非法名 die）并传给 createApp；
      HELP 文案加 `--template`
- 验证：`npm run build`（tsc 闸门）

## 步骤 2：react 模板（create.ts）

- [ ] `createApp(name, ui, template, opts?)`：minimal 分支输出逐字节不变；
      react 分支生成 app.yaml（ui window + devUrl 5174 带注释）/ package.json
      （react ^19 + vite ^7 + plugin-react + dev script）/ tsconfig（jsx react-jsx）/
      vite.config.ts / index.html / src/main.ts（同 minimal）/ src/ui.tsx
      （createRoot + ping/pong，`<style>` 注入基础样式）/ README（dev 工作流口径见 design.md）
- [ ] create 内联 npm install（仅 react）：spawnSync
      `npm install --registry=https://registry.npmmirror.com --no-fund --no-audit`，
      失败 die 带可读提示；`opts.install === false` 时跳过（测试干跑）
- 验证：本机 `node cli/dist/mini.js create reactdemo --ui window --template react`
      → 文件齐全 + install 成功 + `mini validate reactdemo` 过

## 步骤 3：契约测试

- [ ] `tests/cli-contract.test.cjs`：react 干跑用例（install:false——文件清单、
      app.yaml devUrl、package.json 结构、parseManifest 通过）；
      minimal 输出与现状一致的回归断言；非法 --template 名 die；
      ui.tsx 干编译用例（临时目录 + 不含 react 导入的 jsx 组件 → ui.js 产出）
- 验证：`npm test` 全绿（37 + 新增）

## 步骤 4：真机验收 ✅ 2026-09-29 完成(主会话 CUA 实测)

- [x] minimal：`mini create demo-min`（缺省模板）→ run → `mini invoke demo-min ping`
      计时 <30s；输出与既有 App 结构一致
- [x] react：`mini create demo-react --ui window --template react` → run →
      `mini invoke demo-react ping` 计时 <30s；窗口显示 React 渲染的产物 UI、点按钮 pong 正常
- [x] dev 热更：`cd apps/demo-react && npm run dev` → 重开窗口（mini stop + run）→
      devUrl 生效；改 ui.tsx 秒级更新；停 dev server 重开窗口回退产物
- [x] `mini dev demo-react` 提示行 + main.ts 改动 rebuild 正常
- [x] 清理：删 demo-min / demo-react；roadmap P1.3 追加实施记录
- 风险文件：`cli/src/create.ts`（模板字符串——minimal 输出逐字节不变是硬约束）、
  `cli/src/build.ts`（ui 分支泛化——ui.ts 优先级与现产物形态不变）。

## 回滚点

- 步骤 1-3 纯 cli 改动，git checkout 逐文件回退；minimal 缺省行为有契约断言兜底。
- 步骤 4 的 demo App 删目录即净。

## task.py start 前检查

- [x] implement.jsonl / check.jsonl 已填真实条目
- [x] prd.md 收敛通过（无 Open Question、无重复段落）
- [x] 用户已明确批准本规划摘要

## 实施记录（2026-09-29 完成）

- 实现（trellis-implement）+ 检查（trellis-check PASS-with-nits）：41/41 测试
  （37 基线 + 4 新增：minimal 逐字节回归、react 干跑、--template die 路径、ui.tsx 干编译）。
  minimal 输出经「旧版 vs 新版双实现生成 + Buffer.equals 全文件比对」机械验证。
- 验收期修的两个真问题：
  1. react 模板 package.json 含 `"@mini/sdk": "*"` → npm install 404（包不存在于 registry；
     minimal 从没跑过 install 所以从未暴露）。修：react 模板去掉该依赖，类型解析走 tsconfig
     paths（本就覆盖），测试断言同步（dependencies 无 @mini/sdk）。
  2. **既有产品 bug**：`manager.requireApp` 只在「App 不存在」时重扫，registry 缓存的
     manifestIssues 停在 App 创建时刻（产物未构建）→ 任何带 ui 的新 App 立即 `mini run`
     误报「缺少产物」（P1.2 devdemo 也踩过）。修：requireApp 对「已存在但有 issues」的
     条目重扫一次自愈（host/src/main/runtime/manager.ts，产物真缺失仍抛）。
     PRD Out of Scope 已按工作流规则回写修订。
- 真机实测：minimal create→run→invoke 681ms；react 5681ms（含 npm install）——均 <30s。
  React 产物 UI（esbuild jsx automatic 打包）渲染 + ping→pong 正常；App 自带 vite dev
  （5174）重建窗口切 devUrl（host.log `[vite] connected`），改 ui.tsx 秒级 HMR（截图
  data/shots/demo-react-hmr.png）；停 server 回退产物 + 日志；`mini dev` 提示行正常。
- 已知噪声：create 的 npm install 在 Windows 下有 Node DEP0190 deprecation warning
  （args+shell:true），无功能影响。
