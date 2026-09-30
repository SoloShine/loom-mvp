// recipe-runner 主进程：生命周期 + 热键编排 + invoke 入口 + recipes 目录 watch
// + UI 查询/动作路由（阶段 3：react 窗口的 req/res + state 推送）。
//
// 红线：Host / CLI / SDK 零改动——runner 是普通 App，平台能力全部经
// @mini/sdk 直通；engine 保持纯函数，真动作在 src/actions/ 组装注入。
//
// 并发模型（design「步骤之间永远无并行」承诺的运行期延伸）：
// - 同一 recipe 同时只允许一个 run（第二个返回 BUSY）；
// - 不同 recipe 的 run 可以同时受理（invoke 立即返回 runId，fire-and-forget
//   ——manager 的 invoke 120s 等待上限不约束 run 时长），但共享一条全局
//   串行链：desktop 动作（鼠标/键盘/剪贴板/文件）是全局共享状态，任何
//   时刻只允许一条动作链推进。纯计算型 recipe 也排同一条链——v0 不做
//   动作级互斥粒度，换来点击时序永远确定。
//
// 常驻语义：不声明 lifecycle（缺省 = 不闲置回收），热键注册后一直在。
// 窗口取舍（阶段 3 重估，design 回写）：窗口只由用户显式动作关闭——
// main 不做任何程序化收起（阶段 2 的「表单结束收窗」连用户手动打开的
// 窗口一起收，已废弃）；ui.* 步骤执行时窗口被隐藏则 focusSelf 拉回、
// 被销毁则重建一个（design 风险节「强制唤起/建窗」）。
//
// 直播轨迹：runRecipe 的 onStep 传 engine 的 trace 数组引用，main 按节流
// 推 {type:"state"} 让 UI 刷新；detail 读取时浅克隆各步（容器字段在结束
// 时回填，克隆取到当刻值）。

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { host } from "@mini/sdk";
import { runRecipe } from "./engine/interp";
import { resolveParams } from "./engine/params";
import { pushRun } from "./engine/trace";
import type { Recipe, RunRecord, TraceStep } from "./engine/types";
import { buildHostActions } from "./actions/host";
import { buildUtilActions } from "./actions/util";
import { buildUiActions, type ShowForm, type ShowFormPayload } from "./actions/ui";
import {
  buildParamFields, diffHotkeys, nextRunId, outsFromRun, planHotkeys, scanRecipes,
  type RecipeEntry, type ScannedFile,
} from "./registry";
import {
  deletePreset as withoutPreset, listPresets, savePreset as mergePreset,
  type PresetMap, type RecipeDetail, type RecipeSummary,
} from "./ui-logic";

const APP_DIR = process.env.MINI_APP_DIR ?? ".";
const RECIPES_DIR = path.join(APP_DIR, "recipes");
const WATCH_DEBOUNCE_MS = 300;
/** 表单网关自身兜底超时：略大于 engine 的 uiStepTimeoutMs(120s)，
 * 让步骤超时先赢错误归因，网关只负责清理挂起项与撤销窗口表单 */
const FORM_FALLBACK_TIMEOUT_MS = 125_000;
/** UI 窗口被销毁后表单需要时重建的缺省尺寸 */
const FORM_WINDOW = { type: "window" as const, width: 460, height: 560 };
/** 直播轨迹推送节流：循环类 recipe 每迭代多步落迹，逐条推会刷爆消息总线 */
const STATE_PUSH_THROTTLE_MS = 200;
/** UI 存活探针窗口：活着的 UI 对 state 推送的反应远快于此值 */
const UI_ALIVE_PROBE_MS = 1_000;
/** 重建窗口后等 UI ready（React 挂载）的宽限 */
const UI_READY_WAIT_MS = 8_000;

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// 状态推送：main → UI {type:"state"}，UI 收到后重拉 list/detail
// ---------------------------------------------------------------------------

function pushState(): void {
  host.ui.send({ type: "state" });
}

let statePushTimer: NodeJS.Timeout | null = null;
function pushStateThrottled(): void {
  if (statePushTimer) return;
  statePushTimer = setTimeout(() => {
    statePushTimer = null;
    pushState();
  }, STATE_PUSH_THROTTLE_MS);
}

