// interp：recipe 线性解释循环。
//
// 语义锁死（design.md FAQ）：顺序 + when 条件 + for each/times + 错误即停；
// 步骤之间永远无并行（并发只允许存在于单个动作内部，如 js.eval 的
// Promise.all）。engine 不 import @mini/sdk / electron——动作经注入表
// dispatch，测试用 fake actions。
//
// 保护参数（缺省，recipe 可经 limits 覆盖）：for 最大迭代 1000、单步
// 30s、ui.* 类 120s、run 总超时 10min。超限 = 错误即停。
// 协作取消：步间检查点（循环按迭代加密度）；动作内部可经 ctx.signal
// 自行中断。循环中断时未开始的迭代不落迹。

import { evalTemplate, resolveArgs, type EvalScope } from "./expr";
import { truncateOut } from "./trace";
import type {
  ActionDef, ActionTable, Recipe, RecipeStep, RunOptions, RunResult, TraceStep,
} from "./types";

/** 保护参数缺省值（recipe.limits 逐字段覆盖） */
export const DEFAULT_LIMITS = {
  maxIterations: 1000,
  stepTimeoutMs: 30_000,
  uiStepTimeoutMs: 120_000,
  runTimeoutMs: 600_000,
} as const;

type Halt = { kind: "error"; stepId: string; message: string } | { kind: "cancelled" };

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** dry-run 下 notify 类照真执行，文案前缀标记（design 语义表） */
function prefixDryRun(args: Record<string, unknown>): Record<string, unknown> {
  const next = { ...args };
  if (typeof next.title === "string") next.title = `[dry-run] ${next.title}`;
  else if (typeof next.body === "string") next.body = `[dry-run] ${next.body}`;
  return next;
}

