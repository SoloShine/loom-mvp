// engine 公共出口：main.ts（阶段 2 动作接线）与 tests 共用这一个入口打包。

export { parseRecipe, type ParseFail, type ParseOk } from "./parse";
export { runRecipe, DEFAULT_LIMITS } from "./interp";
export {
  OUT_MAX_BYTES, MAX_KEPT_RUNS, isTruncatedOut, pushRun, truncateOut, type TruncatedOut,
} from "./trace";
export { resolveParams, type ParamSources, type ResolvedParams } from "./params";
export {
  evalExpression, evalTemplate, isValidVarName, resolveArgs, scanStepRefs, type EvalScope,
} from "./expr";
export type {
  ActionCategory, ActionDef, ActionRunContext, ActionTable, ForSpec, Limits, ParamDef,
  ParamType, Recipe, RecipeStep, ReplayOptions, RunOptions, RunRecord, RunResult, TraceStep,
  TraceStatus,
} from "./types";