// ---------------------------------------------------------------------------
// 表单网关：main ↔ UI 窗口协议（阶段 2 语义，字段不变）
//   main → UI: {type:"form", formId, ...payload} / {type:"form-dismiss", formId}
//   UI → main: {type:"form-result", formId, value} / {type:"form-cancel", formId}
// ---------------------------------------------------------------------------

interface PendingForm {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  onAbort: () => void;
  signal?: AbortSignal;
}

const pendingForms = new Map<number, PendingForm>();
let formSeq = 0;

// UI 存活探针：任一 UI→main 消息（ready/req/form-*）都点亮全部等待者。
// 动机：host dispatcher 的 window.focusSelf 恒返回 null（不透传 focusApp
// 的布尔结果），不能据此判断窗口是否存在——阶段 4 验收发现旧逻辑每次
// 交互步骤都误建一个 460x560 表单窗（窗口泄漏）。改用「推 state → 等
// 任意 UI 回包」探测；窗口活着必然轮询，超时才视为「用户已关掉全部
// 窗口」走重建。
const uiAliveWaiters: { resolve: (alive: boolean) => void; timer: NodeJS.Timeout }[] = [];

function notifyUiAlive(): void {
  for (const w of uiAliveWaiters.splice(0)) {
    clearTimeout(w.timer);
    w.resolve(true);
  }
}

function waitUiAlive(ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      const i = uiAliveWaiters.findIndex((w) => w.timer === timer);
      if (i >= 0) uiAliveWaiters.splice(i, 1);
      resolve(false);
    }, ms);
    uiAliveWaiters.push({ resolve, timer });
  });
}

host.ui.onMessage(async (m: unknown) => {
  if (!isRecord(m)) return;
  notifyUiAlive();
  if (m.type === "ready") {
    // 窗口就绪（React 挂载后上报）：留一条正面证据（渲染层崩溃只出现在
    // host 侧 renderer gone 日志里，成功路径本身无声），此后推送初始状态
    await host.log.info("UI ready").catch(() => {});
    pushState();
    return;
  }
  if (m.type === "req" && typeof m.action === "string") {
    void handleUiRequest(m);
    return;
  }
  if (typeof m.formId !== "number") return;
  if (m.type === "form-result") finishForm(m.formId, (p) => p.resolve(m.value));
  else if (m.type === "form-cancel") finishForm(m.formId, (p) => p.reject(new Error("用户取消")));
});

/** UI 请求路由：{type:"req", reqId, action, args} → {type:"res", reqId, ok, data|error} */
async function handleUiRequest(m: Record<string, unknown>): Promise<void> {
  const reqId = m.reqId;
  if (typeof reqId !== "number") return;
  const action = String(m.action);
  const args = isRecord(m.args) ? m.args : {};
  try {
    const data = await uiAction(action, args);
    host.ui.send({ type: "res", reqId, ok: true, data });
  } catch (e) {
    host.ui.send({ type: "res", reqId, ok: false, error: msg(e) });
  }
}

/** 表单终结（任一路径）：清理挂起项、撤销窗口表单、触发回调。
 * 不收窗（阶段 3 取舍：窗口只由用户显式动作关闭）。 */
function finishForm(formId: number, settle: (p: PendingForm) => void): void {
  const p = pendingForms.get(formId);
  if (!p) return;
  clearTimeout(p.timer);
  p.signal?.removeEventListener("abort", p.onAbort);
  pendingForms.delete(formId);
  host.ui.send({ type: "form-dismiss", formId });
  settle(p);
}

const showForm: ShowForm = async (payload: ShowFormPayload, signal) => {
  // 先唤起：隐藏窗口 focusSelf 拉回。focusSelf 返回值不可信（恒 null，
  // 见上方探针注释），改用存活探针判定窗口是否存在；探针超时 = 用户已
  // 关掉全部窗口 → 重建（design「强制唤起/建窗」）。重建后等 ready 再
  // 下发表单，避免消息早于 React 挂载丢失。
  await host.window.focusSelf().catch(() => {});
  pushState(); // 探针激励：活着的 UI 收到 state 会立刻回拉 list/detail
  const alive = await waitUiAlive(UI_ALIVE_PROBE_MS);
  if (!alive) {
    await host.window.create(FORM_WINDOW).catch(() => {});
    await waitUiAlive(UI_READY_WAIT_MS);
  }
  const formId = ++formSeq;
  return new Promise<unknown>((resolve, reject) => {
    const p: PendingForm = {
      resolve,
      reject,
      timer: setTimeout(() => finishForm(formId, (q) => q.reject(new Error("表单等待超时"))), FORM_FALLBACK_TIMEOUT_MS),
      onAbort: () => finishForm(formId, (q) => q.reject(new Error("已取消"))),
      signal,
    };
    if (signal?.aborted) {
      reject(new Error("已取消"));
      return;
    }
    signal?.addEventListener("abort", p.onAbort, { once: true });
    pendingForms.set(formId, p);
    host.ui.send({ type: "form", formId, ...payload });
  });
};

