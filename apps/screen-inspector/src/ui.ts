import { host } from "@mini/sdk";
const root = document.getElementById("root")!;
root.innerHTML = `<style>body{font:14px system-ui;color:#20262b;background:#f7f8f8;margin:18px}h1{font-size:20px}button,input{padding:6px;margin:3px}input{width:72px}#displays{white-space:pre-wrap}img{display:block;max-width:100%;max-height:170px;object-fit:contain;border:1px solid #aaa;margin-top:12px}#status{color:#a33}</style><h1>Screen Inspector</h1><button id="refresh">Refresh displays</button><pre id="displays"></pre><div id="fields"></div><button id="capture">Capture region</button><p id="status" role="status"></p><img id="image" alt="Captured region">`;
const ids = ["x", "y", "width", "height"] as const;
const fields = document.getElementById("fields")!;
for (const name of ids) {
  const label = document.createElement("label");
  label.textContent = name + " ";
  const input = document.createElement("input"); input.type = "number"; input.id = name; input.value = name === "width" || name === "height" ? "200" : "0";
  label.appendChild(input); fields.appendChild(label);
}
document.getElementById("refresh")!.onclick = () => host.app.send({ type: "monitors" });
document.getElementById("capture")!.onclick = () => host.app.send({ type: "inspect", rect: Object.fromEntries(ids.map((id) => [id, Number((document.getElementById(id) as HTMLInputElement).value)])) });
host.app.onMessage((msg: any) => {
  if (msg?.type === "saved" && msg.rect) for (const id of ids) (document.getElementById(id) as HTMLInputElement).value = String(msg.rect[id]);
  if (msg?.type === "monitors") document.getElementById("displays")!.textContent = msg.displays.map((m: any) => `${m.id}: ${m.bounds.x}, ${m.bounds.y}  ${m.bounds.width} x ${m.bounds.height}  scale ${m.scaleFactor}`).join("\n") || "No displays";
  if (msg?.type === "capture") { (document.getElementById("image") as HTMLImageElement).src = msg.dataUrl; document.getElementById("status")!.textContent = `${msg.width} x ${msg.height}`; }
  if (msg?.type === "error") document.getElementById("status")!.textContent = msg.message;
});
host.app.send({ type: "ready" });
