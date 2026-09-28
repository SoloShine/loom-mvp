# 目录结构（cli/）

```
cli/
├── package.json         # name: mini-cli；bin: mini → dist/mini.js
├── tsconfig.json
└── src/
    ├── index.ts         # 入口：HELP 文案、命令分发（cmd* 函数表）、本地扫描（list/validate 的 Host 无关路径）
    ├── client.ts        # 控制通道客户端：runtime.json 发现 + token、api.* 方法、ensureHost、ping
    ├── build.ts         # esbuild 构建 App（entry → dist/main.js，@mini/sdk alias 注入）、needsBuild 增量判断
    └── create.ts        # mini create 脚手架（目录 + app.yaml + 模板源码；UiType: none|window|floating|overlay）
```

## 职责边界

- `index.ts` 只做**参数解析 + 编排 + 输出**；协议细节在 client.ts，构建细节在 build.ts。
- manifest 校验唯一事实在 host：`import { parseManifest, type Manifest } from
  "../../host/src/main/manifest"`（cli/src/index.ts 现状）。**不许在 CLI 侧重写校验规则**。
- `npm run mini` 跑的是 `cli/dist/mini.js` 打包产物——改完源码用 esbuild 重建
  （`npm run build` 会一起出），别直接改 dist。

## 新增模块

新逻辑先问归属：协议 → client.ts；构建 → build.ts；脚手架 → create.ts；都不是才开新文件。
跨包共享的纯类型/工具放 host 侧（CLI import host 是既有方向），不放 CLI（host 不反向依赖 CLI）。
