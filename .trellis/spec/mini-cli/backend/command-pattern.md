# 命令模式（cmd* 函数）

## 现有结构（cli/src/index.ts）

- 顶部 `HELP` 常量是命令清单的**唯一展示面**——加命令必须同步更新它。
- 每个命令一个 `async function cmdXxx(args: string[]): Promise<void>`，
  index.ts 底部按 `command` 字符串表分发。新命令照抄：
  ```ts
  async function cmdFoo(args: string[]): Promise<void> {
    const id = args[0];
    if (!id) die("缺少 App id");
    // ...编排：本地判断用 fs，Host 侧走 api.*
    console.log("结果");   // 输出用 console.log，一行一个结论
  }
  ```
- 参数工具只有 `argFlag(args, flag)`；不要引入 yargs/commander（依赖极简是仓库纪律）。
- 需要本地 App 信息的用 `localScan()`（读 apps/ + parseManifest + 能力 lint），不要自己扫目录。

## 能力 lint（list 的提示链路）

`capabilityOfSource()` 用正则收集源码里 `host.<Svc>.` 调用，与 manifest `permissions`
声明比对，缺声明给**提示**不阻断（`能力声明提示: ...`）。新增能力前缀时同步
`declaredCapabilities` 的豁免清单（`app/ui/log/window` 四个隐式能力）。

## create（cli/src/create.ts）

- 产出目录结构对齐 PRD §3：`app.yaml + src/main.ts(+ ui/) + helpers/ + assets/ + tests/ + README.md`。
- `--ui none|window|floating|overlay` 决定 manifest ui 段；模板代码里 host.* 调用
  必须与 permissions 声明自洽（create 出来的 App 要能直接过 validate）。
- `--template minimal|react`（缺省 minimal）：minimal 输出有逐字节契约测试锁死；
  react 模板 = React 19 + Vite 7（vite 仅 dev server，`ui.devUrl:5174` 声明在 app.yaml），
  生产 ui.js 统一走 mini build 的 esbuild（.tsx + jsx:automatic）——**不要给 App 模板
  引入第二个生产构建器**（壳 html 契约只有一个 dist/ui.js，两个生产者会互相覆盖）。
  react 模板 package.json **不得含 @mini/sdk 依赖**（registry 无此包，install 404）。
- create 的 react 分支内联 npm install（npmmirror；`opts.install:false` 供测试干跑）。

## build（cli/src/build.ts）

- esbuild：entry → `dist/main.js`，`@mini/sdk` 走 alias 指向 `sdk/src/index.ts`
  （**SDK 由构建注入，App 不安装依赖**——PRD pinned 决策）。
- ui 分支：`src/ui.ts` 优先、`src/ui.tsx` 回退，`jsx: "automatic"`；壳 html 只认
  `dist/ui.js`（browser iife）。
- `needsBuild()` 按源码/产物 mtime 判断增量；`mini run` 已自动 reload 过期产物，
  `mini dev` = watch + reload。改构建参数（external、platform、target）要同步
  host 侧对产物形态的假设（CJS、Node runtime）。
