import path from "node:path";
import { utilityProcess, type UtilityProcess } from "electron";
import { get, getError, rescan, type AppEntry } from "../registry";
import { paths } from "../config";
import { logHost, logApp } from "../logging";
import { dispatch } from "../services/dispatcher";
import { effectiveIdleStop } from "../idleStop";
import * as state from "../state";
import * as hotkeys from "../services/hotkeys";
import * as windows from "../services/windows";
import * as processSvc from "../services/processSvc";
import { notificationApi } from "../services/core";
import * as history from "../history";
import { recordUse } from "../registry";

export type RunStatus = "stopped" | "starting" | "running" | "stopping" | "crashed";

interface Waiter {
  resolve: (v?: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface RunState {
  status: RunStatus;
  proc: UtilityProcess | null;
  runId?: string;
  stopPromise?: Promise<void>;
  exitWaiter?: () => void;
  startedAt?: number;
  stopRequested: boolean;
  forcedStop?: boolean;
  hotkeyFailures: string[];
  invokeWaiters: Map<number, Waiter>;
  readyWaiter?: Waiter;
  startedWaiter?: Waiter;
  /** 闲置回收触发的停止;写 stop 事件时用于标记 idle-timeout,下次 start 重置。 */
  stopReason?: "idle";
}

const runs = new Map<string, RunState>();
let invokeSeq = 0;
let draining = false;
export function beginDraining(): void { draining = true; }
export function isDraining(): boolean { return draining; }
export function activeIds(): string[] { return [...runs].filter(([, st]) => st.proc !== null).map(([id]) => id); }
export function forceStop(id: string): void {
  const st = stateOf(id);
  st.stopRequested = true;
  st.forcedStop = true;
  if (st.proc) st.proc.kill();
}
export function waitForExit(id: string): Promise<void> {
  const st = stateOf(id);
  if (!st.proc) return Promise.resolve();
  return new Promise((resolve) => { st.exitWaiter = resolve; });
}



function stateOf(id: string): RunState {
  let st = runs.get(id);
  if (!st) {
    st = {
      status: "stopped",
      proc: null,
      stopRequested: false,
      hotkeyFailures: [],
      invokeWaiters: new Map(),
    };
    runs.set(id, st);
  }
  return st;
}

function waiter(st: RunState, slot: "readyWaiter" | "startedWaiter", timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const w: Waiter = {
      resolve: () => {
        clearTimeout(w.timer);
        resolve();
      },
      reject: (e) => {
        clearTimeout(w.timer);
        reject(e);
      },
      timer: setTimeout(() => {
        if (st[slot] === w) st[slot] = undefined;
        reject(new Error(`等待 App 响应超时(${timeoutMs}ms)`));
      }, timeoutMs),
    };
    st[slot] = w;
  });
}

function safeClone(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v ?? null));
}

/** stop 事件的原因标记:超时强停 / 闲置回收 / 普通停止(无标记)。 */
function stopEventMessage(st: RunState): string | undefined {
  if (st.forcedStop) return "timeout";
  if (st.stopReason === "idle") return "idle-timeout";
  return undefined;
}

// ---------------------------------------------------------------------------

export function status(id: string): RunStatus {
  return stateOf(id).status;
}

export function listStatuses(): Record<string, { status: RunStatus; startedAt?: number; pid?: number }> {
  const out: Record<string, { status: RunStatus; startedAt?: number; pid?: number }> = {};
  for (const [id, st] of runs) {
    out[id] = { status: st.status, startedAt: st.startedAt, pid: st.proc?.pid };
  }
  return out;
}