// ---------------------------------------------------------------------------
// 动作表组装（engine 注入）：host 直通 + runner util + ui 网关
// ---------------------------------------------------------------------------

const actions = {
  ...buildHostActions(),
  ...buildUtilActions(),
  ...buildUiActions(showForm),
};

// ---------------------------------------------------------------------------
// 全局串行链（desktop 动作全局互斥，见文件头注释）
// ---------------------------------------------------------------------------

let chainTail: Promise<void> = Promise.resolve();
function enqueue(task: () => Promise<void>): void {
  const next = chainTail.then(task);
  chainTail = next.catch(() => {});
}

// ---------------------------------------------------------------------------
// 扫描 / 热键 / watch
// ---------------------------------------------------------------------------

let entries = new Map<string, RecipeEntry>();
/** 本 App 注册成功的 combo → recipeId（先到先得，含对其它 App 的让位） */
const registeredHotkeys = new Map<string, string>();
let watcher: fs.FSWatcher | null = null;
let watchTimer: NodeJS.Timeout | null = null;

async function readRecipeFiles(): Promise<ScannedFile[]> {
  try {
    const names = await fsp.readdir(RECIPES_DIR);
    const yamlNames = names.filter((n) => n.endsWith(".yaml") || n.endsWith(".yml")).sort();
    return Promise.all(
      yamlNames.map(async (n) => ({ file: n, text: await fsp.readFile(path.join(RECIPES_DIR, n), "utf8") })),
    );
  } catch {
    return []; // 目录不存在 / 不可读 = 空集（onStart 会先 mkdir）
  }
}

/** 重扫 + 重注册：invalid 记入状态与日志不阻塞其它；热键只动变更项 */
async function scanAndSync(reason: string): Promise<void> {
  const list = scanRecipes(await readRecipeFiles());
  const nextEntries = new Map(list.map((e) => [e.id, e]));
  const { desired, conflicts } = planHotkeys(list);
  const { unregister, register } = diffHotkeys(registeredHotkeys, desired);

  for (const combo of unregister) {
    try {
      await host.hotkey.unregister(combo);
    } catch (e) {
      await host.log.warn(`热键注销失败: ${combo} (${msg(e)})`).catch(() => {});
    }
    registeredHotkeys.delete(combo);
  }
  const failed = new Set<string>();
  for (const { combo, recipeId } of register) {
    // register 失败 = 被系统或其它 App 占用（SDK 返回 false 不抛）
    let ok = false;
    try {
      ok = await host.hotkey.register(combo, () => void triggerHotkeyRun(recipeId));
    } catch (e) {
      await host.log.warn(`热键注册异常: ${combo} (${msg(e)})`).catch(() => {});
    }
    if (ok) registeredHotkeys.set(combo, recipeId);
    else failed.add(recipeId);
  }

  for (const e of list) {
    if (!e.ok || !e.recipe?.hotkey) continue;
    const ownerOk = registeredHotkeys.get(e.recipe.hotkey) === e.id;
    e.hotkeyState = ownerOk ? "registered" : "hotkey-conflict";
    if (e.hotkeyState === "hotkey-conflict") {
      await host.log.warn(
        `recipe ${e.id}: ${conflicts[e.id] ?? `热键 ${e.recipe.hotkey} 注册失败（可能被系统或其它 App 占用）`}`,
      ).catch(() => {});
    }
  }
  entries = nextEntries;

  const invalid = list.filter((e) => !e.ok);
  for (const e of invalid) {
    await host.log.warn(`recipe ${e.id} 无效（${reason}）: ${e.errors.join("; ")}`).catch(() => {});
  }
  for (const e of list) {
    for (const w of e.warnings) await host.log.warn(`recipe ${e.id}: ${w}`).catch(() => {});
  }
  pushState(); // recipes 变化（改完即生效）→ UI 刷新
}

