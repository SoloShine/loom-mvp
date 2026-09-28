import { host } from "@mini/sdk";

/**
 * 连连看控制面板(floating,frameless):
 * 状态 / 棋盘预览(网格 + 识别叠加)/ 行列与区域手填 / 统计 / 日志。
 */

const root = document.getElementById("root")!;

// 渲染层可观测性:console 通道在本机不可靠,生命周期/异常直接走 host.log
const bridgeOk = !!(window as any).__miniHost;
void host.log.info(`[ui] module start, bridge=${bridgeOk}`);
window.addEventListener("error", (e) => {
  void host.log
    .error(`[ui] ${e.message} @${e.filename}:${e.lineno}`)
    .catch(() => {});
});
window.addEventListener("unhandledrejection", (e: any) => {
  void host.log.error(`[ui] unhandled rejection: ${String(e?.reason)}`).catch(() => {});
});

root.style.cssText = `
  font: 12px/1.6 "Segoe UI", "Microsoft YaHei", sans-serif;
  color: #d8dbe2; background: rgba(24, 26, 32, 0.97);
  height: 100vh; box-sizing: border-box;
  border: 1px solid #3a3d46; border-radius: 8px; overflow: hidden;
  user-select: none; display: flex; flex-direction: column; gap: 6px;
  padding: 10px 12px;
`;

function row(css = ""): HTMLDivElement {
  const div = document.createElement("div");
  div.style.cssText = css;
  root.appendChild(div);
  return div;
}

function button(label: string, action: string, onClick?: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.textContent = label;
  btn.style.cssText = `
    flex: 1; padding: 4px 0; font: inherit; color: #d8dbe2;
    background: #2c2f38; border: 1px solid #454954; border-radius: 5px; cursor: pointer;
  `;
  btn.onmouseenter = () => (btn.style.background = "#383c47");
  btn.onmouseleave = () => (btn.style.background = "#2c2f38");
  btn.onclick = onClick ?? (() => {
    console.log(`[lianliankan-ui] button ${label} clicked`);
    host.app.send({ action });
  });
  btnRow.appendChild(btn);
  return btn;
}

// -- 标题(拖拽区) -----------------------------------------------------------

const titleRow = row(
  "display: flex; align-items: baseline; gap: 8px; flex: 0 0 auto;" +
    " -webkit-app-region: drag;",
);
const title = document.createElement("span");
title.textContent = "连连看求解器";
title.style.cssText = "font-size: 14px; font-weight: 600;";
const phaseDot = document.createElement("span");
phaseDot.style.cssText = "font-size: 11px; color: #9aa0ac;";
const rectLabel = document.createElement("span");
rectLabel.style.cssText = "margin-left: auto; font-size: 10px; color: #7d828e;";
// 浮窗无系统标题栏,这是唯一的关闭入口;语义 = 隐藏(状态保留,
// 托盘/启动器唤回),不是销毁
const closeBtn = document.createElement("button");
closeBtn.textContent = "✕";
closeBtn.title = "隐藏面板(托盘 / 启动器可随时唤回)";
closeBtn.style.cssText = `
  -webkit-app-region: no-drag; flex: 0 0 auto; width: 22px; height: 22px;
  padding: 0; font: 12px/1 inherit; color: #9aa0ac;
  background: transparent; border: none; border-radius: 4px; cursor: pointer;
`;
closeBtn.onmouseenter = () => ((closeBtn.style.background = "#3a3d46"), (closeBtn.style.color = "#e8eaf0"));
closeBtn.onmouseleave = () => ((closeBtn.style.background = "transparent"), (closeBtn.style.color = "#9aa0ac"));
closeBtn.onclick = () => {
  void host.window.hide().catch(() => {});
};
titleRow.append(title, phaseDot, rectLabel, closeBtn);

const msgRow = row(
  "color: #aeb4c0; flex: 0 0 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;",
);

// -- 预览(截图 + 网格 + 识别叠加) --------------------------------------------