export async function start(id: string): Promise<void> {
  if (draining) throw new Error("APP_BUSY: Host 正在退出");
  const app = requireApp(id);
  const st = stateOf(id);
  if (st.status === "running" || st.status === "starting") return;
  if (st.status === "stopping") throw new Error(`App ${id} 正在停止`);
  if (app.manifestIssues.length) throw new Error(`App ${id} 缺少产物: ${app.manifestIssues.join("; ")}`);

  st.status = "starting";
  st.stopRequested = false;
  st.forcedStop = false;
  st.stopReason = undefined;
  st.hotkeyFailures = [];

  try {
    // manifest hotkeys (conflict = first registration wins, failures logged)
    for (const hk of app.hotkeys) {
      const ok = await hotkeys.registerWithRetry(hk.combo, id, () => {
        invoke(id, hk.command).catch((e) =>
          logApp(id, "error", `热键命令 ${hk.command} 执行失败: ${e.message}`),
        );
      });
      if (!ok) st.hotkeyFailures.push(hk.combo);
    }

    // runtime process first: the window only appears once the app is alive
    const proc = utilityProcess.fork(paths.bootstrapPath, [], {
      serviceName: `mini:${id}`,
      env: {
        ...process.env,
        MINI_APP_ID: id,
        MINI_APP_DIR: app.path,
        MINI_APP_ENTRY: path.join(app.path, "dist", "main.js"),
      } as Record<string, string>,
    });
    st.proc = proc;
    proc.on("message", (m: any) => onProcMessage(id, m, proc));
    proc.on("exit", (code: number) => onProcExit(id, code, proc));
    proc.on("spawn", () => {
      if (st.runId && proc.pid) history.updateRunPid(st.runId, proc.pid);
    });
    st.runId = history.begin(id, proc.pid ?? 0);

    await waiter(st, "readyWaiter", 10_000);
    proc.postMessage({ type: "mini-start" });
    await waiter(st, "startedWaiter", 15_000);

    // manifest window
    if (app.manifest.ui.type !== "none") {
      windows.createAppWindow(app);
    }

    st.status = "running";
    st.startedAt = Date.now();
    recordUse(id);
    history.event({ appId: id, runId: st.runId, kind: "start", outcome: "success" });
    logHost("info", `app ${id} started (pid ${proc.pid})`);
    if (st.hotkeyFailures.length > 0) {
      logApp(id, "warn", `部分热键注册失败: ${st.hotkeyFailures.join(", ")}`);
    }
  } catch (e: any) {
    cleanup(id, st);
    if (st.proc) { try { st.proc.kill(); } catch { /* gone */ } st.proc = null; }
    if (st.runId) {
      const runId = st.runId;
      if (history.event({ appId: id, runId, kind: "crash", outcome: "failure", message: "start-failure" })) {
        try { history.finish(runId); st.runId = undefined; } catch (err) { logHost("error", `active-runs 清理失败: ${String(err)}`); }
      }
    }
    history.event({ appId: id, kind: "start", outcome: "failure", message: String(e?.message ?? e) });
    st.status = "stopped";
    throw new Error(`App ${id} 启动失败: ${e?.message ?? e}`);
  }
}

export async function stop(id: string): Promise<void> {
  const st = stateOf(id);
  if (st.stopPromise) return st.stopPromise;
  if (!st.proc) {
    st.status = "stopped";
    cleanup(id, st);
    return;
  }
  const proc = st.proc;
  st.stopRequested = true;
  st.status = "stopping";
  st.stopPromise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      st.forcedStop = true;
      try { proc.kill(); } catch { /* already gone */ }
      reject(new Error(`App ${id} 停止超时，仍保持启用，可重试`));
    }, 6000);
    proc.once("exit", () => { clearTimeout(timer); resolve(); });
    try { proc.postMessage({ type: "mini-stop" }); } catch { try { proc.kill(); } catch { /* already gone */ } }
  }).then(() => {
    if (st.stopRequested) {
      cleanup(id, st);
      st.status = "stopped";
      st.startedAt = undefined;
      if (st.runId) {
        const runId = st.runId;
        if (!history.event({ appId: id, runId, kind: "stop", outcome: st.forcedStop ? "failure" : "success", message: stopEventMessage(st) })) throw new Error("PERSISTENCE_FAILED: history stop");
        history.finish(runId);
        st.runId = undefined;
      }
    }
    logHost("info", `app ${id} stopped`);
  }).catch((err) => {
    st.stopRequested = !!st.forcedStop;
    st.status = st.proc ? "stopping" : "stopped";
    throw err;
  }).finally(() => { st.stopPromise = undefined; });
  return st.stopPromise;
}

export async function reload(id: string): Promise<void> {
  if (draining) throw new Error("APP_BUSY: Host 正在退出");
  await stop(id);
  await start(id);
}

