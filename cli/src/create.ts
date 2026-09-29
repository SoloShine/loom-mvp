import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { appsDir } from "./client";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export type UiType = "none" | "window" | "floating" | "overlay";
export type Template = "minimal" | "react";

/** 两模板共用的 main.ts(生命周期 + ping/selftest 演示,内容一致)。 */
function mainTs(name: string): string {
  return `import path from "node:path";
import { host } from "@mini/sdk";

export async function onStart(): Promise<void> {
  await host.log.info("${name} started");
  await host.storage.set("startedAt", Date.now());
}

export async function onStop(): Promise<void> {
  await host.log.info("${name} stopped");
}

// 窗口消息示例:UI 按钮 → 这里 → 回传 UI
host.ui.onMessage((msg: any) => {
  if (msg?.type === "ping") {
    host.ui.send({ type: "pong", at: Date.now() });
  }
});

export async function invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
  switch (command) {
    case "ping":
      return { pong: true, at: new Date().toISOString() };

    case "greet":
      return \`hello, \${args?.name ?? "world"}\`;

    case "selftest":
      return await selftest();

    default:
      throw new Error(\`unknown command: \${command}\`);
  }
}

/** 跑一遍 host.* 的安全子集,用于验证平台接线。 */
async function selftest(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  // storage
  await host.storage.set("k", { v: 1 });
  out.storage = await host.storage.get("k");
  await host.storage.delete("k");

  // clipboard(先备份后恢复)
  const prev = await host.clipboard.readText();
  await host.clipboard.writeText("mini-host selftest");
  out.clipboard = (await host.clipboard.readText()) === "mini-host selftest";
  await host.clipboard.writeText(prev);

  // files
  const p = path.join(appsTmpDir(), \`selftest-\${Date.now()}.txt\`);
  await host.files.write(p, "ok");
  out.files = (await host.files.read(p)) === "ok";
  await host.files.remove(p);

  // screen
  const img = await host.screen.captureRegion({ x: 0, y: 0, width: 64, height: 48 });
  out.screen =
    img.width === 64 && img.height === 48 && img.dataUrl.startsWith("data:image/png");

  // mouse(只读)
  out.mouse = await host.mouse.position();

  // process
  const proc = await host.process.spawn({ command: "node", args: ["-e", "console.log('spawn-ok')"] });
  const lines: string[] = [];
  proc.stdout((l) => lines.push(l));
  out.processExitCode = await proc.wait();
  out.process = lines.join("") === "spawn-ok";

  // notification
  out.notification = await host.notification.show({
    title: "mini host selftest",
    body: "host.* 服务已全部跑通",
  });

  // hotkey(注册后立即释放)
  const combo = "Ctrl+Alt+Shift+F12";
  out.hotkey = await host.hotkey.register(combo, () => {});
  if (out.hotkey) await host.hotkey.unregister(combo);

  return out;
}

function appsTmpDir(): string {
  return path.join(process.env.MINI_APP_DIR ?? ".", ".tmp");
}
`;
}

