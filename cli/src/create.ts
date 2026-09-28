import fs from "node:fs";
import path from "node:path";
import { appsDir } from "./client";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export type UiType = "none" | "window" | "floating" | "overlay";

export function createApp(name: string, ui: UiType): string {
  if (!NAME_RE.test(name)) {
    throw new Error(`名字非法(需 ${NAME_RE}): ${name}`);
  }
  const appDir = path.join(appsDir(), name);
  if (fs.existsSync(appDir)) {
    throw new Error(`已存在: ${path.relative(process.cwd(), appDir)}`);
  }

  fs.mkdirSync(path.join(appDir, "src"), { recursive: true });

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

  fs.writeFileSync(
    path.join(appDir, "src", "main.ts"),
    `import path from "node:path";
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
`,
  );

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
