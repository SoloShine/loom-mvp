import { host, type Rect } from "@mini/sdk";
let lastRect: Rect | null = null;
function validRect(value: any): Rect {
  const { x, y, width, height } = value ?? {};
  // 尺寸上限交给"必须完整落在某块显示器内"的校验(原生 4K 全屏也要能截)
  if (![x, y, width, height].every((n) => Number.isSafeInteger(n)) || width < 1 || height < 1) throw new Error("Invalid region (positive integers required)");
  return { x, y, width, height };
}
async function monitors() {
  const displays = await host.screen.getMonitors();
  host.ui.send({ type: "monitors", displays });
  await host.log.info(`screen-inspector listed ${displays.length} monitors`);
  return displays;
}
async function inspect(value: unknown) {
  const rect = validRect(value);
  const displays = await host.screen.getMonitors();
  if (!displays.some((m) => rect.x >= m.bounds.x && rect.y >= m.bounds.y && rect.x + rect.width <= m.bounds.x + m.bounds.width && rect.y + rect.height <= m.bounds.y + m.bounds.height)) throw new Error("Region must fit within one display");
  const image = await host.screen.captureRegion(rect);
  if (!image.dataUrl.startsWith("data:image/png;base64,")) throw new Error("Unexpected capture format");
  lastRect = rect;
  await host.storage.set("lastRect", rect);
  host.ui.send({ type: "capture", dataUrl: image.dataUrl, width: image.width, height: image.height });
  await host.log.info(`screen-inspector captured ${image.width}x${image.height}`);
  return { width: image.width, height: image.height };
}
export async function onStart() {
  const saved = await host.storage.get("lastRect");
  try { if (saved) lastRect = validRect(saved); } catch { /* ignore stale state */ }
  await host.log.info("screen-inspector started");
}
export async function onStop() { await host.log.info("screen-inspector stopped"); }
export async function invoke(command: string) {
  if (command === "monitors") return monitors();
  throw new Error(`Unknown command: ${command}`);
}
host.ui.onMessage((message: any) => {
  void (async () => {
    if (message?.type === "ready") { host.ui.send({ type: "saved", rect: lastRect }); await monitors(); }
    if (message?.type === "monitors") await monitors();
    if (message?.type === "inspect") await inspect(message.rect);
  })().catch((error) => {
    host.ui.send({ type: "error", message: error instanceof Error ? error.message : String(error) });
    void host.log.warn("screen-inspector operation failed");
  });
});