function startWatch(): void {
  try {
    watcher = fs.watch(RECIPES_DIR, () => {
      // 300ms 防抖：编辑器保存常是「删+写」两次事件
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => { void scanAndSync("watch").catch(() => {}); }, WATCH_DEBOUNCE_MS);
    });
    watcher.on("error", (e) => { void host.log.warn(`recipes watch 异常: ${msg(e)}`).catch(() => {}); });
  } catch {
    // 目录不存在（onStart 已 mkdir，此处置竞态）：不 watch，invoke 兜底重读盘仍可用
  }
}

// ---------------------------------------------------------------------------
// UI 查询与动作（uiAction：单向投影的动作面，全部经 main）
// ---------------------------------------------------------------------------

/** 在途 run 的直播轨迹（recipeId → engine trace 数组引用 + 元信息） */
interface LiveRun {
  runId: string;
  startedAt: number;
  dryRun: boolean;
  steps: TraceStep[];
}

const liveRuns = new Map<string, LiveRun>();

function summaryOf(e: RecipeEntry, live?: LiveRun): RecipeSummary {
  return {
    id: e.id,
    name: e.recipe?.name ?? e.id,
    ok: e.ok,
    errors: e.errors,
    warnings: e.warnings,
    ...(e.recipe?.hotkey !== undefined ? { hotkey: e.recipe.hotkey } : {}),
    hotkeyState: e.hotkeyState,
    running: live !== undefined,
    ...(live !== undefined ? { runId: live.runId } : {}),
    stepCount: e.recipe?.steps.length ?? 0,
    paramCount: e.recipe?.params ? Object.keys(e.recipe.params).length : 0,
  };
}

function recipeSummaries(): RecipeSummary[] {
  return [...entries.values()].map((e) => summaryOf(e, liveRuns.get(e.id)));
}

/** 详情：头部元信息 + 参数表单（取值链预填）+ presets + 最近 runs + 选中轨迹。
 * 直播优先（在途 run）；否则历史（runIndex 时间序，缺省末位 = 最新）。 */
async function recipeDetail(recipeId: string, runIndex?: number): Promise<RecipeDetail> {
  const entry = entries.get(recipeId);
  if (!entry) throw new Error(`recipe 不存在: ${recipeId}`);
  const live = liveRuns.get(recipeId);
  const base = summaryOf(entry, live);
  const skeleton = {
    ...base,
    yamlPath: path.join(RECIPES_DIR, entry.file),
    onRun: "silent" as const,
    onerror: "notify" as const,
    declaredSteps: [] as RecipeDetail["declaredSteps"],
    paramFields: [] as RecipeDetail["paramFields"],
    presets: [],
    lastUsed: {} as Record<string, unknown>,
    runs: [] as RecipeDetail["runs"],
    runIndex: 0,
    trace: [] as TraceStep[],
    traceSource: "none" as const,
  };
  if (!entry.ok || !entry.recipe) return skeleton;

  const recipe = entry.recipe;
  const [lastUsedRaw, presetsRaw, runsRaw] = await Promise.all([
    host.storage.get(`params/${recipeId}/lastUsed`),
    host.storage.get(`params/${recipeId}/presets`),
    host.storage.get(`runs/${recipeId}`),
  ]);
  const lastUsed = isRecord(lastUsedRaw) ? lastUsedRaw : {};
  const presets = isRecord(presetsRaw) ? (presetsRaw as PresetMap) : {};
  const runs = Array.isArray(runsRaw) ? (runsRaw as RunRecord[]) : [];

  let trace: TraceStep[] = [];
  let traceSource: RecipeDetail["traceSource"] = "none";
  let resolvedIndex = 0;
  if (live) {
    trace = live.steps.map((s) => ({ ...s }));
    traceSource = "live";
  } else if (runs.length > 0) {
    resolvedIndex = typeof runIndex === "number" && Number.isInteger(runIndex)
      && runIndex >= 0 && runIndex < runs.length ? runIndex : runs.length - 1;
    trace = runs[resolvedIndex].steps;
    traceSource = "history";
  }

  return {
    ...base,
    yamlPath: path.join(RECIPES_DIR, entry.file),
    onRun: recipe.onRun === "ask" ? "ask" : "silent",
    onerror: recipe.onerror === "silent" ? "silent" : "notify",
    declaredSteps: recipe.steps,
    paramFields: buildParamFields(recipe.params ?? {}, resolveParams(recipe.params ?? {}, { lastUsed }).values),
    presets: listPresets(presets),
    lastUsed,
    runs: runs.map((r) => ({
      runId: r.runId,
      startedAt: r.startedAt,
      status: r.status,
      dryRun: r.dryRun,
      ms: r.ms,
      okCount: r.steps.filter((s) => s.status === "ok").length,
      steps: r.steps.length,
    })),
    runIndex: resolvedIndex,
    trace,
    traceSource,
  };
}