export function createApp(
  name: string,
  ui: UiType,
  template: Template = "minimal",
  opts?: { install?: boolean },
): string {
  if (!NAME_RE.test(name)) {
    throw new Error(`名字非法(需 ${NAME_RE}): ${name}`);
  }
  // 调用方(cmdCreate)已用 die() 校验;这里是编程错误的兜底
  if (template !== "minimal" && template !== "react") {
    throw new Error(`未知模板: ${template}(可用: minimal|react)`);
  }
  const appDir = path.join(appsDir(), name);
  if (fs.existsSync(appDir)) {
    throw new Error(`已存在: ${path.relative(process.cwd(), appDir)}`);
  }

  fs.mkdirSync(path.join(appDir, "src"), { recursive: true });

  if (template === "react") {
    return reactApp(name, appDir, opts);
  }

  const uiYaml =
    ui === "none"
      ? "ui:\n  type: none\n"
      : `ui:\n  type: ${ui}\n  width: 360\n  height: 240\n`;

  fs.writeFileSync(
    path.join(appDir, "app.yaml"),
    `id: ${name}
name: ${name}
version: 0.1.0

entry: src/main.ts

${uiYaml}
commands:
  - id: ping
    title: Ping
  - id: selftest
    title: 服务自检
`,
  );

  fs.writeFileSync(
    path.join(appDir, "package.json"),
    JSON.stringify(
      {
        name,
        version: "0.1.0",
        private: true,
        dependencies: {
          // 编辑器提示用;构建时由 mini CLI 直接 alias 到宿主 SDK,无需安装
          "@mini/sdk": "*",
        },
      },
      null,
      2,
    ) + "\n",
  );

  fs.writeFileSync(
    path.join(appDir, "tsconfig.json"),
    JSON.stringify(
      {
        extends: "../../tsconfig.base.json",
        compilerOptions: {
          paths: { "@mini/sdk": ["../../sdk/src/index.ts"] },
        },
        include: ["src"],
      },
      null,
      2,
    ) + "\n",
  );

  fs.writeFileSync(path.join(appDir, "src", "main.ts"), mainTs(name));

  if (ui !== "none") {
    fs.writeFileSync(
      path.join(appDir, "src", "ui.ts"),
      `import { host } from "@mini/sdk";

const root = document.getElementById("root")!;

function line(text: string): HTMLDivElement {
  const div = document.createElement("div");
  div.textContent = text;
  return div;
}

async function main(): Promise<void> {
  root.appendChild(line("${name}"));

  const pong = line("waiting pong…");
  root.appendChild(pong);

  host.app.onMessage((msg: any) => {
    if (msg?.type === "pong") pong.textContent = \`pong @ \${new Date(msg.at).toLocaleTimeString()}\`;
  });

  const btn = document.createElement("button");
  btn.textContent = "ping app";
  btn.onclick = () => host.app.send({ type: "ping" });
  root.appendChild(btn);
}

void main();
`,
    );
  }

  fs.writeFileSync(
    path.join(appDir, "README.md"),
    `# ${name}

Mini App for the Personal Mini App Host.

\`\`\`bash
mini run ${name}        # 构建 + 启动
mini dev ${name}        # watch + 自动 reload
mini invoke ${name} ping
mini logs ${name} --follow
\`\`\`
`,
  );

  return appDir;
}

/**
 * react 模板:React 19 + Vite 7(与管理中心同栈)。
 * vite 只做 dev server(app.yaml 的 ui.devUrl 热更);生产 ui.js 仍由
 * mini build 的 esbuild 管线产出(src/ui.tsx + jsx automatic),Host 零特例。
 */
