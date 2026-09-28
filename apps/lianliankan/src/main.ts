import fs from "node:fs";
import path from "node:path";
import { host, type SpawnHandle } from "@mini/sdk";

/**
 * 连连看求解器 — Mini App 粘合层。
 *
 * 职责划分(PRD 第 19 节迁移映射):
 *   截图  → host.screen.captureRegion(物理像素)
 *   点击  → host.mouse.click
 *   识别 + 求解 → Python helper(vision/ solver/ 原样迁移,JSON Lines 协议)
 *   浮窗  → host.ui 消息总线
 *   区域 / 行列 / 阈值 → host.storage(替代 config.yaml)
 *
 * 屏幕是唯一事实来源:每一步都重新截图识别,不维护增量状态。
 */

// ---------------------------------------------------------------------------
// settings & state
// ---------------------------------------------------------------------------

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Settings {
  rows: number;
  cols: number;
  clickIntervalMs: number;
  settleMs: number;
  loopDelayMs: number;
  maxVerifyFailures: number;
  tileInnerRatio: number;
  similarityThreshold: number;
  emptyVarThreshold: number;
  emptyEdgeThreshold: number;
  emptyBgDiffThreshold: number;
}

const DEFAULT_SETTINGS: Settings = {
  rows: 10,
  cols: 14,
  clickIntervalMs: 100,
  settleMs: 300,
  loopDelayMs: 300,
  maxVerifyFailures: 3,
  tileInnerRatio: 0.8,
  similarityThreshold: 0.8,
  emptyVarThreshold: 12.0,
  emptyEdgeThreshold: 0.02,
  emptyBgDiffThreshold: 10.0,
};

type Phase = "idle" | "running" | "paused";

const appDir = process.env.MINI_APP_DIR ?? ".";