/** 参数表单预填：取值链在 override 之下解析（套用 preset 时叠加 preset 层） */
async function paramDefaults(recipeId: string, presetName?: string): Promise<Record<string, unknown>> {
  const entry = entries.get(recipeId);
  if (!entry || !entry.ok || !entry.recipe) throw new Error(`recipe 无效: ${recipeId}`);
  const defs = entry.recipe.params ?? {};
  const lastUsedRaw = await host.storage.get(`params/${recipeId}/lastUsed`);
  let preset: Record<string, unknown> | undefined;
  if (presetName !== undefined && presetName !== "") {
    const presetsRaw = await host.storage.get(`params/${recipeId}/presets`);
    const p = isRecord(presetsRaw) ? (presetsRaw as PresetMap)[presetName] : undefined;
    if (!isRecord(p)) throw new Error(`preset 不存在: ${presetName}`);
    preset = p;
  }
  return resolveParams(defs, {
    ...(preset !== undefined ? { preset } : {}),
    ...(isRecord(lastUsedRaw) ? { lastUsed: lastUsedRaw } : {}),
  }).values;
}

async function uiAction(action: string, args: Record<string, unknown>): Promise<unknown> {
  const recipeId = typeof args.recipe === "string" ? args.recipe : "";
  // UI 已在窗口里收集过表单（run/dryRun/rerun 携带表单值）：跳过 ask 弹窗
  const uiForm = { skipAskForm: true, ...(isRecord(args.params) ? { params: args.params } : {}) };
  switch (action) {
    case "list":
      return recipeSummaries();
    case "detail":
      return await recipeDetail(recipeId, typeof args.runIndex === "number" ? args.runIndex : undefined);
    case "getParamDefaults":
      return { values: await paramDefaults(recipeId) };
    case "applyPreset":
      return { values: await paramDefaults(recipeId, typeof args.preset === "string" ? args.preset : "") };
    case "run":
      return await startRun({ recipe: recipeId, ...uiForm });
    case "dryRun":
      return await startRun({ recipe: recipeId, dryRun: true, ...uiForm });
    case "rerun": {
      const fromStep = typeof args.fromStep === "string" ? args.fromStep : "";
      if (fromStep === "") throw new Error("rerun 需要 fromStep（顶层步骤 id）");
      return await startRun({ recipe: recipeId, fromStep, ...uiForm });
    }
    case "stop":
      return stopRuns(recipeId !== "" ? recipeId : undefined);
    case "savePreset": {
      const name = typeof args.name === "string" ? args.name : "";
      const values = isRecord(args.values) ? args.values : {};
      const key = `params/${recipeId}/presets`;
      const cur = await host.storage.get(key);
      await host.storage.set(key, mergePreset(isRecord(cur) ? (cur as PresetMap) : {}, name, values));
      pushState();
      return { ok: true };
    }
    case "deletePreset": {
      const name = typeof args.name === "string" ? args.name : "";
      const key = `params/${recipeId}/presets`;
      const cur = await host.storage.get(key);
      if (isRecord(cur)) {
        await host.storage.set(key, withoutPreset(cur as PresetMap, name));
        pushState();
      }
      return { ok: true };
    }
    case "copyPath": {
      const entry = entries.get(recipeId);
      if (!entry) throw new Error(`recipe 不存在: ${recipeId}`);
      await host.clipboard.writeText(path.join(RECIPES_DIR, entry.file));
      return { ok: true };
    }
    default:
      throw new Error(`未知 UI 动作: ${action}`);
  }
}

