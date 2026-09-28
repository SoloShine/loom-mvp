import path from "node:path";
import { host } from "@mini/sdk";

export async function onStart(): Promise<void> {
  await host.log.info("hello started");
  await host.storage.set("startedAt", Date.now());
}

export async function onStop(): Promise<void> {
  await host.log.info("hello stopped");
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
      return `hello, ${args?.name ?? "world"}`;

    case "selftest":
      return await selftest();

    default:
      throw new Error(`unknown command: ${command}`);
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
  const p = path.join(appsTmpDir(), `selftest-${Date.now()}.txt`);
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
