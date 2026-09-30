// ui.* 交互动作：ui.ask / ui.confirm / ui.menu。
//
// 转发协议（design）：动作不直接碰窗口，经 main.ts 注入的 showForm 网关
// （先唤起窗口再显示表单）；返回值即该步 out。用户取消 = 抛错走错误即停
// （与 files.select* 的「取消返回 null」区分——对话框选空是合法输入，
// confirm/menu 的取消是放弃流程）。
//
// 表单字段 schema 与 params 共用同一形状（string/number/boolean/select），
// 阶段 3 的 schema→form 渲染器两处复用。

import type { ActionTable, ParamType } from "../engine/types";

export interface UiField {
  name: string;
  label?: string;
  type: ParamType;
  required?: boolean;
  /** 预填值（params 表单按取值链预填；ui.ask 用声明默认值） */
  default?: unknown;
  /** type=select 候选项：纯字符串或 {value,label} */
  options?: (string | { value: string; label?: string })[];
}

export interface ShowFormPayload {
  kind: "ask" | "confirm" | "menu";
  title?: string;
  body?: string;
  /** kind=ask */
  fields?: UiField[];
  /** kind=menu */
  items?: { value: string; label?: string }[];
}

/** main.ts 侧实现的表单网关：唤起窗口 → 显示 → 等待结果（signal 可中断） */
export type ShowForm = (payload: ShowFormPayload, signal?: AbortSignal) => Promise<unknown>;

export function buildUiActions(showForm: ShowForm): ActionTable {
  return {
    "ui.ask": {
      category: "interactive",
      run: async (args, ctx) => {
        const fields = normalizeFields(args.fields);
        if (fields.length === 0) throw new Error("ui.ask 需要 fields（至少一个字段，形状同 params）");
        const values = await showForm({
          kind: "ask",
          ...(typeof args.title === "string" ? { title: args.title } : {}),
          fields,
        }, ctx.signal);
        if (values === null || values === undefined || typeof values !== "object") {
          throw new Error("ui.ask 表单返回值无效");
        }
        // required 兜底校验（UI 侧已拦，协议层再守一道）
        for (const f of fields) {
          const v = (values as Record<string, unknown>)[f.name];
          if (f.required && (v === undefined || v === null || v === "")) {
            throw new Error(`必填字段缺失: ${f.name}`);
          }
        }
        return values;
      },
    },
    "ui.confirm": {
      category: "interactive",
      run: async (args, ctx) => {
        const confirmed = await showForm({
          kind: "confirm",
          title: typeof args.title === "string" ? args.title : "确认",
          ...(typeof args.body === "string" ? { body: args.body } : {}),
        }, ctx.signal);
        if (confirmed !== true) throw new Error("用户取消");
        return true;
      },
    },
    "ui.menu": {
      category: "interactive",
      run: async (args, ctx) => {
        const raw = args.items;
        if (!Array.isArray(raw) || raw.length === 0) throw new Error("ui.menu 需要 items（至少一项）");
        const items = raw.map((it) => {
          if (typeof it === "string") return { value: it };
          if (it && typeof it === "object" && typeof (it as { value?: unknown }).value === "string") {
            const o = it as { value: string; label?: unknown };
            return typeof o.label === "string" ? { value: o.value, label: o.label } : { value: o.value };
          }
          throw new Error("ui.menu 的 items 项必须是字符串或 {value,label}");
        });
        const picked = await showForm({
          kind: "menu",
          ...(typeof args.title === "string" ? { title: args.title } : {}),
          items,
        }, ctx.signal);
        if (picked === undefined || picked === null) throw new Error("用户取消");
        return picked;
      },
    },
  };
}

/** recipe 里的 fields 声明（Record 或数组）→ 规整后的字段数组 */
export function normalizeFields(input: unknown): UiField[] {
  if (Array.isArray(input)) {
    return input.map((f) => normalizeField(f, `(fields[${input.indexOf(f)}])`));
  }
  if (input && typeof input === "object") {
    return Object.entries(input as Record<string, unknown>).map(([name, def]) => normalizeField(def, name, name));
  }
  return [];
}

function normalizeField(def: unknown, where: string, name?: string): UiField {
  if (def === null || typeof def !== "object") throw new Error(`字段 ${where} 声明无效（须是 {type,...} 对象）`);
  const d = def as Record<string, unknown>;
  const type = d.type;
  if (type !== "string" && type !== "number" && type !== "boolean" && type !== "select") {
    throw new Error(`字段 ${where} 的 type 必须是 string|number|boolean|select`);
  }
  if (typeof name !== "string" || name === "") throw new Error(`字段 ${where} 缺少名称`);
  const field: UiField = { name, type };
  if (typeof d.label === "string") field.label = d.label;
  if (d.required === true) field.required = true;
  if (d.default !== undefined) field.default = d.default;
  if (type === "select") {
    if (!Array.isArray(d.options) || d.options.length === 0) {
      throw new Error(`字段 ${name}（select）需要非空 options`);
    }
    field.options = d.options.map((o) => {
      if (typeof o === "string") return o;
      if (o && typeof o === "object" && typeof (o as { value?: unknown }).value === "string") {
        const ob = o as { value: string; label?: unknown };
        return typeof ob.label === "string" ? { value: ob.value, label: ob.label } : { value: ob.value };
      }
      throw new Error(`字段 ${name} 的 options 项必须是字符串或 {value,label}`);
    });
  }
  return field;
}