// ---------------------------------------------------------------------------
// run 生命周期
// ---------------------------------------------------------------------------

const activeRuns = new Map<string, { runId: string; controller: AbortController }>();

async function triggerHotkeyRun(recipeId: string): Promise<void> {
  try {
    const { runId } = await startRun({ recipe: recipeId });
    await host.log.info(`热键触发 ${recipeId} → run ${runId}`).catch(() => {});
  } catch (e) {
    // 热键路径没有其它反馈通道：失败给通知
    await host.notification.show({ title: "recipe-runner", body: `${recipeId}: ${msg(e)}` }).catch(() => {});
  }
}

/** invoke run / 热键触发 / UI 按钮共用入口：校验 + 受理（fire-and-forget），立即返回 runId */
async function startRun(args: Record<string, unknown>): Promise<{ runId: string }> {
  const recipeId = typeof args.recipe === "string" ? args.recipe : "";
  if (recipeId === "") throw new Error("缺少参数 recipe（recipe id）");
  let entry = entries.get(recipeId);
  if (!entry) {
    // 兜底重读盘：watch 300ms 防抖窗口内的外部写入 / watch 未建起
    await scanAndSync("invoke 兜底");
    entry = entries.get(recipeId);
  }
  if (!entry) throw new Error(`recipe 不存在: ${recipeId}（recipes/ 内无 ${recipeId}.yaml）`);
  if (!entry.ok || !entry.recipe) throw new Error(`recipe 无效: ${recipeId} — ${entry.errors.join("; ")}`);
  if (activeRuns.has(recipeId)) throw new Error(`BUSY: recipe ${recipeId} 已有 run 在途（先 invoke stop）`);

  const runId = nextRunId(recipeId);
  const controller = new AbortController();
  activeRuns.set(recipeId, { runId, controller });
  const recipe = entry.recipe;
  enqueue(() => executeRun(recipe, recipeId, runId, controller, args));
  pushState(); // 列表立即转「运行中」
  return { runId };
}

async function executeRun(
  recipe: Recipe,
  recipeId: string,
  runId: string,
  controller: AbortController,
  args: Record<string, unknown>,
): Promise<void> {
  const t0 = Date.now();
  const dryRun = args.dryRun === true;
  const live: LiveRun = { runId, startedAt: t0, dryRun, steps: [] };
  liveRuns.set(recipeId, live);
  try {
    // ---- 参数取值链：override > preset > lastUsed > default ----
    const [lastUsedRaw, presetsRaw] = await Promise.all([
      host.storage.get(`params/${recipeId}/lastUsed`),
      host.storage.get(`params/${recipeId}/presets`),
    ]);
    const presetName = typeof args.preset === "string" ? args.preset : "";
    const preset = presetName !== "" && isRecord(presetsRaw) ? presetsRaw[presetName] : undefined;
    const resolved = resolveParams(recipe.params ?? {}, {
      ...(isRecord(args.params) ? { override: args.params } : {}),
      ...(isRecord(preset) ? { preset } : {}),
      ...(isRecord(lastUsedRaw) ? { lastUsed: lastUsedRaw } : {}),
    });

    // onRun:ask 或 required 缺值 → 先弹表单（与 ui.* 同一 showForm 网关）。
    // UI 按钮路径带 skipAskForm（窗口里已收集过表单值）。
    if ((recipe.onRun === "ask" || resolved.missing.length > 0) && args.skipAskForm !== true) {
      const fields = buildParamFields(recipe.params ?? {}, resolved.values);
      const values = await showForm({ kind: "ask", title: `参数 — ${recipe.name ?? recipeId}`, fields }, controller.signal);
      if (!isRecord(values)) throw new Error("参数表单返回值无效");
      Object.assign(resolved.values, values);
    }
    if (Object.keys(resolved.values).length > 0) {
      await host.storage.set(`params/${recipeId}/lastUsed`, resolved.values);
    }

    // ---- 从第 N 步重跑：以上次 run 各步 out 为初始上下文 ----
    let replay: { fromStep: string; outs: Record<string, unknown> } | undefined;
    if (typeof args.fromStep === "string" && args.fromStep !== "") {
      const runs = await host.storage.get(`runs/${recipeId}`);
      const last = Array.isArray(runs) ? (runs[runs.length - 1] as RunRecord | undefined) : undefined;
      replay = { fromStep: args.fromStep, outs: outsFromRun(last) };
    }

    // ---- 执行（engine 纯函数 + 注入动作表；onStep 直播轨迹）----
    const result = await runRecipe(recipe, {
      params: resolved.values,
      actions,
      dryRun,
      signal: controller.signal,
      replay,
      onStep: (steps) => {
        live.steps = steps;
        pushStateThrottled();
      },
    });

    // ---- 收尾：轨迹落 storage（环形 10 次）+ 日志摘要 + 失败通知 ----
    const runsKey = `runs/${recipeId}`;
    const runsRaw = await host.storage.get(runsKey);
    const record: RunRecord = {
      ...result, runId, recipeId, startedAt: t0, dryRun,
    };
    await host.storage.set(runsKey, pushRun(Array.isArray(runsRaw) ? (runsRaw as RunRecord[]) : [], record));

    const okCount = result.steps.filter((s) => s.status === "ok").length;
    await host.log.info(
      `run ${runId} ${recipeId} → ${result.status} (${result.ms}ms, ok=${okCount}/${result.steps.length} 步${dryRun ? ", dry-run" : ""})`,
    ).catch(() => {});

    if (result.status === "error" && recipe.onerror !== "silent") {
      await host.notification.show({
        title: `配方失败: ${recipe.name ?? recipeId}`,
        body: `步骤 ${result.error?.stepId ?? "?"}: ${result.error?.message ?? "未知错误"}`,
      }).catch(() => {});
    }
  } catch (e) {
    // 编排层异常（表单取消 / storage 失败等）：run 未进 engine，不落轨迹，日志记因
    await host.log.error(`run ${runId} ${recipeId} 编排失败: ${msg(e)}`).catch(() => {});
  } finally {
    liveRuns.delete(recipeId);
    activeRuns.delete(recipeId);
    pushState(); // 运行结束 → UI 换成历史轨迹
  }
}

