// UI 纯函数层：schema→form 字段值处理 / required 校验 / preset 操作 /
// 轨迹行分组与声明叠加 / 展示格式化，以及 main↔UI 协议的共享数据形状。
//
// 不 import react / DOM / @mini/sdk——ui.tsx（浏览器）与 main.ts（node 侧
// 的 preset 写入）共用同一实现，tests 经 esbuild 现场编译单测（无 react
// 依赖，先例同 helpers.registry.cjs）。类型只做 type-only 引用，打包期擦除。
//
// __truncated 的判定在此重写而不 import engine/trace：trace.ts 引用 Buffer
//（truncateOut 用），拖进浏览器 bundle 是一颗地雷；判定本身只是形状检查。

import type { UiField } from "./actions/ui";
import type { RecipeStep, TraceStep } from "./engine/types";

// ---------------------------------------------------------------------------
// main ↔ UI 协议数据形状（main.ts 组装，ui.tsx 消费）
// ---------------------------------------------------------------------------

export interface RecipeSummary {
  id: string;
  name: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  hotkey?: string;
  hotkeyState: "none" | "registered" | "hotkey-conflict" | "pending";
  /** 有在途 run（含已入队未启动） */
  running: boolean;
  runId?: string;
  stepCount: number;
  paramCount: number;
}

export interface RunSummary {
  runId: string;
  startedAt: number;
  status: "ok" | "error" | "cancelled";
  dryRun: boolean;
  ms: number;
  okCount: number;
  steps: number;
}

export interface PresetEntry {
  name: string;
  values: Record<string, unknown>;
}

export interface RecipeDetail extends RecipeSummary {
  yamlPath: string;
  onRun: "silent" | "ask";
  onerror: "notify" | "silent";
  /** recipe 声明骨架（pending 叠加与重跑入口选择用） */
  declaredSteps: RecipeStep[];
  /** 预填取值链当前值（override 层之外）的字段表 */
  paramFields: UiField[];
  presets: PresetEntry[];
  lastUsed: Record<string, unknown>;
  /** 时间序（末位 = 最新）；UI 下拉倒序展示 */
  runs: RunSummary[];
  /** runs 里当前选中的下标（从 0 起，时间序） */
  runIndex: number;
  trace: TraceStep[];
  traceSource: "live" | "history" | "none";
}

// ---------------------------------------------------------------------------
// schema→form 字段值（params 表单与 ui.ask 共用，design 取舍表）
// ---------------------------------------------------------------------------

export interface FormValues {
  [name: string]: unknown;
}

