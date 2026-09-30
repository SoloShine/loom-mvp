// 轨迹结构工具：out 截断与 runs 环形保留。
//
// 轨迹最终写进 host.storage——超限内容（截图 base64 一类）不能落全量，
// 只记原始长度 + 前缀摘要；runs 环形保留最近 10 次防膨胀。

import type { RunRecord } from "./types";

/** out 落迹上限（UTF-8 字节） */
export const OUT_MAX_BYTES = 4096;
/** runs 环形保留条数 */
export const MAX_KEPT_RUNS = 10;

export interface TruncatedOut {
  __truncated: true;
  /** 原始序列化字节数 */
  byteLength: number;
  /** 序列化串前缀摘要 */
  preview: string;
}

function isTruncated(v: unknown): v is TruncatedOut {
  return typeof v === "object" && v !== null && (v as TruncatedOut).__truncated === true;
}

export function isTruncatedOut(v: unknown): v is TruncatedOut {
  return isTruncated(v);
}

/**
 * out 超限截断：序列化后 ≤ 4KB 原样保留；超限替换为
 * { __truncated, byteLength, preview }。循环引用等不可序列化的值
 * 退化为 String() 后按同一规则处理，绝不抛。
 */
export function truncateOut(value: unknown): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "null";
  } catch {
    serialized = String(value);
  }
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength <= OUT_MAX_BYTES) return value;
  return { __truncated: true, byteLength, preview: serialized.slice(0, 200) } satisfies TruncatedOut;
}

/** 环形保留：追加一条 run，保留最近 keep 次（缺省 10） */
export function pushRun(runs: RunRecord[], next: RunRecord, keep = MAX_KEPT_RUNS): RunRecord[] {
  if (keep < 1) throw new Error("keep 必须 ≥ 1");
  return [...runs, next].slice(-keep);
}
