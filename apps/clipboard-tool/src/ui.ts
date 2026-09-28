import { host } from "@mini/sdk";
const root = document.getElementById("root")!;
root.innerHTML = `<style>body{font:14px system-ui;color:#20262b;background:#f7f8f8;margin:22px}h1{font-size:20px}fieldset{border:1px solid #bbb;margin:18px 0;padding:14px}label{margin-right:18px}button{padding:9px 16px;cursor:pointer}#status{margin-top:16px;color:#286454}</style><h1>Clipboard Tool</h1><fieldset><legend>Mode</legend><label><input type="radio" name="mode" value="clean" checked> Clean spacing</label><label><input type="radio" name="mode" value="format"> Format lines</label></fieldset><button id="apply">Apply to clipboard</button><p id="status" role="status"></p>`;
for (const input of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) input.onchange = () => host.app.send({ type: "mode", mode: input.value });
document.getElementById("apply")!.onclick = () => host.app.send({ type: "apply" });
host.app.onMessage((msg: any) => {
  if (msg?.type === "mode") { const input = document.querySelector<HTMLInputElement>(`input[value="${msg.mode}"]`); if (input) input.checked = true; }
  if (msg?.type === "result") document.getElementById("status")!.textContent = msg.message;
});
host.app.send({ type: "ready" });
