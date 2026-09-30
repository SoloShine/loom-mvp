// parse：recipe YAML 文本 → Recipe。
//
// 三层校验（agent 生成错误在执行前拦截，不进运行时）：
// 1. YAML 语法；
// 2. recipes.schema.json（ajv，draft-07，唯一事实源——agent 生成与运行时共用）；
// 3. 语义检查（schema 表达不了的）：步骤 id 重复、控制流嵌套超限、
//    循环变量保留字、引用不存在的步骤 id（警告不强拒——引用处求值时
//    才是真错误，走错误即停）。
//
// 沿用 manifest.ts 模式：能收集的错误都收集完一次报出；返回值表达
// 成败，不抛异常；错误文案面向用户的中文。

import yaml from "js-yaml";
import Ajv from "ajv";
import recipeSchema from "../../recipes.schema.json";
import { isValidVarName, scanStepRefs } from "./expr";
import type { Recipe, RecipeStep } from "./types";

export interface ParseOk {
  ok: true;
  recipe: Recipe;
  warnings: string[];
}
export interface ParseFail {
  ok: false;
  errors: string[];
}

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(recipeSchema as unknown as object);

/** 收集模板字符串里的 steps.<id> 引用（args 深度 + when + for 声明） */
function collectTemplateStrings(step: RecipeStep, into: string[]): void {
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      if (v.includes("{{")) into.push(v);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v !== null && typeof v === "object") {
      Object.values(v).forEach(walk);
    }
  };
  walk(step.args);
  if (typeof step.when === "string") into.push(step.when);
  if (typeof step.for?.in === "string") into.push(step.for.in);
  if (typeof step.for?.times === "string") into.push(step.for.times);
}

export function parseRecipe(text: string): ParseOk | ParseFail {
  const errors: string[] = [];

  let doc: unknown;
  try {
    doc = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  } catch (e) {
    return { ok: false, errors: [`YAML 语法错误: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (doc === null || doc === undefined) return { ok: false, errors: ["recipe 为空"] };

  if (!validate(doc)) {
    for (const err of validate.errors ?? []) {
      // additionalProperties 类错误不带属性名，补进去否则用户无法定位
      const extra = err.params?.additionalProperty !== undefined
        ? `（未知属性: ${String(err.params.additionalProperty)}）`
        : "";
      errors.push(`${err.instancePath || "(根)"} ${err.message ?? "校验失败"}${extra}`);
    }
    return { ok: false, errors };
  }

  const recipe = doc as Recipe;
  const warnings: string[] = [];

  // ---- 语义检查（schema 通过后结构才可安全遍历）----
  const idPaths = new Map<string, string>();
  const templates: string[] = [];
  const walk = (steps: RecipeStep[] | undefined, path: string, insideLoop: boolean): void => {
    const list = steps ?? [];
    for (let i = 0; i < list.length; i++) {
      const step = list[i];
      const here = `${path}/${i}:${step.id}`;
      const seen = idPaths.get(step.id);
      if (seen) errors.push(`步骤 id 重复: ${step.id}（${seen} 与 ${here}）`);
      else idPaths.set(step.id, here);

      if (insideLoop && step.for) {
        // 唯一允许的嵌套是 if/loop 体；控制流套控制流超限（R1）
        errors.push(`控制流不能嵌套: ${here}（for 体内步骤不得再声明 for）`);
      }
      if (step.for?.each !== undefined && !isValidVarName(step.for.each)) {
        errors.push(`for.each 非法循环变量名: "${step.for.each}"（${here}；不得用保留字或 params/steps/env）`);
      }
      collectTemplateStrings(step, templates);
      walk(step.steps, here, insideLoop || step.for !== undefined);
    }
  };
  walk(recipe.steps, "steps", false);

  // 引用不存在的步骤 id：警告不拒（静态扫不出动态求值的真值，
  // 强拒会挡住合法的防御性写法）
  const referenced = new Set<string>();
  for (const tpl of templates) {
    for (const ref of scanStepRefs(tpl)) referenced.add(ref);
  }
  for (const ref of referenced) {
    if (!idPaths.has(ref)) warnings.push(`引用了不存在的步骤 id: ${ref}（求值时将按错误即停处理）`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, recipe, warnings };
}