const previewBox = row(
  "position: relative; flex: 1 1 auto; min-height: 120px; overflow: hidden;" +
    " border: 1px solid #3a3d46; border-radius: 6px; background: #14161a;" +
    " display: flex; align-items: center; justify-content: center;",
);
const previewHint = document.createElement("span");
previewHint.textContent = "未框选棋盘区域 — 点「选区」框住游戏棋盘";
previewHint.style.cssText = "color: #6a6f7a;";
previewBox.appendChild(previewHint);

let previewImg: HTMLImageElement | null = null;
let previewSvg: SVGSVGElement | null = null;
let previewMeta: any = null;

function renderPreview(msg: any): void {
  previewMeta = msg;
  previewHint.style.display = msg?.error ? "" : "none";
  if (msg?.error) {
    previewImg?.remove();
    previewSvg?.remove();
    previewImg = null;
    previewSvg = null;
    previewHint.textContent = msg.error;
    return;
  }
  if (!previewImg) {
    previewImg = document.createElement("img");
    previewImg.style.cssText =
      "max-width: 100%; max-height: 210px; display: block;";
    previewSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    previewSvg.style.cssText = "position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none;";
    const wrap = document.createElement("div");
    wrap.style.cssText = "position: relative; display: inline-block; line-height: 0;";
    wrap.appendChild(previewImg);
    wrap.appendChild(previewSvg);
    previewBox.appendChild(wrap);
    previewImg.onload = () => drawOverlay();
  }
  previewImg.src = msg.image;
  drawOverlay();
}

function drawOverlay(): void {
  if (!previewSvg || !previewImg || !previewImg.naturalWidth || !previewMeta) return;
  const w = previewImg.naturalWidth;
  const h = previewImg.naturalHeight;
  const rows = Number(previewMeta.rows);
  const cols = Number(previewMeta.cols);
  const svg = previewSvg;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("preserveAspectRatio", "none");
  const NS = "http://www.w3.org/2000/svg";
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  // 识别结果着色:非空格按类型着色,空格描绿边;下一着法红框
  const typeColor = (type: number, alpha: number) =>
    `hsla(${(type * 47) % 360}, 70%, 55%, ${alpha})`;
  const moveKeys = new Set<string>();
  if (previewMeta.move) {
    moveKeys.add(`${previewMeta.move.a.row},${previewMeta.move.a.col}`);
    moveKeys.add(`${previewMeta.move.b.row},${previewMeta.move.b.col}`);
  }
  for (const t of previewMeta.tiles ?? []) {
    const rectEl = document.createElementNS(NS, "rect");
    rectEl.setAttribute("x", String(t.rx));
    rectEl.setAttribute("y", String(t.ry));
    rectEl.setAttribute("width", String(t.rw));
    rectEl.setAttribute("height", String(t.rh));
    if (t.empty) {
      rectEl.setAttribute("fill", "none");
      rectEl.setAttribute("stroke", "rgba(95,208,104,0.45)");
      rectEl.setAttribute("stroke-width", "1");
    } else {
      rectEl.setAttribute("fill", typeColor(t.type ?? 0, 0.3));
      rectEl.setAttribute("stroke", typeColor(t.type ?? 0, 0.9));
      rectEl.setAttribute("stroke-width", moveKeys.has(`${t.row},${t.col}`) ? "3" : "1");
    }
    svg.appendChild(rectEl);
  }

  // 行列网格线
  const grid = document.createElementNS(NS, "g");
  grid.setAttribute("stroke", "rgba(255,255,255,0.28)");
  grid.setAttribute("stroke-width", "1");
  for (let c = 1; c < cols; c++) {
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", String((w / cols) * c));
    line.setAttribute("y1", "0");
    line.setAttribute("x2", String((w / cols) * c));
    line.setAttribute("y2", String(h));
    grid.appendChild(line);
  }
  for (let r = 1; r < rows; r++) {
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", "0");
    line.setAttribute("y1", String((h / rows) * r));
    line.setAttribute("x2", String(w));
    line.setAttribute("y2", String((h / rows) * r));
    grid.appendChild(line);
  }
  svg.appendChild(grid);
}

// -- 行列 / 区域 手填 ----------------------------------------------------------

const inputCss =
  "width: 46px; font: inherit; font-size: 11px; color: #d8dbe2;" +
  " background: #1b1d23; border: 1px solid #454954; border-radius: 4px; padding: 2px 4px;";