export async function runRecipe(recipe: Recipe, options: RunOptions): Promise<RunResult> {
  const limits = { ...DEFAULT_LIMITS, ...recipe.limits };
  const nowFn = options.now ?? Date.now;
  const startMs = nowFn();
  const deadline = startMs + limits.runTimeoutMs;
  const trace: TraceStep[] = [];
  // 运行期上下文里的 out 保留全量；落迹时才 truncateOut（重跑要用真值）
  const stepsCtx: Record<string, Record<string, unknown>> = {};
  let halted: Halt | null = null;

  const mkScope = (vars: Record<string, unknown>): EvalScope => ({
    params: options.params ?? {},
    steps: stepsCtx,
    env: { now: startMs },
    vars,
  });

  // ---- 重跑边界：只接受顶层步骤 id（重入循环迭代无定义）----
  let replayBoundary = -1;
  if (options.replay) {
    const idx = recipe.steps.findIndex((s) => s.id === options.replay!.fromStep);
    if (idx < 0) {
      const nested = new Set<string>();
      const collect = (steps: RecipeStep[] | undefined): void => steps?.forEach((s) => {
        nested.add(s.id); collect(s.steps);
      });
      collect(recipe.steps);
      if (nested.has(options.replay.fromStep)) {
        throw new Error(`fromStep 必须是顶层步骤 id（循环体步骤不支持重跑入口）: ${options.replay.fromStep}`);
      }
      throw new Error(`fromStep 不存在: ${options.replay.fromStep}`);
    }
    replayBoundary = idx;
  }

  const checkHalt = (stepId: string): Halt | null => {
    if (options.signal?.aborted) return { kind: "cancelled" };
    if (nowFn() > deadline) {
      return { kind: "error", stepId, message: "run 总超时（可用 limits.runTimeoutMs 覆盖）" };
    }
    return null;
  };

  const stepActionName = (step: RecipeStep): string => (step.for ? "for" : step.action ?? "");

  /** 落迹统一入口：push + onStep 直播通知（传数组引用，见 RunOptions.onStep） */
  const land = (step: TraceStep): void => {
    trace.push(step);
    options.onStep?.(trace);
  };

  /** 步骤（含子树）标记终态但不执行：错误即停后剩余步骤标 skipped，取消标 cancelled */
  const markRemaining = (steps: RecipeStep[] | undefined, status: "skipped" | "cancelled"): void => {
    for (const s of steps ?? []) {
      land({ id: s.id, action: stepActionName(s), args: {}, status, ms: 0 });
      markRemaining(s.steps, status);
    }
  };

  /** 前序步骤重放：以上次 run 记录的 out 作初始上下文，标 replayed */
  const replaySubtree = (step: RecipeStep): void => {
    const out = options.replay!.outs[step.id];
    (stepsCtx[step.id] ??= {})[step.out ?? "out"] = out;
    land({
      id: step.id,
      action: stepActionName(step),
      args: step.args ?? {},
      status: "replayed",
      ms: 0,
      ...(out !== undefined ? { out: truncateOut(out) } : {}),
    });
    for (const child of step.steps ?? []) replaySubtree(child);
  };

  const withTimeout = <T,>(p: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      // 先 reject 再 onTimeout：错误文案归「步骤超时」，动作的 AbortError 不会抢跑
      const timer = setTimeout(() => { reject(new Error(label)); onTimeout?.(); }, ms);
      p.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });

  const execActionStep = async (
    step: RecipeStep,
    vars: Record<string, unknown>,
    iter?: number,
  ): Promise<void> => {
    const scope = mkScope(vars);
    const t0 = nowFn();
    const iterField = iter === undefined ? {} : { iter };
    let resolvedArgs: Record<string, unknown> = step.args ?? {};
    try {
      const args = resolveArgs(resolvedArgs, scope);
      resolvedArgs = args;
      const def: ActionDef | undefined = options.actions[step.action!];
      if (!def) throw new Error(`未知动作: ${step.action}`);

      if (options.dryRun && def.category === "mutating") {
        land({
          id: step.id, action: step.action!, args, status: "skipped", ms: nowFn() - t0,
          skipReason: "dry-run",
          note: `将执行 ${step.action} ${JSON.stringify(args)}`,
          ...iterField,
        });
        return;
      }

      const finalArgs = options.dryRun && def.category === "notify" ? prefixDryRun(args) : args;
      // 剩余 run 预算是硬顶：动作超时上限 = min(动作自身超时, 剩余预算)
      const remaining = deadline - nowFn();
      if (remaining <= 0) throw new Error("run 总超时（可用 limits.runTimeoutMs 覆盖）");
      const defTimeout = def.timeoutMs
        ?? (def.category === "interactive" ? limits.uiStepTimeoutMs : limits.stepTimeoutMs);
      const timeoutMs = Math.min(defTimeout, remaining);
      const label = timeoutMs < defTimeout
        ? `run 总超时（可用 limits.runTimeoutMs 覆盖）`
        : `步骤超时: ${step.action}（上限 ${timeoutMs}ms；可用 limits.${def.category === "interactive" ? "uiStepTimeoutMs" : "stepTimeoutMs"} 覆盖）`;

      // 步骤级中止：用户取消（run 级 signal）与步骤超时都会触发，动作据此
      // 清理在途资源（process.run 杀子进程、ui 表单撤销等待）。归因仍看
      // options.signal：只有 run 级取消才记 cancelled，超时算 error。
      const stepAbort = new AbortController();
      const onRunAbort = () => stepAbort.abort();
      options.signal?.addEventListener("abort", onRunAbort, { once: true });
      let out: unknown;
      try {
        out = await withTimeout(
          def.run(finalArgs, { signal: stepAbort.signal, dryRun: options.dryRun === true, scope }),
          timeoutMs,
          label,
          () => stepAbort.abort(),
        );
      } finally {
        options.signal?.removeEventListener("abort", onRunAbort);
      }
      (stepsCtx[step.id] ??= {})[step.out ?? "out"] = out;
      const ms = nowFn() - t0;
      land({
        id: step.id, action: step.action!, args, status: "ok", ms,
        out: truncateOut(out),
        ...(def.category === "interactive" ? { waitedMs: ms } : {}),
        ...iterField,
      });
    } catch (e) {
      // 动作观察 signal 后主动中断：归为取消而非错误
      if (options.signal?.aborted) {
        halted = { kind: "cancelled" };
        land({ id: step.id, action: step.action!, args: resolvedArgs, status: "cancelled", ms: nowFn() - t0, error: msg(e), ...iterField });
        return;
      }
      halted = { kind: "error", stepId: step.id, message: msg(e) };
      land({ id: step.id, action: step.action!, args: resolvedArgs, status: "error", error: msg(e), ms: nowFn() - t0, ...iterField });
    }
  };

  const execFor = async (step: RecipeStep, vars: Record<string, unknown>): Promise<void> => {
    const scope = mkScope(vars);
    const t0 = nowFn();
    const f = step.for!;
    // 容器先落迹（UI 上子步骤缩进其下），字段在结束时回填
    const container: TraceStep = { id: step.id, action: "for", args: {}, status: "ok", ms: 0 };
    land(container);
    try {
      let count: number;
      let items: unknown[] | null = null;
      if (f.in !== undefined) {
        const list = evalTemplate(f.in, scope);
        if (!Array.isArray(list)) throw new Error(`for.in 求值结果必须是数组（${step.id}），得到 ${list === null ? "null" : typeof list}`);
        items = list;
        count = list.length;
        container.args = f.each !== undefined ? { each: f.each, in: list } : { in: list };
      } else {
        const tv = typeof f.times === "number" ? f.times : evalTemplate(f.times!, scope);
        if (typeof tv !== "number" || !Number.isInteger(tv) || tv < 0) {
          throw new Error(`for.times 求值结果必须是非负整数（${step.id}），得到 ${JSON.stringify(tv)}`);
        }
        count = tv;
        container.args = { times: tv };
      }
      if (count > limits.maxIterations) {
        throw new Error(`迭代次数 ${count} 超过上限 ${limits.maxIterations}（${step.id}；可用 limits.maxIterations 覆盖）`);
      }
      for (let i = 0; i < count; i++) {
        const h = checkHalt(step.id);
        if (h) { halted = h; break; }
        const childVars = { ...vars };
        if (f.each !== undefined && items) childVars[f.each] = items[i];
        for (const child of step.steps ?? []) {
          if (halted) break;
          await execStep(child, childVars, i);
        }
        if (halted) break;
      }
    } catch (e) {
      halted = { kind: "error", stepId: step.id, message: msg(e) };
    }
    container.ms = nowFn() - t0;
    if (halted) {
      container.status = halted.kind === "cancelled" ? "cancelled" : "error";
      if (halted.kind === "error") container.error = halted.message;
    }
    // 容器字段回填后再通知一次（不重复落迹）：直播读取方拿到终态容器
    options.onStep?.(trace);
  };

  const execStep = async (step: RecipeStep, vars: Record<string, unknown>, iter?: number): Promise<void> => {
    if (step.when !== undefined) {
      let cond: unknown = false;
      let whenError: unknown;
      if (typeof step.when === "boolean") cond = step.when;
      else {
        try { cond = evalTemplate(step.when, mkScope(vars)); }
        catch (e) { whenError = e; }
      }
      if (whenError !== undefined) {
        halted = { kind: "error", stepId: step.id, message: msg(whenError) };
        land({ id: step.id, action: stepActionName(step), args: {}, status: "error", error: msg(whenError), ms: 0 });
        return;
      }
      if (!cond) {
        land({ id: step.id, action: stepActionName(step), args: {}, status: "skipped", skipReason: "when", ms: 0, ...(iter === undefined ? {} : { iter }) });
        // 容器被 when 跳过时其子树一并标记（不执行）
        markRemaining(step.steps, "skipped");
        return;
      }
    }
    if (step.for) await execFor(step, vars);
    else await execActionStep(step, vars, iter);
  };

  // ---- 顶层线性循环 ----
  for (let i = 0; i < recipe.steps.length; i++) {
    const step = recipe.steps[i];
    if (!halted) {
      if (i < replayBoundary) { replaySubtree(step); continue; }
      const h = checkHalt(step.id);
      if (h) {
        halted = h;
        land({
          id: step.id, action: stepActionName(step), args: {}, status: h.kind === "cancelled" ? "cancelled" : "error",
          ...(h.kind === "error" ? { error: h.message } : {}), ms: 0,
        });
      } else {
        await execStep(step, {});
      }
    }
    if (halted) {
      // 失败/取消步本身已落迹；其后（含子树）标 skipped / cancelled
      markRemaining(recipe.steps.slice(i + 1), halted.kind === "cancelled" ? "cancelled" : "skipped");
      break;
    }
  }

  return {
    status: halted ? halted.kind : "ok",
    steps: trace,
    ...(halted?.kind === "error" && halted ? { error: { stepId: halted.stepId, message: halted.message } } : {}),
    ms: nowFn() - startMs,
  };
}
