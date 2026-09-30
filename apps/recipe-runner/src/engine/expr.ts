// 表达式求值与 {{ }} 模板插值。
//
// 信任模型：直接用 Function 构造器求值，无沙箱——recipe 是可信内容，
// 信任层级与 App 代码等同（PRD §16 / design.md 取舍表）。自造 DSL 是
// 最大深渊，不重蹈。

export interface EvalScope {
  params: Record<string, unknown>;
  steps: Record<string, Record<string, unknown>>;
  env: { now: number };
  /** 循环变量（键名已经过 schema/parse 的标识符与保留字校验） */
  vars: Record<string, unknown>;
}

/** ES 保留字与上下文名不得作循环变量名：它们要当 Function 形参用 */
const FORBIDDEN_VAR_NAMES = new Set([
  "params", "steps", "env",
  "arguments", "await", "break", "case", "catch", "class", "const", "continue",
  "debugger", "default", "delete", "do", "else", "enum", "export", "extends",
  "false", "finally", "for", "function", "if", "import", "in", "instanceof",
  "new", "null", "return", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with", "yield", "let", "static",
  "implements", "interface", "package", "private", "protected", "public",
]);

export function isValidVarName(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !FORBIDDEN_VAR_NAMES.has(name);
}

/** 单一 JS 表达式求值；语法/运行错误原样抛出（= 该步失败，走错误即停） */
export function evalExpression(expr: string, scope: EvalScope): unknown {
  const names = ["params", "steps", "env", ...Object.keys(scope.vars)];
  const values: unknown[] = [scope.params, scope.steps, scope.env, ...Object.values(scope.vars)];
  const fn = new Function(...names, `"use strict"; return (${expr});`);
  return fn(...values);
}

// 整值恰为单一 {{ }}：前后允许空白（YAML 引号内常见），捕获组内不得再出现
// "{{"（否则视为多段插值，如 "{{a}}{{b}}"）。
const WHOLE_EXPR_RE = /^\s*\{\{([\s\S]*?)\}\}\s*$/;
const SEGMENT_RE = /\{\{([\s\S]+?)\}\}/g;

function stringifySegment(value: unknown): string {
  // 插值时空值渲染为空串（不是 "undefined"），对象走 JSON 而非 "[object Object]"
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * 求值一个模板字符串：
 * - 整值恰为单一 {{ expr }} → 返回原始类型（不字符串化），类型化引用靠它；
 * - 其余 → 逐段插值为字符串。
 */
export function evalTemplate(tpl: string, scope: EvalScope): unknown {
  const whole = tpl.match(WHOLE_EXPR_RE);
  if (whole && !whole[1].includes("{{")) return evalExpression(whole[1], scope);
  return tpl.replace(SEGMENT_RE, (_, expr: string) => stringifySegment(evalExpression(expr, scope)));
}

/** args 深度解析：字符串过模板，数组/对象递归，其余原样 */
export function resolveArgs(args: Record<string, unknown>, scope: EvalScope): Record<string, unknown> {
  const resolve = (value: unknown): unknown => {
    if (typeof value === "string") return evalTemplate(value, scope);
    if (Array.isArray(value)) return value.map(resolve);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = resolve(v);
      return out;
    }
    return value;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = resolve(v);
  return out;
}

/**
 * 静态扫描步骤引用了哪些 steps.<id>（支持 steps.x 与 steps["x"] 两种写法）。
 * 只用于 parse 期「引用不存在的步骤 id」警告——不求值，纯文本层。
 */
export function scanStepRefs(text: string): string[] {
  const refs: string[] = [];
  const re = /\bsteps(?:\.([A-Za-z_$][A-Za-z0-9_$]*)|\[\s*["']([^"']+)["']\s*\])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) refs.push(m[1] ?? m[2]);
  return refs;
}