export async function invoke(id: string, command: string, args?: unknown): Promise<unknown> {
  if (draining) throw new Error("APP_BUSY: Host 正在退出");
  requireApp(id);
  const st = stateOf(id);
  if (st.status === "stopped" || st.status === "crashed") {
    await start(id);
  }
  if (!st.proc) throw new Error(`App ${id} 运行时不可用`);

  const reqId = ++invokeSeq;
  const p = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      st.invokeWaiters.delete(reqId);
      reject(new Error(`invoke 超时(120s): ${command}`));
    }, 120_000);
    st.invokeWaiters.set(reqId, {
      resolve,
      reject,
      timer,
    });
  });
  st.proc.postMessage({ type: "mini-invoke", reqId, command, args: args ?? {} });
  const started = Date.now();
  try {
    const result = await p;
    recordUse(id);
    touchActivity(id);
    history.event({ appId: id, runId: st.runId, kind: "invoke", command, outcome: "success", durationMs: Date.now() - started });
    return result;
  } catch (e) {
    history.event({ appId: id, runId: st.runId, kind: "invoke", command, outcome: "failure", durationMs: Date.now() - started, message: String(e) });
    throw e;
  }
}

/** window → app runtime message relay */
export function uiMessageFromWindow(id: string, msg: unknown): void {
  const st = stateOf(id);
  st.proc?.postMessage({ type: "mini-svc-event", key: "ui:message", event: "message", data: msg });
}

export async function stopAll(): Promise<void> {
  for (const [id, st] of runs) {
    if (st.status !== "stopped") await stop(id);
  }
}

// —— 闲置自动回收(设置页「闲置回收」+ 清单 lifecycle.idleStopMinutes)——————
// 生效规则见 idleStop.ts:总开关、例外名单、清单声明优先/全局默认兜底。
// 活跃 = invoke、启动成功、窗口 show/focus;超时走正常 stop(可被重新启动)。
const lastActivity = new Map<string, number>();

export function touchActivity(id: string): void {
  if (runs.has(id)) lastActivity.set(id, Date.now());
}
windows.setWindowActivityHook(touchActivity);

const IDLE_CHECK_INTERVAL_MS = 30_000;
setInterval(() => {
  for (const [id, st] of runs) {
    if (st.status !== "running") continue;
    const app = get(id);
    if (!app || !app.enabled) continue;
    const policy = effectiveIdleStop(id, app.manifest.lifecycle?.idleStopMinutes, state.settings());
    if (!policy) continue;
    const last = lastActivity.get(id) ?? st.startedAt;
    if (last && Date.now() - last >= policy.minutes * 60_000) {
      const where = policy.source === "manifest" ? "清单声明" : "全局默认";
      logApp(id, "info", `闲置超过 ${policy.minutes} 分钟,自动回收(${where};可在 设置→闲置回收 调整)`);
      lastActivity.set(id, Date.now()); // 防止 stop 慢时下一轮重复触发
      st.stopReason = "idle";
      const name = app.name;
      const minutes = policy.minutes;
      void stop(id)
        .then(() => {
          // 通知默认关(recycle.notify),避免频繁弹窗打扰;历史与日志始终可查
          if (!state.settings().recycle.notify) return;
          notificationApi.show({
            title: `${name} 已闲置自动停止`,
            body: `闲置超过 ${minutes} 分钟(${where});可在 设置 → 闲置回收 调整。`,
          });
        })
        .catch(() => { st.stopReason = undefined; /* stop 失败已记日志 */ });
    }
  }
}, IDLE_CHECK_INTERVAL_MS);

// ---------------------------------------------------------------------------

function requireApp(id: string): AppEntry {
  let app = get(id);
  if (!app) {
    // freshly created app: the fs watcher may not have fired yet
    rescan();
    app = get(id);
  }
  if (!app) {
    const err = getError(id);
    throw new Error(err ? `BROKEN_MANIFEST: App ${id} 清单损坏: ${err}` : `NOT_FOUND: 未知 App: ${id}`);
  }
  if (!app.enabled) throw new Error(`APP_DISABLED: App ${id} 已禁用`);
  return app;
}

