import { host } from "@mini/sdk";

const root = document.getElementById("root")!;
root.innerHTML = `
<style>
  body { font: 14px system-ui; margin: 16px; color: #20262b; background: #f7f8f8; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  button, input, select { padding: 6px 10px; margin: 2px 4px 2px 0; }
  button { cursor: pointer; }
  button:disabled { opacity: .45; cursor: default; }
  section { margin: 10px 0; }
  code { word-break: break-all; }
  #status { color: #a33; min-height: 18px; }
  #summary { color: #456; }
  table { border-collapse: collapse; width: 100%; margin-top: 6px; background: #fff; }
  th, td { border: 1px solid #dde2e6; padding: 4px 8px; text-align: left; font-size: 13px; }
  th { background: #eef1f3; }
  tr.conflict td { color: #a33; }
  #tableWrap { max-height: 260px; overflow-y: auto; }
</style>
<h1>File Organizer</h1>
<section>
  <button id="directory">Choose directory</button>
  <span>Directory: <code id="dir">None</code></span>
</section>
<section>
  Rule: <select id="mode"><option value="extension">By extension</option><option value="date">By date (YYYY-MM)</option></select>
  <span id="fallbackWrap">Fallback category <input id="fallback" maxlength="32" style="width:110px"></span>
  <label><input type="checkbox" id="dryRun" checked> Dry Run</label>
  <button id="refresh">Refresh preview</button>
  <button id="execute" disabled>Execute</button>
</section>
<section>
  <div id="summary">No preview yet.</div>
  <div id="tableWrap"><table><thead><tr><th>File</th><th>Category</th><th>Status</th></tr></thead><tbody id="rows"></tbody></table></div>
  <p id="hint" style="color:#78848f;font-size:12px;margin:8px 2px 0">仅列出目录顶层的普通文件;子目录与符号链接不会显示、也不会移动。</p>
  <div id="movedWrap" style="display:none;margin-top:8px">
    <div style="font-size:12px;color:#456;margin-bottom:4px">上次执行移动去向:</div>
    <div id="movedList" style="max-height:160px;overflow:auto;border:1px solid #dde2e6;background:#fff;border-radius:6px;padding:6px 10px;font-size:12px"></div>
  </div>
</section>
<p id="status" role="status"></p>`;

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
function renderRows(items: any[]) {
  const tbody = $("rows");
  tbody.textContent = "";
  for (const item of items) {
    const tr = document.createElement("tr");
    if (item.conflict) tr.className = "conflict";
    for (const text of [item.fileName, item.category, item.conflict ? "conflict: destination exists" : "move"]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

function render(msg: any) {
  $("dir").textContent = msg.directory ?? "None";
  $("mode").value = msg.mode;
  $("fallback").value = msg.fallback;
  $("fallbackWrap").style.display = msg.mode === "extension" ? "" : "none";
  const plan = msg.plan;
  if (!plan) { $("summary").textContent = "No preview yet."; $("rows").textContent = ""; }
  else {
    let summary = `Total ${plan.counts.total} · to move ${plan.counts.move} · conflicts ${plan.counts.conflict}`;
    if (plan.truncated) summary += ` (first ${plan.items.length} shown)`;
    $("summary").textContent = summary;
    renderRows(plan.items);
  }
  $("execute").disabled = !plan || plan.counts.total === 0;
  // 本次移动去向:执行后逐条列出 源文件名 → 目标路径
  const r = msg.lastResult;
  const moved = (r?.movedList ?? []) as { fileName: string; destination: string }[];
  $("movedWrap").style.display = moved.length ? "" : "none";
  if (moved.length) {
    const box = $("movedList");
    box.textContent = "";
    for (const m of moved) {
      const line = document.createElement("div");
      line.style.cssText = "padding:2px 0;word-break:break-all";
      const name = document.createElement("b");
      name.textContent = m.fileName;
      line.appendChild(name);
      line.appendChild(document.createTextNode(" → " + m.destination));
      box.appendChild(line);
    }
  }
}

function failure(message: string) { $("status").textContent = message; }

$("directory").onclick = () => host.app.send({ type: "directory" });
$("refresh").onclick = () => host.app.send({ type: "settings", mode: $("mode").value, fallback: $("fallback").value });
$("execute").onclick = () => {
  const settings = { mode: $("mode").value, fallback: $("fallback").value };
  if ($("dryRun").checked) { host.app.send({ type: "settings", ...settings }); failure("Dry Run: nothing was moved."); return; }
  const summary = $("summary").textContent ?? "";
  if (window.confirm(`Move the planned files now? Conflicts are skipped, nothing is overwritten.\n\n${summary}`)) {
    host.app.send({ type: "execute", ...settings });
  }
};
$("mode").onchange = () => { $("fallbackWrap").style.display = $("mode").value === "extension" ? "" : "none"; };

host.app.onMessage((msg: any) => {
  if (msg?.type === "error") { failure(msg.message); return; }
  if (msg?.type !== "state") return;
  failure("");
  render(msg);
});
host.app.send({ type: "ready" });
