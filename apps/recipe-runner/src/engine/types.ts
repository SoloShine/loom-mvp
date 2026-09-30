// recipe 引擎共享类型。engine 是纯函数核心：
// 不 import @mini/sdk / electron，动作表经 runRecipe 注入（测试用 fake actions）。

import type { EvalScope } from "./expr";

export type ParamType = "string" | "number" | "boolean" | "select";

export interface ParamDef {
  label?: string;
  type: ParamType;
  default?: unknown;
  required?: boolean;
  /** type=select 时必填；纯字符串或 {value,label} */
  options?: (string | { value: string; label?: string })[];
}

/** for 步骤声明。each+in（遍历集合）与 times（固定次数）二选一，schema 层已锁。 */
export interface ForSpec {
  each?: string;
  in?: string;
  times?: number | string;
}

export interface RecipeStep {
  id: string;
  /** 叶子步骤必有；循环容器（for+steps）不带 */
  action?: string;
  args?: Record<string, unknown>;
  /** 输出落点重命名：缺省 steps.<id>.out，声明后 steps.<id>.<out> */
  out?: string;
  /** 单一 {{ 表达式 }} 或布尔字面量；假值跳过 */
  when?: string | boolean;
  for?: ForSpec;
  steps?: RecipeStep[];
}

/** 保护参数覆盖（recipe 可选声明）；缺省值见 interp.ts 的 DEFAULT_LIMITS */
export interface Limits {
  maxIterations?: number;
  stepTimeoutMs?: number;
  uiStepTimeoutMs?: number;
  runTimeoutMs?: number;
}

export interface Recipe {
  id: string;
  name?: string;
  hotkey?: string;
  onRun?: "silent" | "ask";
  params?: Record<string, ParamDef>;
  onerror?: "notify" | "silent";
  limits?: Limits;
  steps: RecipeStep[];
}

// ---------------------------------------------------------------------------
// 动作注入表：engine 只认识这里的接口，host.* 直通 / runner util 都在
// main.ts 侧（阶段 2）组装成 ActionTable 后注入。

/** dry-run 语义分类；决定 dry-run 模式下该动作 skip / real / real+标记 */
export type ActionCategory = "mutating" | "reading" | "interactive" | "notify";

export interface ActionRunContext {
  /**
   * 步骤级中止信号：run 级取消（用户 stop）与该步超时都会触发。
   * 动作（process.run 的子进程 / ui 表单等待 / delay）据此清理在途资源；
   * 主动抛错时若 run 级已取消，engine 归为 cancelled 而非 error。
   */
  signal?: AbortSignal;
  dryRun: boolean;
  /** 当前求值上下文（params/steps/env/循环变量）：js.eval 一类需要完整上下文的动作消费 */
  scope?: EvalScope;
}

export interface ActionDef {
  category: ActionCategory;
  /** 覆盖类别缺省超时（如 delay 需要长于 30s 的步超时） */
  timeoutMs?: number;
  run(args: Record<string, unknown>, ctx: ActionRunContext): Promise<unknown>;
}

export type ActionTable = Record<string, ActionDef>;

// ---------------------------------------------------------------------------
// 轨迹

export type TraceStatus = "ok" | "skipped" | "error" | "replayed" | "cancelled";

export interface TraceStep {
  id: string;
  /** 循环容器步骤落 "for" */
  action: string;
  /** 解析后实参（replayed 步骤为声明原文——未重新求值） */
  args: Record<string, unknown>;
  status: TraceStatus;
  /** 落迹前经 truncateOut 截断；运行期上下文里保留全量 */
  out?: unknown;
  error?: string;
  ms: number;
  /** 交互步骤等待用户时长（engine 按 interactive 类别记录，数值等于该步耗时） */
  waitedMs?: number;
  /** 循环体子步骤的迭代序号（从 0 起） */
  iter?: number;
  /** 跳过原因：when 假值 / dry-run 变更类跳过 */
  skipReason?: "when" | "dry-run";
  /** dry-run 跳过时记录「将做什么」 */
  note?: string;
}

export interface RunResult {
  status: "ok" | "error" | "cancelled";
  steps: TraceStep[];
  /** status=error 时的失败定位（失败步 id + 错误消息，onerror: notify 的素材） */
  error?: { stepId: string; message: string };
  ms: number;
}

/** run 记录（写入 storage 的形状；环形保留见 trace.ts pushRun） */
export interface RunRecord extends RunResult {
  runId: string;
  recipeId: string;
  startedAt: number;
  dryRun: boolean;
}

export interface ReplayOptions {
  /** 从该顶层步骤起重跑（循环体子 id 不接受——重入循环迭代无定义） */
  fromStep: string;
  /** 上次 run 各步 out（未截断的原始值），前序步骤以此为初始上下文 */
  outs: Record<string, unknown>;
}

export interface RunOptions {
  /** 已过 resolveParams 的最终参数值 */
  params?: Record<string, unknown>;
  actions: ActionTable;
  dryRun?: boolean;
  signal?: AbortSignal;
  /** env.now 时钟注入（测试确定性）；缺省 Date.now */
  now?: () => number;
  replay?: ReplayOptions;
  /**
   * 每步落迹后回调（阶段 3 直播轨迹）：传当前 trace 数组引用——容器步骤
   * 的 ms/status 在结束时回填，读取方克隆（浅拷贝各步）时取到当刻值。
   * engine 不假设消费方；缺省不回调。
   */
  onStep?: (steps: TraceStep[]) => void;
}