function onProcMessage(id: string, m: any, proc: UtilityProcess): void {
  if (!m || typeof m !== "object") return;
  const st = stateOf(id);
  if (st.proc !== proc) return; // stale message from a replaced process

  if (m.type === "mini-svc") {
    if (draining || !get(id)?.enabled || st.status === "stopping") {
      proc.postMessage({ type: "mini-svc-res", id: m.id, ok: false, error: "APP_BUSY: App unavailable" });
      return;
    }
    const ctx = {
      appId: id,
      appPath: get(id)?.path ?? "",
      pushEvent: (key: string, event: string, data: unknown) => {
        try {
          st.proc?.postMessage({ type: "mini-svc-event", key, event, data });
        } catch {
          /* app gone */
        }
      },
    };
    dispatch(ctx, String(m.service), String(m.method), m.args)
      .then((result) => {
        st.proc?.postMessage({ type: "mini-svc-res", id: m.id, ok: true, result: safeClone(result) });
      })
      .catch((e: any) => {
        st.proc?.postMessage({
          type: "mini-svc-res",
          id: m.id,
          ok: false,
          error: String(e?.message ?? e),
        });
      });
    return;
  }

  if (m.type === "mini-ready") {
    st.readyWaiter?.resolve();
    st.readyWaiter = undefined;
    return;
  }
  if (m.type === "mini-started") {
    st.startedWaiter?.resolve();
    st.startedWaiter = undefined;
    return;
  }
  if (m.type === "mini-start-failed") {
    st.startedWaiter?.reject(new Error(String(m.error ?? "start failed")));
    st.startedWaiter = undefined;
    return;
  }
  if (m.type === "mini-invoke-res") {
    const w = st.invokeWaiters.get(m.reqId);
    if (!w) return;
    st.invokeWaiters.delete(m.reqId);
    if (m.ok) w.resolve(safeClone(m.result));
    else w.reject(new Error(String(m.error ?? "invoke failed")));
    return;
  }
}

function onProcExit(id: string, code: number, proc: UtilityProcess): void {
  const st = stateOf(id);
  if (st.proc !== proc) {
    // exit of a process that was already replaced (reload/stop) — ignore
    logHost("info", `app ${id}: 旧运行时进程退出 (code ${code}),忽略`);
    return;
  }
  st.proc = null;
  st.exitWaiter?.();
  st.exitWaiter = undefined;

  // reject pending waiters
  for (const w of st.invokeWaiters.values()) w.reject(new Error("App 进程已退出"));
  st.invokeWaiters.clear();
  st.readyWaiter?.reject(new Error("App 进程在启动阶段退出"));
  st.startedWaiter?.reject(new Error("App 进程在启动阶段退出"));

  if (st.stopRequested || st.status === "stopped" || st.status === "stopping") {
    if (!st.stopPromise) {
      cleanup(id, st);
      st.status = "stopped";
      if (st.runId) {
        const runId = st.runId;
        if (history.hasTerminal(runId)) { try { history.finish(runId); st.runId = undefined; } catch (e) { logHost("error", `active-runs 清理失败: ${String(e)}`); } }
        else if (history.event({ appId: id, runId, kind: "stop", outcome: st.forcedStop ? "failure" : "success", message: stopEventMessage(st) })) {
          try { history.finish(runId); st.runId = undefined; } catch (e) { logHost("error", `active-runs 清理失败: ${String(e)}`); }
        }
      }
    }
    return;
  }

  if (st.runId) {
    const runId = st.runId;
    if (history.event({ appId: id, runId, kind: "crash", outcome: "failure", exitCode: code })) {
      try { history.finish(runId); st.runId = undefined; } catch (e) { logHost("error", `active-runs 清理失败: ${String(e)}`); }
    }
  }
  // unexpected exit → crashed; host must survive
  st.status = "crashed";
  cleanup(id, st);
  logHost("error", `app ${id} CRASHED (exit code ${code})`);
  logApp(id, "error", `App 进程崩溃 (exit code ${code}),Host 存活。可用 mini logs ${id} 查看。`);
  const name = get(id)?.name ?? id;
  notificationApi.show({ title: `${name} 已崩溃`, body: `查看详情: mini logs ${id}` });
}

function cleanup(id: string, st: RunState): void {
  hotkeys.unregisterApp(id);
  processSvc.killAppHelpers(id);
  windows.closeAppWindows(id);
  // 清掉上一轮运行的活跃时间戳,否则重启后新进程直接带着旧时间被判定闲置
  lastActivity.delete(id);
}
