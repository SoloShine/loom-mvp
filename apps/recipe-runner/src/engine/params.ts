// 参数取值链纯函数：per-run override > preset > lastUsed > 声明默认值。
//
// 「用上次那组值」是高频诉求（file-organizer 的 lastDir 已验证该心智）。
// 引擎只做覆盖顺序与缺值判定；preset / lastUsed 的存取在 main.ts 侧
// （host.storage 的 params/<recipeId>/presets 与 lastUsed）。

import type { ParamDef } from "./types";

export interface ParamSources {
  /** per-run override（invoke run { params } 直传） */
  override?: Record<string, unknown>;
  /** 命名参数集（表单「另存为 / 套用」；不进 recipe 文件） */
  preset?: Record<string, unknown>;
  /** 上次表单值（runner storage 按 recipe 记忆） */
  lastUsed?: Record<string, unknown>;
}

export interface ResolvedParams {
  values: Record<string, unknown>;
  /** required 且四层都无值的参数名：无论 onRun 何种模式都必须先弹表单 */
  missing: string[];
}

/** 判「无值」：undefined / null 都算（storage 读回的 null 同样不可用） */
function hasValue(v: unknown): boolean {
  return v !== undefined && v !== null;
}

export function resolveParams(
  defs: Record<string, ParamDef>,
  sources: ParamSources,
): ResolvedParams {
  const values: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const [key, def] of Object.entries(defs)) {
    const v = [sources.override?.[key], sources.preset?.[key], sources.lastUsed?.[key], def.default]
      .find(hasValue);
    if (hasValue(v)) values[key] = v;
    else if (def.required) missing.push(key);
    // 非必填且无值：不写 key（表达式里引用得到 undefined，与 JS 语义一致）
  }
  return { values, missing };
}
