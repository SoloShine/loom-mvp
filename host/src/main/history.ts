import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { paths } from "./config";
import { atomicWrite, validId } from "./state";
import { logHost } from "./logging";

export interface HistoryEvent {
  eventId: string;
  appId: string;
  runId?: string;
  kind: "start" | "stop" | "crash" | "interrupted" | "invoke" | "restored";
  at: string;
  outcome: "success" | "failure";
  command?: string;
  durationMs?: number;
  exitCode?: number;
  message?: string;
}
interface ActiveRun { runId: string; appId: string; startedAt: string; pid: number; }
interface ActiveFile { schemaVersion: 1; epoch: string; runs: ActiveRun[]; }
const activePath = () => path.join(paths.data, "active-runs.json");
const historyPath = () => path.join(paths.data, "history.jsonl");
let active: ActiveFile | undefined;

export function event(event: Omit<HistoryEvent, "eventId" | "at">): boolean {
  try {
    const terminal = event.runId && ["stop", "crash", "interrupted"].includes(event.kind);
    const eventId = terminal ? `${event.runId}:terminal` : crypto.randomUUID();
    const existing = terminal ? hasTerminal(event.runId!) : false;
    if (!existing) {
      const fd = fs.openSync(historyPath(), "a", 0o600);
      try { fs.writeSync(fd, JSON.stringify({ ...event, eventId, at: new Date().toISOString() }) + "\n"); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    }
    return true;
  } catch (e) { logHost("warn", `history 写入失败: ${String(e)}`); return false; }
}
/** 启动恢复:把上次活跃且无终态的 run 逐个补 `interrupted` 终态事件并清空 active-runs。
 *  返回本次实际补了 interrupted 的 appId(保序去重,近似崩溃前启动顺序),供 boot 交给
 *  manager.restoreInterrupted 做会话恢复;无待恢复项或二次调用返回 []。
 *  惰性调用点(begin/finish/commit)忽略返回值,行为不变。 */
export function initRuns(): string[] {
  if (active) return [];
  let previous: ActiveFile | undefined;
  if (fs.existsSync(activePath())) {
    const raw: unknown = JSON.parse(fs.readFileSync(activePath(), "utf8"));
    if (!raw || typeof raw !== "object" || (raw as ActiveFile).schemaVersion !== 1 || !Array.isArray((raw as ActiveFile).runs) ||
      (raw as ActiveFile).runs.some((r) => !r || !validId(r.appId) || typeof r.runId !== "string" || typeof r.startedAt !== "string" || typeof r.pid !== "number")) {
      throw new Error("active-runs schema 无效，需人工恢复以避免遗漏 interrupted");
    }
    previous = raw as ActiveFile;
  }
  const next: ActiveFile = previous ?? { schemaVersion: 1, epoch: crypto.randomUUID(), runs: [] };
  active = next;
  if (!previous) atomicWrite(activePath(), JSON.stringify(next));
  const terminal = new Set<string>();
  const need = new Set(next.runs.map((r) => r.runId));
  if (need.size) {
    // 只找 active runId 的终态,反向扫描找到全部即止
    scanHistoryBackward((item) => {
      if (item?.runId && need.has(item.runId) && (TERMINAL_KINDS as readonly string[]).includes(item.kind)) {
        terminal.add(item.runId);
        need.delete(item.runId);
      }
      return need.size === 0;
    });
  }
  const interruptedApps: string[] = [];
  const seenApps = new Set<string>();
  for (const r of [...next.runs]) {
    const markedNow = !terminal.has(r.runId) &&
      event({ appId: r.appId, runId: r.runId, kind: "interrupted", outcome: "failure", message: "host-exit" });
    // 已有终态(只清 active)或补 interrupted 失败(留给下次启动重试)都不进恢复名单
    if (!markedNow) { if (terminal.has(r.runId)) finish(r.runId); continue; }
    finish(r.runId);
    if (!seenApps.has(r.appId)) { seenApps.add(r.appId); interruptedApps.push(r.appId); }
  }
  return interruptedApps;
}
function commit(runs: ActiveRun[]): void {
  if (!active) initRuns();
  const next: ActiveFile = { ...active!, runs };
  atomicWrite(activePath(), JSON.stringify(next));
  active = next;
}
export function begin(appId: string, pid: number): string {
  if (!active) initRuns();
  const runId = crypto.randomUUID();
  commit([...active!.runs, { appId, pid, runId, startedAt: new Date().toISOString() }]);
  return runId;
}
export function finish(runId: string): void {
  if (!active) initRuns();
  commit(active!.runs.filter((r) => r.runId !== runId));
}
/** utilityProcess.pid is not assigned yet at fork time (begin records 0);
 *  fill it in once the OS has spawned the child. */
export function updateRunPid(runId: string, pid: number): void {
  if (!active || !pid) return;
  const run = active.runs.find((r) => r.runId === runId);
  if (run && run.pid !== pid) {
    run.pid = pid;
    commit(active.runs);
  }
}
const TERMINAL_KINDS = ["stop", "crash", "interrupted"] as const;
const SCAN_CHUNK = 1024 * 1024;

/** history.jsonl 的反向逐行扫描,内存 O(chunk):按 1 MiB 块回读,字节级按 LF
 *  切行(多字节 UTF-8 不含 0x0A,跨块行先拼接再解码),不完整的首行并入下一块;
 *  visit() 返回 true 提前终止。替代旧的全文件 readFileSync(大文件下启动与
 *  终态去重都是 O(文件大小) 内存)。 */
function scanHistoryBackward(visit: (item: HistoryEvent | null) => void | boolean): boolean {
  let fd: number;
  try { fd = fs.openSync(historyPath(), "r"); } catch { return false; }
  try {
    let end = fs.fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    while (end > 0) {
      const len = Math.min(SCAN_CHUNK, end);
      const start = end - len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      const text = Buffer.concat([buf, carry]);
      const lines: Buffer[] = [];
      let pos = 0;
      while (pos < text.length) {
        const nl = text.indexOf(10, pos);
        if (nl < 0) break;
        lines.push(text.subarray(pos, nl));
        pos = nl + 1;
      }
      carry = text.subarray(pos);
      for (let i = lines.length - 1; i >= 0; i--) {
        const raw = lines[i].toString("utf8").trim();
        if (!raw) continue;
        let item: HistoryEvent | null = null;
        try { item = JSON.parse(raw) as HistoryEvent; } catch { item = null; }
        if (visit(item) === true) return true;
      }
      end = start;
    }
    const tail = carry.toString("utf8").trim();
    if (tail) {
      let item: HistoryEvent | null = null;
      try { item = JSON.parse(tail) as HistoryEvent; } catch { item = null; }
      if (visit(item) === true) return true;
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

export function hasTerminal(runId: string): boolean {
  return scanHistoryBackward((item) =>
    !!item && item.runId === runId && (TERMINAL_KINDS as readonly string[]).includes(item.kind));
}

export function query(appId: string | undefined, cursor: number, limit: number): { events: HistoryEvent[]; nextCursor: number | null } {
  const file = historyPath();
  const events: HistoryEvent[] = [];
  if (fs.existsSync(file)) {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - 1024 * 1024);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - start);
      if (buf.length) fs.readSync(fd, buf, 0, buf.length, start);
      for (const line of buf.toString("utf8").split("\n").slice(start ? 1 : 0)) {
        if (!line) continue;
        try {
          const item = JSON.parse(line) as HistoryEvent;
          if (item && validId(item.appId) && (!appId || item.appId === appId)) events.push(item);
        } catch { logHost("warn", "history 存在不完整或损坏的行，已跳过"); }
      }
    } finally { fs.closeSync(fd); }
  }
  events.reverse();
  return { events: events.slice(cursor, cursor + limit), nextCursor: cursor + limit < events.length ? cursor + limit : null };
}
