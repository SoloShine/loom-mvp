# mini create 模板：minimal|react — P1.3

## Goal

`mini create` 增加 `--template minimal|react`（缺省 minimal，保住 PRD 的「30 秒 Hello World」承诺）。
react 模板与管理中心同栈（React 19 + Vite 7），让外部编码 Agent 生成复杂 UI App（面板类）
时拥有充足的 React 语料与既定规范；产线产物仍走统一 esbuild 管线，Host 运行时零特例。
来源：`docs/post-mvp-plan.md` P1.3（用户已批准的 roadmap）。

## 确认事实（代码证据）

- `cli/src/create.ts`：模板是 createApp() 内联字符串（app.yaml + package.json + tsconfig +
  src/main.ts + src/ui.ts + README）；`@mini/sdk` 依赖仅编辑器提示用（构建期 CLI alias 注入）。
- 产物契约（`cli/src/build.ts`）：`src/main.ts → dist/main.js`（node cjs）+
  `src/ui.ts → dist/ui.js`（browser iife，仅当存在）；`needsBuild` 按 src/ 最新 mtime 对比
  dist/main.js。宿主窗口壳 `ensureShellHtml`（host/src/main/services/windows.ts:52）**无条件**
  写 `dist/index.html` 并加载 `./ui.js`——App 生产 UI 的唯一契约就是一个 `dist/ui.js`。
- App 窗口无 CSP meta（壳 html 没有，windowOptions 也不注入）——UI 内联 `<style>` 可用。
- esbuild 原生转译 .tsx；`jsx: "automatic"`（走 react/jsx-runtime，React 19 支持）即可让
  ui 管线打包 React 组件，react 从 App 自有 node_modules 解析（esbuild 标准解析）。
- P1.2 已落地 `ui.devUrl`（窗口创建时探测→loadURL/回退）——react 模板声明 devUrl 即插即用。
- 能力 lint（cli/src/index.ts `localScan`）只扫 `src/*.ts`（`name.endsWith(".ts")`）——
  `.tsx` 文件会被漏掉，需泛化为 .ts/.tsx（generic 修复，非 react 特例）。
- 本机 npm 需要 `--registry=https://registry.npmmirror.com`（主源吐损坏 tarball，
  ui/ 工程已验证；react/react-dom/vite 在 npm cache 已热）。

## Requirements

- **R1 `--template` 参数**：`mini create <id> [--ui …] [--template minimal|react]`；
  缺省 minimal（行为与现状完全一致）；非法模板名报错；HELP 同步更新。
- **R2 react 模板脚手架**：React 19 + Vite 7（与管理中心同栈）；`app.yaml` 声明
  `ui.devUrl: http://localhost:5174`（附注释说明起/停 dev server 的切换行为）；
  `src/ui.tsx` React 组件（ping/pong 演示与 minimal 的 ui.ts 语义对等）；vite 仅作 dev
  server（`npm run dev`），生产 ui.js 由 `mini build` 的 esbuild 管线产出（见 R4）；
  create 过程在 App 目录执行 npm install（deps: react/react-dom；devDeps: vite/@vitejs/plugin-react，
  走 npmmirror）。
- **R3 CLI 泛化（非 react 特例）**：ui 产物入口接受 `src/ui.ts` 或 `src/ui.tsx`；
  esbuild ui 构建启用 `jsx: "automatic"`（对 vanilla 无影响）；能力 lint 扫描 .ts+.tsx。
- **R4 产线单一路径**：生产 UI 一律 `mini build` → `dist/ui.js`（esbuild iife + automatic jsx）。
  不让 App 自带 vite build 产出生产产物（理由见 design.md 取舍表：双构建系统会产出两个
  竞争的 ui.js，违反「Host 构建管线只认 esbuild 产物」的边界语义）。
- **R5 测试**：cli-contract 增加 react 模板用例（跳过 npm install 的干跑模式）：
  脚手架文件齐全、manifest 含 devUrl、minimal 模板输出与现状一致。
- **R6 文档**：模板 README 写清 dev 工作流（npm run dev + 重开窗口切换）；
  `docs/post-mvp-plan.md` P1.3 追加实施记录。

## Acceptance Criteria

- [ ] `mini create <id>`（无 --template）产出与现状逐字节一致的 minimal 脚手架。
- [ ] `mini create <id> --template react`：脚手架齐全（app.yaml 带 devUrl、package.json、
      tsconfig、vite.config.ts、index.html、src/main.ts、src/ui.tsx、README），
      npm install 成功，`mini validate` 通过。
- [ ] 真机：两模板各自 create → run → `mini invoke <id> ping` 全程 <30 秒（npm cache 温热）。
- [ ] 真机：react App 窗口显示 React 渲染的产物 UI（ui.js 含 React，点按钮 pong 正常）。
- [ ] 真机：react App 目录 `npm run dev` → 重开窗口 → devUrl 生效（P1.2 机制），
      改 ui.tsx 秒级热更；停 dev server 重建窗口回退产物。
- [ ] `mini dev <react-app>` 对 main.ts 改动仍正常（esbuild rebuild + reload 提示行）。
- [ ] `npm test` 全绿（含新增 react 模板干跑用例）。

## Out of Scope

- App 模板之外的新脚手架变体（vanilla-ts 之外的第三种栈）。
- dev server 生命周期代管 / 多 react App 并行 dev 的端口协商（缺省 5174，README 说明改法）。
- Tailwind/shadcn 等完整样式栈进模板（react 模板保持最小可跑，样式栈由 Agent 按需加）。
- ~~Host 侧任何改动~~ **范围修订（2026-09-29 验收期）**：真机验收暴露既有产品 bug——
  `manager.requireApp` 只在「App 不存在」时重扫，registry 缓存的 `manifestIssues` 是
  App 目录刚创建（产物未构建）时的旧值，任何带 `ui` 的新 App 立即 `mini run` 都会误报
  「缺少产物」（P1.2 的 devdemo 也踩过）。roadmap 验收要求 create → run → invoke 直达，
  故本任务加一处 host 修复：`requireApp` 对「已存在但有 issues」的条目重扫一次自愈
  （产物真缺失仍会抛）。这是 create→run 直达体验的前置，不是 react 特例。

## Open Questions

（无——模板内容与验收均由 roadmap P1.3 原文 + 现有产物契约确定；产线路径取舍见 design.md。）
