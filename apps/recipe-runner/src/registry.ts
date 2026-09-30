// 编排纯逻辑（可单测，不碰 fs/storage/SDK）：扫描解析、热键计划（先到先得
// + 冲突标记）、热键增量（重扫时只动变更项）、params 表单字段构建、上次
// run 的 out 提取、runId 生成。main.ts 负责真实 IO 接线。

import { parseRecipe } from "./engine/parse";
import type { ParamDef, Recipe, RunRecord } from "./engine/types";
import type { UiField } from "./actions/ui";

export interface ScannedFile {
  /** 文件名（如 rename-downloads.yaml） */
  file: string;
  text: string;
}

export type HotkeyState = "none" | "registered" | "hotkey-conflict" | "pending";

export interface RecipeEntry {
  /** 寻址键 = 文件名去扩展名（schema 要求 id 与文件名一致，此处强校验） */
  id: string;
  file: string;
  ok: boolean;
  recipe?: Recipe;
  errors: string[];
  warnings: string[];
  /** 热键注册结果（main.ts 注册后回写；UI 列表可见） */
  hotkeyState: HotkeyState;
}

function stemOf(file: string): string {
  const i = file.lastIndexOf(".");
  return i > 0 ? file.slice(0, i) : file;
}

/**
 * 扫描解析：每个 yaml 独立 parse，失败记入该条目（invalid 不阻塞其它）。
 * 按 id 排序保证热键「先到先得」的确定性（文件系统顺序不可依赖）。
 */
export function scanRecipes(inputs: ScannedFile[]): RecipeEntry[] {
  const entries = inputs.map(({ file, text }) => {
    const id = stemOf(file);
    const parsed = parseRecipe(text);
    if (!parsed.ok) {
      return { id, file, ok: false, errors: parsed.errors, warnings: [], hotkeyState: "pending" as HotkeyState };
    }
    if (parsed.recipe.id !== id) {
      return {
        id, file, ok: false,
        errors: [`recipe id (${parsed.recipe.id}) 与文件名 (${id}) 不一致（schema 约定二者一致）`],
        warnings: parsed.warnings,
        hotkeyState: "pending" as HotkeyState,
      };
    }
    return {
      id, file, ok: true, recipe: parsed.recipe, errors: [], warnings: parsed.warnings,
      hotkeyState: (parsed.recipe.hotkey ? "pending" : "none") as HotkeyState,
    };
  });
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return entries;
}

export interface HotkeyPlan {
  /** 本次扫描后应当生效的注册表：combo → recipeId */
  desired: Map<string, string>;
  /** recipeId → 冲突原因（扫描内重复声明） */
  conflicts: Record<string, string>;
}

/** 热键计划：先到先得（按 id 排序），同 combo 后到者标冲突不抢占 */
export function planHotkeys(entries: RecipeEntry[]): HotkeyPlan {
  const desired = new Map<string, string>();
  const conflicts: Record<string, string> = {};
  for (const e of entries) {
    if (!e.ok || !e.recipe?.hotkey) continue;
    const combo = e.recipe.hotkey;
    const owner = desired.get(combo);
    if (owner !== undefined) {
      conflicts[e.id] = `热键 ${combo} 与 ${owner} 冲突（先到先得，不抢占）`;
      continue;
    }
    desired.set(combo, e.id);
  }
  return { desired, conflicts };
}

export interface HotkeyDiff {
  /** owner 变更或已移除的 combo：先注销 */
  unregister: string[];
  /** 需要新注册的 combo → recipeId */
  register: { combo: string; recipeId: string }[];
}

/**
 * 已注册表 → 目标表的增量。重扫时不做全量重注册：unregister 是异步释放
 * （windows-pitfalls），无谓的注销/重注册会放大 stop→start 竞态窗口。
 */
export function diffHotkeys(registered: Map<string, string>, desired: Map<string, string>): HotkeyDiff {
  const unregister: string[] = [];
  for (const [combo, owner] of registered) {
    if (desired.get(combo) !== owner) unregister.push(combo);
  }
  const register: { combo: string; recipeId: string }[] = [];
  for (const [combo, recipeId] of desired) {
    if (registered.get(combo) === recipeId) continue;
    register.push({ combo, recipeId });
  }
  return { unregister, register };
}

/**
 * params 表单字段（onRun:ask / required 缺值时弹出）：全部参数按声明顺序
 * 预填取值链当前值（override > preset > lastUsed > default）。
 */
export function buildParamFields(
  defs: Record<string, ParamDef>,
  values: Record<string, unknown>,
): UiField[] {
  return Object.entries(defs).map(([name, def]) => {
    const field: UiField = {
      name,
      type: def.type,
      ...(def.label !== undefined ? { label: def.label } : {}),
      ...(def.required ? { required: true } : {}),
      default: values[name] !== undefined ? values[name] : def.default,
      ...(def.options !== undefined ? { options: def.options } : {}),
    };
    return field;
  });
}

/** 从上次 run 记录提取各步骤 out（从第 N 步重跑的初始上下文）。
 * 轨迹里的 out 是截断值（超 4KB 只存摘要）——重跑引用超限 out 时拿到
 * 摘要对象，属已知边界（截图类大 out 本就该在 recipe 内即时落盘）。 */
export function outsFromRun(record: RunRecord | null | undefined): Record<string, unknown> {
  const outs: Record<string, unknown> = {};
  if (!record) return outs;
  for (const s of record.steps) {
    if ((s.status === "ok" || s.status === "replayed") && s.out !== undefined) {
      // 循环体子步骤按迭代顺序覆盖：末次迭代值胜出（重入迭代无定义）
      outs[s.id] = s.out;
    }
  }
  return outs;
}

/** runId：<recipeId>-<8 位定宽 36 进制时间戳>-<短随机>。
 * 时间戳定宽补零：runId 字典序 = 时间序（日志/列表可直排）。 */
export function nextRunId(recipeId: string, now: number = Date.now()): string {
  return `${recipeId}-${now.toString(36).padStart(8, "0")}-${Math.random().toString(36).slice(2, 6)}`;
}