function reactApp(name: string, appDir: string, opts?: { install?: boolean }): string {
  fs.writeFileSync(
    path.join(appDir, "app.yaml"),
    `id: ${name}
name: ${name}
version: 0.1.0

entry: src/main.ts

ui:
  type: window
  width: 360
  height: 240
  # dev server 起来后重开窗口自动切热更,停掉自动回退产物
  devUrl: http://localhost:5174

commands:
  - id: ping
    title: Ping
  - id: selftest
    title: 服务自检
`,
  );

  fs.writeFileSync(
    path.join(appDir, "package.json"),
    JSON.stringify(
      {
        name,
        version: "0.1.0",
        private: true,
        dependencies: {
          // 注意不放 "@mini/sdk":包不存在于 registry,npm install 会 404;
          // 类型解析走 tsconfig paths,构建期由 mini CLI alias 注入
          react: "^19.2.0",
          "react-dom": "^19.2.0",
        },
        devDependencies: {
          vite: "^7.1.0",
          "@vitejs/plugin-react": "^5.1.0",
        },
        scripts: {
          dev: "vite --port 5174 --strictPort",
        },
      },
      null,
      2,
    ) + "\n",
  );

  fs.writeFileSync(
    path.join(appDir, "tsconfig.json"),
    JSON.stringify(
      {
        extends: "../../tsconfig.base.json",
        compilerOptions: {
          paths: { "@mini/sdk": ["../../sdk/src/index.ts"] },
          jsx: "react-jsx",
        },
        include: ["src"],
      },
      null,
      2,
    ) + "\n",
  );

  fs.writeFileSync(
    path.join(appDir, "vite.config.ts"),
    `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// vite 只做 dev server(npm run dev → app.yaml 的 ui.devUrl 热更)。
// 生产 ui.js 由 mini build 的 esbuild 管线产出,不从这里构建。
export default defineConfig({
  plugins: [react()],
  // dev 端口来自 package.json 的 dev 脚本(--port 5174 --strictPort)
  build: {
    // 产物形态仅与宿主 ui/ 管线对齐(iife);产线不走这里
    modulePreload: { polyfill: false },
    rollupOptions: { output: { format: "iife", inlineDynamicImports: true } },
  },
});
`,
  );

  fs.writeFileSync(
    path.join(appDir, "index.html"),
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
  </head>
  <body>
    <!-- 空 #root:与宿主壳 html 约定一致,渲染交给 React -->
    <div id="root"></div>
    <script type="module" src="/src/ui.tsx"></script>
  </body>
</html>
`,
  );

  fs.writeFileSync(path.join(appDir, "src", "main.ts"), mainTs(name));

  fs.writeFileSync(
    path.join(appDir, "src", "ui.tsx"),
    `import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { host } from "@mini/sdk";

// 样式约束:不要 import .css 文件——esbuild 会把 css 拆成 dist/ui.css,而壳 html 只加载
// ui.js,样式会整份丢失。基础样式走 <style> 注入(App 窗口壳无 CSP meta,允许内联),
// 元素细节用内联 style。
const baseStyle = \`
  body { margin: 0; padding: 0; font-family: system-ui, sans-serif; font-size: 13px; color: #111; }
  button { margin-top: 8px; padding: 4px 12px; cursor: pointer; }
\`;

function App() {
  const [pong, setPong] = useState("waiting pong…");

  useEffect(() => {
    host.app.onMessage((msg: any) => {
      if (msg?.type === "pong") setPong(\`pong @ \${new Date(msg.at).toLocaleTimeString()}\`);
    });
  }, []);

  return (
    <div style={{ padding: 12 }}>
      <style>{baseStyle}</style>
      <div>${name}</div>
      <div>{pong}</div>
      <button onClick={() => host.app.send({ type: "ping" })}>ping app</button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
`,
  );

  fs.writeFileSync(
    path.join(appDir, "README.md"),
    `# ${name}

Mini App(react 模板:React 19 + Vite 7)。生产 UI 一律由 \`mini build\` 的 esbuild 管线
产出(dist/ui.js);vite 只作 dev server,不参与产线构建。

## dev 工作流

\`\`\`bash
mini run ${name}                 # 生产形态:esbuild 产物跑窗口(dev server 不在也完整可用)
cd apps/${name} && npm run dev   # 起 vite(端口 5174,strictPort)
# 重开 App 窗口(mini stop + run,或管理中心/托盘重开)→ 窗口自动切到 devUrl,HMR 生效
# 停掉 dev server → 再重开窗口 → 自动回退产物
mini dev ${name}                 # main.ts 侧改动照旧 esbuild rebuild + reload
\`\`\`

首次 create 已自动 npm install(npmmirror);冷缓存下耗时取决于网络。

端口冲突:两个 react App 同时 dev 需各自改 package.json 的 dev 脚本与 app.yaml 的
devUrl 端口(缺省 5174)。

## 速查

\`\`\`bash
mini run ${name}
mini dev ${name}
mini invoke ${name} ping
mini logs ${name} --follow
\`\`\`
`,
  );

  if (opts?.install !== false) {
    // react 模板自带依赖,create 时装好,否则首次 run 必败(30 秒承诺)。
    // 本机 npm 必须走 npmmirror(主源会吐损坏 tarball)。
    const res = spawnSync(
      "npm",
      ["install", "--registry=https://registry.npmmirror.com", "--no-fund", "--no-audit"],
      // Windows 下 npm 是 npm.cmd,Node 无 shell 直接 spawn 会 EINVAL
      { cwd: appDir, stdio: "inherit", shell: process.platform === "win32" },
    );
    if (res.error || res.status !== 0) {
      throw new Error(
        `npm install 失败(${res.error?.message ?? `exit code ${res.status}`}):请检查网络后重试,或在 App 目录手动执行 npm install`,
      );
    }
  }

  return appDir;
}