let settings: Settings = { ...DEFAULT_SETTINGS };
let boardRect: Rect | null = null;
let phase: Phase = "idle";
const stats = { steps: 0, cleared: 0, failures: 0 };
let lastScan: Record<string, unknown> | null = null;
let lastMessage = "待命";
const logBuffer: string[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function nowTime(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function thresholds(): Record<string, number> {
  return {
    tile_inner_ratio: settings.tileInnerRatio,
    similarity_threshold: settings.similarityThreshold,
    empty_var_threshold: settings.emptyVarThreshold,
    empty_edge_threshold: settings.emptyEdgeThreshold,
    empty_bg_diff_threshold: settings.emptyBgDiffThreshold,
  };
}

// ---------------------------------------------------------------------------
// helper process (stateful session: backgrounds + failed pairs)
// ---------------------------------------------------------------------------

interface HelperSession {
  request<T = any>(op: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  kill(): void;
  handle: SpawnHandle;
}

let helper: HelperSession | null = null;

async function ensureHelper(): Promise<HelperSession> {
  if (helper) return helper;

  const venvPython = path.join(appDir, ".venv", "Scripts", "python.exe");
  const command = fs.existsSync(venvPython) ? venvPython : "python";
  const helperMain = path.join(appDir, "helper", "jsonl_main.py");
  const { handle, onMessage } = await host.process.spawnJson({
    command,
    args: [helperMain],
    cwd: path.join(appDir, "helper"),
  });

  const pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  let seq = 0;

  const unsubscribe = onMessage((msg: any) => {
    if (typeof msg?.id !== "number") return; // helper 的普通日志行,已被 host 记入 app log
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    clearTimeout(waiter.timer);
    if (msg.ok) waiter.resolve(msg);
    else waiter.reject(new Error(String(msg.error ?? "helper error")));
  });

  handle.onExit((code) => {
    unsubscribe();
    if (helper && helper.handle === handle) helper = null;    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`helper 进程退出 (${code})`));
    }
    pending.clear();
    void host.log.warn(`helper 进程退出 (${code}),下次操作将自动重启`);
  });

  const request = <T = any>(
    op: string,
    params: Record<string, unknown> = {},
    timeoutMs = 60_000,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`helper 响应超时: ${op}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      void handle.write(JSON.stringify({ id, op, ...params }) + "\n");
    });

  const session: HelperSession = { request, kill: () => void handle.kill(), handle };
  helper = session;

  // 首次请求包含 cv2 导入时间,给长超时
  await request("configure", { rows: settings.rows, cols: settings.cols, thresholds: thresholds() }, 120_000);
  return helper;
}

// ---------------------------------------------------------------------------
// ui / log helpers
// ---------------------------------------------------------------------------

function broadcast(): void {
  host.ui.send({
    type: "status",
    phase,
    lastMessage,
    stats: { ...stats },
    scan: lastScan,
    rows: settings.rows,
    cols: settings.cols,
    hasRegion: boardRect !== null,
    boardRect,
    similarityThreshold: settings.similarityThreshold,
  });
}

async function log(message: string, level: "info" | "error" = "info"): Promise<void> {
  lastMessage = message;
  const line = `${nowTime()} ${message}`;
  logBuffer.push(line);
  if (logBuffer.length > 100) logBuffer.shift();
  if (level === "error") await host.log.error(message);
  else await host.log.info(message);
  broadcast();
  host.ui.send({ type: "log", line, level });
}

// ---------------------------------------------------------------------------
// preview(截图 + 识别叠加,浮窗可视化确认框选/行列/匹配)
// ---------------------------------------------------------------------------

async function sendPreview(quiet = false): Promise<void> {
  if (!boardRect) {
    host.ui.send({ type: "preview", error: "未框选棋盘区域 — 先点「选区」框住游戏棋盘" });
    if (!quiet) await log("预览: 尚未框选区域,先用「选区」或手填区域坐标");
    return;
  }
  try {
    const session = await ensureHelper();
    const img = await host.screen.captureRegion(boardRect);
    const scan = await session.request("scan", {
      image_b64: b64(img.dataUrl),
      origin_x: boardRect.x,
      origin_y: boardRect.y,
    });
    lastScan = {
      recognized: scan.recognized,
      tileTypes: scan.tile_types,
      emptyCount: scan.empty_count,
      tilesLeft: scan.tiles_left,
      elapsedMs: scan.elapsed_ms,
    threshold: scan.threshold_used,
    };
    const rect = boardRect;
    host.ui.send({
      type: "preview",
      image: img.dataUrl,
      rect,
      rows: settings.rows,
      cols: settings.cols,
      // 相对区域左上角的坐标,供浮窗叠加识别结果
      tiles: (scan.tiles as any[]).map((t) => ({
        row: t.row,
        col: t.col,
        rx: t.x - rect.x,
        ry: t.y - rect.y,
        rw: t.width,
        rh: t.height,
        empty: t.empty,
        type: t.type_id,
      })),
      move: scan.move ?? null,
      recognized: scan.recognized,
      tile_types: scan.tile_types,
      empty_count: scan.empty_count,
      elapsed_ms: scan.elapsed_ms,
    });
    if (!quiet) await log(`预览: 识别 ${scan.recognized} 图块 / ${scan.tile_types} 类型 (${scan.elapsed_ms}ms)`);
  } catch (e: any) {
    await log(`预览失败: ${e?.message ?? e}`);
  }
}

// ---------------------------------------------------------------------------
// solve step
// ---------------------------------------------------------------------------

interface TileRef {
  row: number;
  col: number;
  center_x: number;
  center_y: number;
}

function b64(dataUrl: string): string {
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

async function captureBoardImage(): Promise<string> {
  const img = await host.screen.captureRegion(boardRect!);
  return b64(img.dataUrl);
}

interface ScanState {
  cleared: boolean;
  tilesLeft: number;
  recognized: number;
  oddRatio: number;
  tiles: Array<{
    row: number;
    col: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

interface MovePlan {
  a: TileRef;
  b: TileRef;
  confidence?: number;
}

/** 扫一次盘:识别 + 成对校验。校验失败抛错(区域错位/识别异常)。 */
async function scanBoard(skipGridHeal = false): Promise<ScanState> {
  if (!boardRect) throw new Error("未框选棋盘区域,先执行 select-region");
  const session = await ensureHelper();
  const imageB64 = await captureBoardImage();
  const scan = await session.request("scan", {
    image_b64: imageB64,
    origin_x: boardRect.x,
    origin_y: boardRect.y,
  });
  lastScan = {
    recognized: scan.recognized,
    tileTypes: scan.tile_types,
    emptyCount: scan.empty_count,
    tilesLeft: scan.tiles_left,
    elapsedMs: scan.elapsed_ms,
    threshold: scan.threshold_used,
  };
  broadcast();

  // 成对校验(两档):连连看每种图案数量必为偶数。30%~60% 奇 = 识别
  // 噪声,警告但继续(逐对验证失败会重扫重规划,闭环自纠);
  // >60% 通常意味着区域错位,留到规划后判断。
  const counts = new Map<number, number>();
  for (const row of scan.board as number[][]) {
    for (const v of row) if (v > 0) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let oddTypes = 0;
  for (const n of counts.values()) if (n % 2 === 1) oddTypes += 1;
  const oddRatio = counts.size > 0 ? oddTypes / counts.size : 0;

  // 行列自纠:高奇数最常见根因是行列设置过时(重新框选前的旧值残留、
  // 换关改盘)。用同一张截图重推行列,试扫 better 才采纳,否则回退 ——
  // 残局外侧行被消空时检测会少算行,不能盲信检测结果。
  if (oddRatio > 0.3 && !skipGridHeal) {
    const healed = await tryHealGrid(imageB64, oddRatio);
    if (healed) return healed;
  }

  if (oddRatio > 0.3) {
    const hint =
      settings.similarityThreshold > 0
        ? `区域若已变化(换关/页面滚动)请重新「选区」;也可调低相似度阈值(当前 ${settings.similarityThreshold})重试`
        : `通常无碍,带疑点继续,靠逐对验证自纠`;
    void log(
      `【警告】棋盘校验:${counts.size} 种图案中 ${oddTypes} 种数量为奇数。${hint}`,
      "error",
    );
  }
  const suspectCount = Number((scan as { suspect_count?: number }).suspect_count ?? 0);
  if (suspectCount > 0) {
    void log(
      `【提示】${suspectCount} 块处于选中/特征不可信状态(多为上一对验证失败的残留),本次规划避开`,
    );
  }
  return {
    cleared: scan.cleared,
    tilesLeft: scan.tiles_left,
    recognized: scan.recognized,
    oddRatio,
    tiles: scan.tiles,
  };
}

/** 行列自纠:试扫检测出的新行列,奇偶占比未更好则回退原行列并重扫
 *  (保持 helper 会话状态与最终行列一致)。无需试验时返回 null。 */
async function tryHealGrid(imageB64: string, badRatio: number): Promise<ScanState | null> {
  const session = await ensureHelper();
  let det: { found: boolean; rows?: number; cols?: number } | null = null;
  try {
    det = await session.request("detect-grid", { image_b64: imageB64 });
  } catch {
    det = null;
  }
  const prevRows = settings.rows;
  const prevCols = settings.cols;
  if (!det?.found || (det.rows === prevRows && det.cols === prevCols)) return null;
  await applyGrid(det.rows!, det.cols!);
  const alt = await scanBoard(true);
  if (alt.oddRatio < badRatio) {
    await log(
      `【自动纠正】行列 ${prevRows}x${prevCols} 与当前棋盘不符,已改为 ${det.rows}x${det.cols}` +
        `(奇偶占比 ${Math.round(badRatio * 100)}% → ${Math.round(alt.oddRatio * 100)}%)`,
    );
    return alt;
  }
  await applyGrid(prevRows, prevCols);
  await log(
    `试验行列 ${det.rows}x${det.cols} 未更优(奇偶 ${Math.round(alt.oddRatio * 100)}%),保留 ${prevRows}x${prevCols}`,
  );
  return scanBoard(true);
}

/** 离线解出当前盘面的完整连消计划(helper 在虚拟盘上推演,不点击)。 */
async function planMoves(): Promise<{
  status: string;
  moves: MovePlan[];
  remaining: number;
}> {
  const session = await ensureHelper();
  return session.request("solve-board", {}, 60_000);
}

/** 执行一对点击并验证消除;两次尝试,失败调用方重扫重规划。 */
async function executeMove(
  a: TileRef,
  b: TileRef,
  tiles: ScanState["tiles"],
): Promise<"OK" | "VERIFY_FAILED"> {
  const session = await ensureHelper();
  const coord = `(${a.row},${a.col}) <-> (${b.row},${b.col})`;
  const clickA: any = await host.mouse.click(a.center_x, a.center_y);
  await sleep(settings.clickIntervalMs);
  const clickB: any = await host.mouse.click(b.center_x, b.center_y);
  await host.log.info(
    `点击 ${coord} @ (${a.center_x},${a.center_y}) diag=${JSON.stringify(clickA?.diag ?? null)}`,
  );
  await sleep(settings.settleMs);
  await log(`点击 ${coord},验证中…`);

  const tileOf = (t: TileRef) => tiles.find((x) => x.row === t.row && x.col === t.col)!;
  // 与原 controller 一致:两次尝试,间隔 300ms 等消除动画播完
  for (let attempt = 1; attempt <= 2; attempt++) {
    const crops = [];
    for (const ref of [a, b]) {
      const t = tileOf(ref);
      const img = await host.screen.captureRegion({
        x: t.x,
        y: t.y,
        width: t.width,
        height: t.height,
      });
      crops.push({ row: t.row, col: t.col, image_b64: b64(img.dataUrl) });
    }
    const verdict = await session.request<{ learned: boolean; empties: boolean[] }>(
      "verify",
      { tiles: crops },
    );
    if (verdict.learned) {
      await log(`已消除 ${coord}`);
      // 实时刷新浮窗预览(底图已是消除后的棋盘);稍等消除动画播完再截
      setTimeout(() => void sendPreview(true), Math.max(500, settings.settleMs));
      return "OK";
    }
    if (attempt === 1) await sleep(300);
  }
  await session.request("exclude-pair", {
    a: { row: a.row, col: a.col },
    b: { row: b.row, col: b.col },
  });
  await log(`验证失败 ${coord},已加入排除表,将重扫换目标`);
  return "VERIFY_FAILED";
}

/** 解算预演:扫描 + 离线解出整盘计划,只把步骤打进日志,不下子。
 *  开局异常在这里就地暴露,调好阈值/区域再点「开始」。 */
async function planOnly(): Promise<unknown> {
  const scan = await scanBoard();
  if (scan.cleared) {
    await log("解算预演:棋盘已清空");
    return { status: "EMPTY" };
  }
  const plan = await planMoves();
  const thrText = `阈值 ${lastScan?.threshold ?? "?"}`;
  await log(`解算预演:识别 ${scan.recognized} 图块 / ${lastScan?.tileTypes ?? "?"} 类型 · ${thrText}`);
  if (scan.oddRatio > 0.3) {
    await log(
      `【警告】分类存在噪声(${Math.round(scan.oddRatio * 100)}% 奇数),带疑点继续,执行时靠逐对验证自纠`,
      "error",
    );
  }
  if (plan.moves.length === 0) {
    await log(
      "【异常】无可消除对 —— 多半是同图案被拆散成了单例,把相似度阈值调低(如 0.6)后重新「解算」",
      "error",
    );
    return { status: "NO_MOVE" };
  }
  if (plan.status === "CLEARED") {
    await log(`解算预演:共 ${plan.moves.length} 对,可连消至全清,点「开始」执行`);
  } else {
    await log(
      `【警告】解算预演:仅解出 ${plan.moves.length} 对(剩 ${plan.remaining}) —— 贪心顺序所限,执行时会自动重扫续解`,
      "error",
    );
  }
  const shown = plan.moves.slice(0, 12);
  shown.forEach((mv, i) => {
    const conf = mv.confidence !== undefined ? ` (置信度 ${mv.confidence})` : "";
    void log(`  ${i + 1}. (${mv.a.row},${mv.a.col}) <-> (${mv.b.row},${mv.b.col})${conf}`);
  });
  if (plan.moves.length > shown.length) {
    void log(`  …共 ${plan.moves.length} 对,其余略`);
  }
  return { status: plan.status, moves: plan.moves.length };
}

async function runLoop(): Promise<void> {
  phase = "running";
  stats.steps = 0;
  stats.cleared = 0;
  stats.failures = 0;
  await log("自动求解开始");
  let consecutiveFailures = 0;
  let final = "STOPPED";
  // 旧帧防线:消除成功后重扫,盘面却没变小 = 截到了消除前的旧帧,重试
  let lastKnownTiles = 0;
  let eliminatedSinceScan = 0;
  try {
    for (;;) {
      const gate = phase as Phase; // as-cast: 阻断赋值收窄,phase 会被异步回调修改
      if (gate === "idle") break; // stop 已请求
      if (gate === "paused") {
        await sleep(200);
        continue;
      }

      // ---- 重规划:扫一次盘,离线解出整盘计划(消除是确定性的,
      //      识别一次即可推演全部后续着法,不必每步都重新识别)----
      let scan = await scanBoard();
      if (lastKnownTiles > 0 && eliminatedSinceScan > 0 && scan.tilesLeft >= lastKnownTiles) {
        await log("【警告】消除后盘面未见变化,疑似截屏拿到旧帧,重扫一次");
        await sleep(400);
        scan = await scanBoard();
        if (scan.tilesLeft >= lastKnownTiles) {
          await log("【错误】重扫后盘面仍无变化,停止(请确认游戏窗口没有被遮挡/最小化)", "error");
          final = "STALE";
          break;
        }
      }
      lastKnownTiles = scan.tilesLeft;
      eliminatedSinceScan = 0;
      if (scan.cleared) {
        final = "EMPTY";
        await log("棋盘已清空");
        void sendPreview(true);
        break;
      }
      const plan = await planMoves();
      if (plan.moves.length === 0) {
        if (scan.oddRatio > 0.6) {
          throw new Error(
            `分类崩溃且无着法(${scan.recognized} 图块)—— 多半是区域与当前棋盘错位,请重新「选区」`,
          );
        }
        await log(`无可消除对 (剩余 ${scan.tilesLeft} 图块,识别 ${scan.recognized})`);
        final = "NO_MOVE";
        break;
      }
      plan.moves.sort((x, y) => (y.confidence ?? 0) - (x.confidence ?? 0)); // 高置信度先行
      await log(
        plan.status === "CLEARED"
          ? `规划:本次可连消 ${plan.moves.length} 对直至全清,按置信度执行`
          : `规划:解出 ${plan.moves.length} 对后暂无着法,执行完重扫续解`,
      );

      // ---- 按计划执行:只有验证失败才中断重规划 ----
      for (const mv of plan.moves) {
        if ((phase as Phase) === "idle") break;
        while ((phase as Phase) === "paused") await sleep(200);
        const verdict = await executeMove(mv.a, mv.b, scan.tiles);
        stats.steps += 1;
        if (verdict === "OK") {
          stats.cleared += 1;
          eliminatedSinceScan += 1;
          consecutiveFailures = 0;
          continue;
        }
        stats.failures += 1;
        consecutiveFailures += 1;
        break; // 重扫重规划
      }
      if ((phase as Phase) === "idle") {
        final = "STOPPED";
        break;
      }
      if (consecutiveFailures >= settings.maxVerifyFailures) {
        final = "FAILED";
        await log(`连续验证失败 ${consecutiveFailures} 次,自动模式终止`);
        break;
      }
      await sleep(settings.loopDelayMs);
    }
  } catch (e: any) {
    final = "ERROR";
    lastMessage = `出错: ${e?.message ?? e}`;
    await log(`【错误】${e?.message ?? e}`, "error");
    await host.log.error(String(e?.stack ?? e));
  }
  phase = "idle";
  broadcast();
  await host.log.info(
    `自动求解结束: ${final} (步数 ${stats.steps},消除 ${stats.cleared} 对,失败 ${stats.failures})`,
  );
  void host.notification.show({
    title: "连连看求解器",
    body: `${final} — ${lastMessage}`.slice(0, 220),
  });
}

function startSolve(): { phase: Phase; toggled: boolean } {
  const current: Phase = phase;
  if (current === "running") {
    phase = "paused";
    void log("已暂停 (再按一次继续)");
    return { phase, toggled: true };
  }
  if (current === "paused") {
    phase = "running";
    void log("继续自动求解");
    return { phase, toggled: true };
  }
  void runLoop();
  return { phase: "running", toggled: false };
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function persistSettings(): Promise<void> {
  await host.storage.set("settings", settings);
}

async function reconfigureHelper(): Promise<void> {
  const session = await ensureHelper();
  await session.request("configure", {
    rows: settings.rows,
    cols: settings.cols,
    thresholds: thresholds(),
  });
}

async function selectRegion(): Promise<unknown> {
  // 默认选区:调 Windows 自带截图工具(Win+Shift+S 同款),在真实屏幕上
  // 框选;宿主用模板匹配从整屏截图里像素级找回矩形
  const rect = await host.screen.selectRegion();
  if (!rect) {
    await log("选区已取消(未完成截图或超时)");
    return { selected: false };
  }
  await saveRegion(rect);
  return { selected: true, rect, rows: settings.rows, cols: settings.cols };
}

async function selectRegionCorner(): Promise<unknown> {
  // 备用选区:在真实屏幕上点两个角,坐标由系统光标直接给出,零转换。
  // 适合不方便调起系统截图工具的场景。
  const p1 = await waitCornerClick("角点选区:请点击棋盘【左上角】图块的左上角 (Esc 取消)");
  if (typeof p1 === "string") {
    await log(p1 === "timeout" ? "角点选区超时(90 秒无点击)" : "选区已取消");
    return { selected: false };
  }
  await log(`左上角已记录 (${p1.x},${p1.y}),请点击棋盘【右下角】`);
  const p2 = await waitCornerClick("角点选区:请点击棋盘【右下角】图块的右下角 (Esc 取消)");
  if (typeof p2 === "string") {
    await log(p2 === "timeout" ? "角点选区超时(90 秒无点击)" : "选区已取消");
    return { selected: false };
  }
  const rect: Rect = {
    x: Math.min(p1.x, p2.x),
    y: Math.min(p1.y, p2.y),
    width: Math.abs(p2.x - p1.x),
    height: Math.abs(p2.y - p1.y),
  };
  if (rect.width < 40 || rect.height < 40) {
    await log("选区太小,请重新选取");
    return { selected: false };
  }
  await saveRegion(rect);
  return { selected: true, rect, rows: settings.rows, cols: settings.cols };
}

/** 保存选区 + 开局满盘自动识别行列(失败保留当前值)+ 刷新预览 */
async function saveRegion(rect: Rect): Promise<void> {
  boardRect = rect;
  await host.storage.set("board", rect);
  await log(`棋盘区域已保存: ${rect.x},${rect.y} ${rect.width}x${rect.height}`);

  try {
    const session = await ensureHelper();
    const detection = await session.request("detect-grid", {
      image_b64: await captureBoardImage(),
    });
    if (detection.found) {
      await applyGrid(detection.rows, detection.cols);
      await log(`自动识别行列: ${settings.rows}x${settings.cols} (规整度 ${detection.error})`);
    } else {
      await log("行列自动识别失败,可在浮窗或 set-grid 手动填写");
    }
  } catch (e: any) {
    await log(`行列识别出错: ${e?.message ?? e}`);
  }
  await sendPreview();
}

async function waitCornerClick(
  hint: string,
): Promise<{ x: number; y: number } | "cancelled" | "timeout"> {
  await log(hint);
  const res = await host.mouse.waitClick();
  // 点击落在游戏上,焦点随之过去;全屏窗口层会盖住置顶面板,
  // 必须把面板拉回来,下一条提示才看得见
  void host.window.focusSelf().catch(() => {});
  if (typeof res?.x === "number") return { x: res.x, y: res.y };
  return "timeout" in res ? "timeout" : "cancelled";
}

async function applyGrid(rows: number, cols: number): Promise<void> {
  settings.rows = rows;
  settings.cols = cols;
  await persistSettings();
  await reconfigureHelper();
  broadcast();
}

async function applyRegion(rect: Rect): Promise<void> {
  boardRect = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(20, Math.round(rect.width)),
    height: Math.max(20, Math.round(rect.height)),
  };
  await host.storage.set("board", boardRect);
  broadcast();
}

async function setGrid(args: Record<string, unknown>): Promise<unknown> {
  const rows = Number(args?.rows);
  const cols = Number(args?.cols);
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 2 || cols < 2 || rows > 30 || cols > 30) {
    throw new Error("用法: set-grid --args '{\"rows\":10,\"cols\":14}'(2~30)");
  }
  await applyGrid(rows, cols);
  await log(`行列已设置: ${rows}x${cols}`);
  return { rows, cols };
}

function statusSnapshot(): unknown {
  return {
    phase,
    stats: { ...stats },
    lastScan,
    lastMessage,
    boardRect,
    settings: { ...settings },
  };
}

async function scanProbe(args: Record<string, unknown>): Promise<unknown> {
  if (!boardRect) throw new Error("未框选棋盘区域,先执行 select-region");
  const session = await ensureHelper();
  const rect = (args?.rect as Rect | undefined) ?? boardRect;
  const scan = await session.request("scan", {
    image_b64: b64((await host.screen.captureRegion(rect)).dataUrl),
    origin_x: rect.x,
    origin_y: rect.y,
  });
  lastScan = {
    recognized: scan.recognized,
    tileTypes: scan.tile_types,
    emptyCount: scan.empty_count,
    tilesLeft: scan.tiles_left,
    elapsedMs: scan.elapsed_ms,
    threshold: scan.threshold_used,
  };
  broadcast();
  const result: Record<string, unknown> = {
    board: scan.board,
    recognized: scan.recognized,
    tile_types: scan.tile_types,
    empty_count: scan.empty_count,
    move: scan.move,
    elapsed_ms: scan.elapsed_ms,
  };
  if (args?.with_image) result.image_b64 = b64((await host.screen.captureRegion(rect)).dataUrl);
  return result;
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

export async function onStart(): Promise<void> {
  const savedSettings = await host.storage.get("settings");
  if (savedSettings && typeof savedSettings === "object") {
    settings = { ...DEFAULT_SETTINGS, ...(savedSettings as Settings) };
    // 迁移:0/0.6/0.65 是中间实验版的阈值;分类器已回退到原版实现,
    // 回到原版验证过的默认 0.8(终局不顺时可在面板临时调低一档)
    if ([0, 0.6, 0.65].includes(settings.similarityThreshold)) {
      settings.similarityThreshold = 0.8;
      await host.storage.set("settings", settings);
    }
  }
  const savedBoard = await host.storage.get("board");
  if (savedBoard && typeof savedBoard === "object") boardRect = savedBoard as Rect;
  await host.log.info(`lianliankan started (region: ${boardRect ? "已配置" : "未配置"})`);
  broadcast();
}

export async function onStop(): Promise<void> {
  phase = "idle";
  if (helper) {
    helper.kill();
    helper = null;
  }
  await host.log.info("lianliankan stopped");
}

// 浮窗按钮 / 输入框 → 这里
host.ui.onMessage((msg: any) => {
  const action = msg?.action;
  if (action === "hello") {
    broadcast();
    host.ui.send({ type: "log-backfill", lines: [...logBuffer] });
    void sendPreview();
    return;
  }
  if (action === "solve-toggle") {
    startSolve();
    return;
  }
  if (action === "stop") {
    if (phase !== "idle") void log("已请求停止");
    phase = "idle";
    broadcast();
    return;
  }
  if (action === "preview") {
    void sendPreview();
    return;
  }
  if (action === "plan") {
    void invoke("plan").catch((e: any) => void log(`【错误】${e?.message ?? e}`, "error"));
    return;
  }
  if (action === "select-region") {
    phase = "idle";
    void invoke("select-region");
    return;
  }
  if (action === "select-region-corner") {
    phase = "idle";
    void invoke("select-region-corner");
    return;
  }
  if (action === "set-grid") {
    void invoke("set-grid", { rows: msg?.rows, cols: msg?.cols }).catch((e: any) =>
      void log(`行列设置失败: ${e?.message ?? e}`),
    );
    return;
  }
  if (action === "set-sim") {
    void (async () => {
      const value = Number(msg?.value);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        await log("相似度阈值需在 0~1(0=自动)");
        return;
      }
      settings.similarityThreshold = value;
      await persistSettings();
      await reconfigureHelper().catch((e: any) => void log(`helper 重配置失败: ${e?.message ?? e}`));
      await log(`相似度阈值:固定 ${value}`);
      broadcast();
    })();
    return;
  }
  if (action === "set-region") {
    const r = msg?.rect ?? {};
    void applyRegion({ x: Number(r.x), y: Number(r.y), width: Number(r.width), height: Number(r.height) })
      .then(() => sendPreview())
      .catch((e: any) => void log(`区域设置失败: ${e?.message ?? e}`));
  }
});

export async function invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
  switch (command) {
    case "solve":
      // 热键语义:idle→开始,running→暂停,paused→继续
      return startSolve();
    case "step": {
      if (phase !== "idle") throw new Error("自动求解进行中,先停止再单步");
      const scan = await scanBoard();
      if (scan.cleared) {
        await log("棋盘已清空");
        return { status: "EMPTY" };
      }
      const plan = await planMoves();
      if (plan.moves.length === 0) {
        await log(`无可消除对 (剩余 ${scan.tilesLeft} 图块,识别 ${scan.recognized})`);
        return { status: "NO_MOVE" };
      }
      stats.steps += 1;
      const verdict = await executeMove(plan.moves[0].a, plan.moves[0].b, scan.tiles);
      if (verdict === "OK") stats.cleared += 1;
      else stats.failures += 1;
      broadcast();
      return { status: verdict };
    }
    case "stop": {
      const wasActive = phase !== "idle";
      phase = "idle";
      if (wasActive) await log("已请求停止");
      return { stopped: wasActive };
    }
    case "select-region":
      return selectRegion();
    case "select-region-corner":
      return selectRegionCorner();
    case "plan":
      return planOnly();
    case "set-grid":
      return setGrid(args ?? {});
    case "set-region": {
      const r = (args?.rect ?? {}) as Rect;
      if (![r.x, r.y, r.width, r.height].every((v) => Number.isFinite(Number(v)))) {
        throw new Error("用法: set-region --args '{\"rect\":{\"x\":..,\"y\":..,\"width\":..,\"height\":..}}'");
      }
      await applyRegion({ x: Number(r.x), y: Number(r.y), width: Number(r.width), height: Number(r.height) });
      await log(`区域已设置: ${boardRect!.x},${boardRect!.y} ${boardRect!.width}x${boardRect!.height}`);
      return { rect: boardRect };
    }
    case "status":
      return statusSnapshot();
    case "scan-probe":
      return scanProbe(args ?? {});
    case "hide":
      // CLI/外部也能收面板(host.window.hide 同一通道)
      return host.window.hide();
    case "selftest": {
      // helper 经 host.process.spawn 全链路自检(合成图,无游戏)
      const session = await ensureHelper();
      const result = await session.request("selftest", {}, 120_000);
      await host.log.info(`helper selftest: ${result.ok ? "通过" : "失败"} ${JSON.stringify(result)}`);
      return result;
    }
    default:
      throw new Error(`unknown command: ${command}`);
  }
}
