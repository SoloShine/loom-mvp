# 技术设计 — mini create 模板：minimal|react

## 产线路径（核心决策）：生产 ui.js 仍由 mini build 的 esbuild 产出

roadmap 原文设想「react 模板 build 脚本产 IIFE 产物」（App 自有 vite build）。
本设计改为：**vite 只做 dev server（devUrl 热更），生产 ui.js 统一由
`mini build` 的既有 esbuild 管线产出**（ui 入口接受 .tsx + `jsx: "automatic"`）。

理由（取舍表）：

| 取舍 | 选择 | 理由 |
|------|------|------|
| 生产 ui.js 来源 | mini build（esbuild）而非 App vite build | 壳 html 契约是唯一的 `dist/ui.js`；若 vite 也能产 ui.js 就存在两个竞争生产者（`mini dev` 的 esbuild rebuild 会覆盖 vite 产物，mtime 判断互相打架）；roadmap 边界「Host 构建管线只认 esbuild 产物 dist/main.js」的语义是**单一产物事实**，esbuild 路径忠实于它 |
| vite 的角色 | 仅 dev server（npm run dev → devUrl） | devUrl 热更是 vite 的不可替代价值；产物构建它并无增量 |
| jsx 转译 | esbuild `jsx: "automatic"`（泛化选项） | 对 vanilla ui.ts 是 no-op；react/jsx-runtime 从 App 自有 node_modules 解析，esbuild 标准行为，非特例 |
| CSS | 模板用 `<style>` 注入（App 窗口无 CSP meta）+ 组件内联样式 | 避免为脚手架引入 CSS 管线（esbuild 会把 import 的 css 拆成 ui.css，壳不加载）；模板保持最小 |
| npm install 时机 | create 内联执行（npmmirror，--no-fund --no-audit） | 否则 react App 首次 run 必败；warm cache 下 <30s 可达（验收实测为准） |

## create.ts 结构

`createApp(name, ui, template: "minimal" | "react", opts?: { install?: boolean })`
——`install` 供测试干跑（cli-contract 不打网络）；index.ts 解析 `--template` 并传 spawnSync
`npm install --registry=https://registry.npmmirror.com --no-fund --no-audit`（仅 react 模板）。

minimal 分支：现有逻辑原样（输出不变，验收有逐字节一致性断言——现有 cli-contract 快照续用）。

react 分支在 minimal 基础上：

```
apps/<id>/
├── app.yaml            # ui: window + devUrl: http://localhost:5174（带注释）+ 同款 commands
├── package.json        # deps: react/react-dom ^19；devDeps: vite ^7、@vitejs/plugin-react；
│                       # scripts: { "dev": "vite --port 5174 --strictPort" }
├── tsconfig.json       # extends 根 base + jsx: "react-jsx" + paths(@mini/sdk)
├── vite.config.ts      # react 插件；root=App 目录；port 5174 strict；build iife（仅对齐性，产线不走）
├── index.html          # vite dev 入口：空 #root + /src/ui.tsx（与壳 html 的 #root 约定一致）
├── src/
│   ├── main.ts         # 与 minimal 相同（生命周期 + ping/selftest）
│   └── ui.tsx          # React：createRoot + ping/pong（host.app 消息对，语义与 minimal ui.ts 对等）
└── README.md           # dev 工作流：npm run dev → 重开窗口；mini run/dev/invoke 速查
```

- `src/ui.tsx` 故意与 minimal 的 `src/ui.ts` **同名不同缀**：`needsBuild`/`buildApp` 的
  ui 分支改为 `ui.ts ?? ui.tsx`，两模板在 dev watch 下行为一致（改 ui 文件 → esbuild 重建 ui.js）。
- ui.tsx 基础样式走一个小组件里的 `<style>` 字符串注入（App 窗口无 CSP meta，可用），
  避免引 CSS 文件（esbuild 会拆出壳不加载的 ui.css）。

## build.ts / index.ts 泛化（三点，全部 generic）

1. `buildApp`：ui 分支入口 `src/ui.ts` 优先、回退 `src/ui.tsx`；esbuild 调用加 `jsx: "automatic"`。
2. `needsBuild`：无需改（按 src/ 目录 mtime 走，已覆盖 .tsx）。
3. `localScan` 能力 lint：`endsWith(".ts")` → `endsWith(".ts") || endsWith(".tsx")`。

## dev 工作流（模板 README 口径）

```bash
mini run <id>            # 生产形态：esbuild 产物跑窗口（dev server 不在也完整可用）
cd apps/<id> && npm run dev   # 起 vite（5174）
# 重开 App 窗口（mini stop + run，或管理中心/托盘重开）→ P1.2 探测切到 devUrl，HMR 生效
# 停掉 dev server → 再重开窗口 → 自动回退产物
mini dev <id>            # main.ts 侧改动照旧 esbuild rebuild + reload
```

端口冲突：两个 react App 同时 dev 需各自改 vite.config.ts + app.yaml 的端口（README 注明）；
MVP 不做端口协商。

## 测试（tests/cli-contract.test.cjs）

- react 模板干跑（install:false）：文件清单齐全；app.yaml 含 `devUrl: http://localhost:5174`；
  package.json 含 react 依赖与 dev script；`parseManifest` 通过。
- minimal 模板回归：现有快照/结构断言保持（输出逐字节不变）。
- `--template` 参数：非法名 die；缺省 minimal。
- build 泛化：临时目录放 src/ui.tsx（含 jsx 组件、假 react？不行——esbuild 会解析 react；
  干跑用不含 react 导入的 tsx 组件即可验证 jsx automatic 转译与 ui.js 产出）。

## 兼容与回滚

- minimal 缺省路径零改动（同字符串输出）；build.ts 的 jsx/tsx 泛化对现有 App 无行为差异
  （jsx automatic 对无 jsx 源是 no-op；ui.ts 优先级不变）。
- 回滚 = git revert cli 改动；已创建的 react App 独立成目录，删除即净。

## 风险

- npm install 时延（cold cache 会破 30 秒）——验收实测 warm cache；README 注明首次冷装耗时取决于网络。
- react 19 + esbuild jsx automatic 组合——管理中心同栈已验证 React 19 可用；esbuild 转译由
  契约测试覆盖（干跑 tsx 编译）。
