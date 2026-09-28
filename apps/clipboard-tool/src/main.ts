import { host } from "@mini/sdk";
type Mode = "clean" | "format";
let mode: Mode = "clean";
function transform(input: string, selected: Mode): string {
  const normalized = input.replace(/\r\n?/g, "\n").replace(/[\t ]+$/gm, "").trim();
  if (selected === "clean") return normalized.replace(/[\t ]{2,}/g, " ");
  return normalized.split("\n").map((line) => line.trim().replace(/[\t ]+/g, " ")).filter(Boolean).join("\n");
}
async function processClipboard(selected: Mode) {
  const text = await host.clipboard.readText();
  if (!text) { host.ui.send({ type: "result", message: "Clipboard is empty" }); return { changed: false }; }
  const output = transform(text, selected);
  if (output !== text) await host.clipboard.writeText(output);
  await host.log.info(`clipboard-tool ${selected}: ${output === text ? "unchanged" : "updated"}`);
  host.ui.send({ type: "result", message: output === text ? "Already formatted" : "Clipboard updated" });
  await host.notification.show({ title: "Clipboard Tool", body: output === text ? "No changes" : "Text updated" }).catch(() => false);
  return { changed: output !== text, length: output.length };
}
export async function onStart() {
  const saved = await host.storage.get("mode");
  if (saved === "clean" || saved === "format") mode = saved;
  await host.log.info("clipboard-tool started");
}
export async function onStop() { await host.log.info("clipboard-tool stopped"); }
export async function invoke(command: string) {
  if (command !== "clean" && command !== "format") throw new Error(`Unknown command: ${command}`);
  return processClipboard(command);
}
host.ui.onMessage((message: any) => {
  void (async () => {
    if (message?.type === "ready") host.ui.send({ type: "mode", mode });
    if (message?.type === "mode" && (message.mode === "clean" || message.mode === "format")) {
      mode = message.mode;
      await host.storage.set("mode", mode);
      host.ui.send({ type: "mode", mode });
    }
    if (message?.type === "apply") await processClipboard(mode);
  })().catch((error) => {
    host.ui.send({ type: "result", message: error instanceof Error ? error.message : String(error) });
    void host.log.warn("clipboard-tool operation failed");
  });
});