const applyCss =
  "font: inherit; font-size: 11px; color: #d8dbe2; padding: 2px 8px;" +
  " background: #2c2f38; border: 1px solid #454954; border-radius: 4px; cursor: pointer;";
const labelCss = "color: #8f96a3; font-size: 11px;";

function smallInput(initial: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.value = initial;
  input.style.cssText = inputCss;
  return input;
}

const gridRow = row("display: flex; align-items: center; gap: 6px; flex: 0 0 auto;");
const rowsInput = smallInput("10");
const colsInput = smallInput("14");
const gridLabel1 = document.createElement("span");
gridLabel1.textContent = "行";
gridLabel1.style.cssText = labelCss;
const gridLabel2 = document.createElement("span");
gridLabel2.textContent = "列";
gridLabel2.style.cssText = labelCss;
const gridApply = document.createElement("button");
gridApply.textContent = "应用行列";
gridApply.style.cssText = applyCss;
gridApply.onclick = () => {
  const rows = Number(rowsInput.value);
  const cols = Number(colsInput.value);
  if (!rows || !cols) return;
  host.app.send({ action: "set-grid", rows, cols });
};
gridRow.append(gridLabel1, rowsInput, gridLabel2, colsInput, gridApply);

const regionRow = row("display: flex; align-items: center; gap: 4px; flex: 0 0 auto; font-size: 11px;");
const regionInputs = ["x", "y", "宽", "高"].map((label) => {
  const input = smallInput("0");
  const lab = document.createElement("span");
  lab.textContent = label;
  lab.style.cssText = labelCss;
  regionRow.append(lab, input);
  return input;
});
const regionApply = document.createElement("button");
regionApply.textContent = "应用区域";
regionApply.style.cssText = applyCss;
regionApply.onclick = () => {
  const [x, y, width, height] = regionInputs.map((i) => Number(i.value));
  if ([x, y, width, height].some((v) => !Number.isFinite(v))) return;
  host.app.send({ action: "set-region", rect: { x, y, width, height } });
};
regionRow.appendChild(regionApply);

// -- 概率模型参考中心 μ(EM 围绕它收敛;默认 0.75) ----------

const simRow = row("display: flex; align-items: center; gap: 4px; flex: 0 0 auto; font-size: 11px;");
const simLabel = document.createElement("span");
simLabel.textContent = "相似度阈值";
simLabel.title = "概率模型的参考中心 μ,默认 0.75;调高更严格,调低更宽松";
simLabel.style.cssText = labelCss;
const simInput = smallInput("0");
const simHint = document.createElement("span");
simHint.textContent = "(默认 0.75)";
simHint.style.cssText = "color: #5d6370; font-size: 10px;";
const simApply = document.createElement("button");
simApply.textContent = "应用";
simApply.style.cssText = applyCss;
simApply.onclick = () => {
  const value = Number(simInput.value);
  if (!Number.isFinite(value) || value < 0 || value > 1) return;
  host.app.send({ action: "set-sim", value });
};
simRow.append(simLabel, simInput, simHint, simApply);

// -- 统计 + 按钮 ---------------------------------------------------------------

const statRow = row("color: #8f96a3; flex: 0 0 auto; font-size: 11px;");
const btnRow = row("display: flex; gap: 6px; flex: 0 0 auto;");
const solveBtn = button("开始", "solve-toggle");
button("解算", "plan");
button("选区", "select-region");
button("角点", "select-region-corner");
button("预览", "preview");
button("停止", "stop");

// -- 日志 ----------------------------------------------------------------------

// 日志标题行 + 复制按钮
const logHead = row("display: flex; align-items: center; justify-content: space-between; flex: 0 0 auto; font-size: 11px; color: #8f96a3;");
const logTitle = document.createElement("span");
logTitle.textContent = "日志(可选中复制)";
const logCopy = document.createElement("button");
logCopy.textContent = "复制全部";
logCopy.title = "复制全部日志到剪贴板";
logCopy.style.cssText = applyCss;
logCopy.onclick = async () => {
  const text = logLines.join("\n");
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand("copy");
      ta.remove();
    } catch {
      ok = false;
    }
  }
  logCopy.textContent = ok ? "已复制" : "复制失败";
  setTimeout(() => (logCopy.textContent = "复制全部"), 1200);
};
logHead.append(logTitle, logCopy);