/** 取消在途 run（含已入队未启动的——入队即登记 AbortController） */
function stopRuns(recipeId?: string): { stopped: number } {
  const ids = recipeId !== undefined && recipeId !== "" ? [recipeId] : [...activeRuns.keys()];
  let stopped = 0;
  for (const id of ids) {
    const run = activeRuns.get(id);
    if (run) { run.controller.abort(); stopped++; }
  }
  return { stopped };
}

async function check(one?: string): Promise<unknown> {
  const list = scanRecipes(await readRecipeFiles());
  if (one !== undefined && one !== "") {
    const e = list.find((x) => x.id === one);
    if (!e) throw new Error(`recipe 不存在: ${one}（recipes/ 内无 ${one}.yaml）`);
    return { recipe: one, ok: e.ok, errors: e.errors, warnings: e.warnings };
  }
  return { recipes: list.map((e) => ({ id: e.id, ok: e.ok, errors: e.errors, warnings: e.warnings })) };
}

// ---------------------------------------------------------------------------
// App 生命周期与 invoke 入口
// ---------------------------------------------------------------------------

export async function onStart(): Promise<void> {
  await fsp.mkdir(RECIPES_DIR, { recursive: true });
  await scanAndSync("onStart");
  startWatch();
  await host.log.info(
    `recipe-runner started: ${entries.size} recipes, ${registeredHotkeys.size} hotkeys, watching ${RECIPES_DIR}`,
  );
}

export async function onStop(): Promise<void> {
  if (watchTimer) clearTimeout(watchTimer);
  if (statePushTimer) clearTimeout(statePushTimer);
  watcher?.close();
  for (const [, run] of activeRuns) run.controller.abort();
  // 热键注销是异步释放：fire-and-forget，失败只记日志
  for (const combo of registeredHotkeys.keys()) {
    host.hotkey.unregister(combo).catch((e) => { void host.log.warn(`热键注销失败: ${combo} (${msg(e)})`); });
  }
  await host.log.info("recipe-runner stopped");
}

export async function invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
  switch (command) {
    case "run":
      return await startRun(args ?? {});
    case "stop":
      return stopRuns(typeof args?.recipe === "string" ? args.recipe : undefined);
    case "check":
      return await check(typeof args?.recipe === "string" ? args.recipe : undefined);
    default:
      throw new Error(`未知命令: ${command}（可用: run / stop / check）`);
  }
}