/** number 字段的输入串 → 数值：空串 / 非有限数 = undefined（未填） */
function coerceNumber(raw: unknown): number | undefined {
  const s = String(raw ?? "").trim();
  if (s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 表单初值：预填值优先，缺省回落字段默认，再按类型给空位
 * （string/select → ""、boolean → false、number → undefined）。
 */
export function seedFormValues(fields: UiField[], prefill?: Record<string, unknown>): FormValues {
  const values: FormValues = {};
  for (const f of fields) {
    const v = prefill?.[f.name] !== undefined ? prefill[f.name] : f.default;
    if (v !== undefined && v !== null) values[f.name] = v;
    else if (f.type === "boolean") values[f.name] = false;
    else if (f.type === "select") values[f.name] = firstOption(f);
    else if (f.type === "string") values[f.name] = "";
    // number：undefined（未填）
  }
  return values;
}

function firstOption(f: UiField): string {
  const first = (f.options ?? [])[0];
  return first === undefined ? "" : typeof first === "string" ? first : first.value;
}

/** 受控输入的展示值：unknown → string（boolean 字段用 checked，不走这里） */
export function valueToInput(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  return String(v);
}

/**
 * 提交前定型：number 字段编辑期存原始串（受控输入不能清用户的半截输入），
 * 提交时才转数值；其余类型原样。
 */
export function finalizeFormValues(fields: UiField[], values: FormValues): FormValues {
  const out: FormValues = {};
  for (const f of fields) {
    const v = values[f.name];
    out[f.name] = f.type === "number" ? coerceNumber(v) : v;
  }
  return out;
}

/** required 校验：缺失项的显示名列表（undefined / null / 空串 / 空数字输入） */
export function validateFields(fields: UiField[], values: FormValues): string[] {
  const missing: string[] = [];
  for (const f of fields) {
    if (!f.required) continue;
    const v = f.type === "number" ? coerceNumber(values[f.name]) : values[f.name];
    if (v === undefined || v === null || v === "") missing.push(f.label ?? f.name);
  }
  return missing;
}

// ---------------------------------------------------------------------------
// presets（纯操作；storage 读写与协议在 main.ts）
// ---------------------------------------------------------------------------

export type PresetMap = Record<string, Record<string, unknown>>;

export function savePreset(presets: PresetMap, name: string, values: FormValues): PresetMap {
  const n = name.trim();
  if (n === "") throw new Error("preset 名不能为空");
  return { ...presets, [n]: { ...values } };
}

export function deletePreset(presets: PresetMap, name: string): PresetMap {
  const next = { ...presets };
  delete next[name];
  return next;
}

/** 名字排序的展示列表（确定性顺序，UI 不再排） */
export function listPresets(presets: PresetMap): PresetEntry[] {
  return Object.keys(presets).sort().map((name) => ({ name, values: presets[name] }));
}

// ---------------------------------------------------------------------------
// 轨迹行（步骤清单 × 最近 run 轨迹叠加）
// ---------------------------------------------------------------------------

export type TraceRow =
  | { kind: "step"; step: TraceStep }
  | { kind: "container"; step: TraceStep; children: TraceStep[] };

/**
 * 线性轨迹 → 行结构：`action: "for"` 的容器行收录其后带 iter 的子步骤行，
 * 直到第一个不带 iter 的行（下一个顶层步骤）。markRemaining 落的跳过占位
 * 不带 iter，作顶层行渲染（engine 已知边界：未开始的迭代不落迹）。
 */
export function groupTraceSteps(steps: TraceStep[]): TraceRow[] {
  const rows: TraceRow[] = [];
  let container: Extract<TraceRow, { kind: "container" }> | null = null;
  for (const s of steps) {
    if (s.action === "for" && s.iter === undefined) {
      container = { kind: "container", step: s, children: [] };
      rows.push(container);
    } else if (container && s.iter !== undefined) {
      container.children.push(s);
    } else {
      container = null;
      rows.push({ kind: "step", step: s });
    }
  }
  return rows;
}

/** 声明骨架线性化：容器展开一遍（子步骤单份，无 iter——是骨架不是执行序） */
export function linearizeSteps(steps: RecipeStep[]): RecipeStep[] {
  const out: RecipeStep[] = [];
  const walk = (list: RecipeStep[]): void => {
    for (const s of list) {
      out.push(s);
      if (s.steps) walk(s.steps);
    }
  };
  walk(steps);
  return out;
}

/**
 * pending 叠加：声明骨架里轨迹从未出现过该 id 的步骤（在途 run 尚未执行到、
 * 或轨迹来自不完整的历史记录）。按声明顺序返回，渲染在轨迹行之后。
 */
export function pendingSteps(declared: RecipeStep[], trace: TraceStep[]): RecipeStep[] {
  const seen = new Set(trace.map((s) => s.id));
  return linearizeSteps(declared).filter((s) => !seen.has(s.id));
}

/** 重跑入口候选：仅顶层步骤（fromStep 语义：循环体子 id 不接受） */
export function topLevelSteps(steps: RecipeStep[]): { id: string; action: string }[] {
  return steps.map((s) => ({ id: s.id, action: s.for ? "for" : s.action ?? "" }));
}

// ---------------------------------------------------------------------------
// 展示格式化
// ---------------------------------------------------------------------------

/** 轨迹里 out 的截断形状（engine/trace.ts 的 TruncatedOut；此处只判形状） */
export function isTruncatedOut(v: unknown): v is { __truncated: true; byteLength: number; preview: string } {
  return typeof v === "object" && v !== null && (v as { __truncated?: unknown }).__truncated === true;
}

/** out 展示文本：截断值显示 byteLength + preview；正常值 JSON 化并限长 */
export function formatOutValue(out: unknown, cap = 500): string {
  if (out === undefined) return "";
  if (isTruncatedOut(out)) return `(截断 ${out.byteLength}B) ${out.preview}…`;
  let s: string;
  try {
    s = typeof out === "string" ? out : JSON.stringify(out) ?? "null";
  } catch {
    s = String(out);
  }
  return s.length > cap ? `${s.slice(0, cap)}…` : s;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** HH:MM:SS（本地时区字段的确定性拼装，测试可断言） */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