const logPane = row(
  "flex: 0 0 auto; height: 96px; overflow-y: auto; font: 10px/1.5 Consolas, monospace;" +
    " color: #9aa0ac; background: #14161a; border: 1px solid #2c2f38;" +
    " border-radius: 5px; padding: 4px 6px; white-space: pre-wrap;" +
    " user-select: text; cursor: text;",
);
const logLines: string[] = [];

function appendLog(line: string, level?: string): void {
  logLines.push(line);
  if (logLines.length > 100) logLines.shift();
  const div = document.createElement("div");
  div.textContent = line;
  if (level === "error") {
    div.style.color = "#ef8a8a";
    div.style.fontWeight = "bold";
  }
  logPane.appendChild(div);
  while (logPane.childElementCount > 100) logPane.removeChild(logPane.firstChild!);
  logPane.scrollTop = logPane.scrollHeight;
}

// -- 状态渲染 --------------------------------------------------------------------

const PHASE_TEXT: Record<string, string> = {
  idle: "● 待命",
  running: "● 运行中",
  paused: "● 已暂停",
};

function render(msg: any): void {
  const phase: string = msg?.phase ?? "idle";
  phaseDot.textContent = PHASE_TEXT[phase] ?? phase;
  phaseDot.style.color =
    phase === "running" ? "#5fd068" : phase === "paused" ? "#e8c268" : "#9aa0ac";
  solveBtn.textContent = phase === "running" ? "暂停" : phase === "paused" ? "继续" : "开始";

  msgRow.textContent = msg?.lastMessage ?? "待命";
  if (msg?.hasRegion === false) msgRow.textContent = "未框选棋盘区域 — 点「选区」框住游戏棋盘";

  const rect = msg?.boardRect as any;
  rectLabel.textContent = rect ? `${rect.x},${rect.y} ${rect.width}x${rect.height}` : "";
  if (rect) {
    const vals = [rect.x, rect.y, rect.width, rect.height];
    regionInputs.forEach((input, i) => {
      if (document.activeElement !== input) input.value = String(vals[i]);
    });
  }
  if (msg?.rows && document.activeElement !== rowsInput) rowsInput.value = String(msg.rows);
  if (msg?.cols && document.activeElement !== colsInput) colsInput.value = String(msg.cols);
  // 行列变化后重画预览网格(无需重新截图)
  if (previewMeta && (previewMeta.rows !== msg?.rows || previewMeta.cols !== msg?.cols)) {
    previewMeta.rows = msg?.rows;
    previewMeta.cols = msg?.cols;
    drawOverlay();
  }

  if (msg?.similarityThreshold !== undefined && document.activeElement !== simInput) {
    simInput.value = String(msg.similarityThreshold);
  }

  const scan = msg?.scan;
  const scanText = scan
    ? ` · 图案 ${scan.tileTypes ?? "?"} 种 · 识别 ${scan.recognized} (空 ${scan.emptyCount}, ${scan.elapsedMs}ms)` +
      ` · 阈值 ${scan.threshold ?? "?"}`
    : "";
  statRow.textContent =
    `步数 ${msg?.stats?.steps ?? 0} · 消除 ${msg?.stats?.cleared ?? 0} 对 · 失败 ${msg?.stats?.failures ?? 0}` +
    `${scanText} · ${msg?.rows ?? "?"}x${msg?.cols ?? "?"}`;
}

// -- 消息路由 ----------------------------------------------------------------------

host.app.onMessage((msg: any) => {
  if (msg?.type === "status") render(msg);
  else if (msg?.type === "preview") renderPreview(msg);
  else if (msg?.type === "log") appendLog(msg.line, msg.level);
  else if (msg?.type === "log-backfill") for (const line of msg.lines ?? []) appendLog(line);
});
console.log("[lianliankan-ui] handlers wired, sending hello");
void host.log.info("[ui] handlers wired, sending hello").catch(() => {});
host.app.send({ action: "hello" }); // 拉取状态 + 日志回填 + 预览
