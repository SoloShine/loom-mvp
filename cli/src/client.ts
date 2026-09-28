import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export function repoRoot(): string {
  return process.env.MINI_ROOT ?? path.resolve(__dirname, "..", "..");
}

export function appsDir(): string {
  return process.env.MINI_APPS_DIR ?? path.join(repoRoot(), "apps");
}

export function dataDir(): string {
  return process.env.MINI_DATA_DIR ?? path.join(repoRoot(), "data");
}

export interface RuntimeInfo {
  port: number;
  token: string;
  pid: number;
}

export function runtimeInfo(): RuntimeInfo | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), "runtime.json"), "utf8"));
  } catch {
    return null;
  }
}

async function req(method: string, p: string, body?: unknown): Promise<any> {
  const info = runtimeInfo();
  if (!info) throw new Error("Host 未运行(执行 mini host 启动,或先运行任意需要 Host 的命令)");
  const res = await fetchWithTimeout(
    `http://127.0.0.1:${info.port}${p}`,
    {
      method,
      headers: {
        authorization: `Bearer ${info.token}`,
        "content-type": "application/json",
        // no keep-alive: reusing sockets + process.exit() trips a libuv
        // assertion on Windows (exit code 127 instead of 1)
        connection: "close",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    180_000, // invoke can legitimately run long
  );
  const data = await res.json().catch(() => ({}) as any);
  if (!res.ok || data.ok === false) {
    const code = typeof data.code === "string" ? data.code : `HTTP_${res.status}`;
    const message = typeof data.error === "object" ? data.error.message : data.error ?? `HTTP ${res.status}`;
    throw new Error(`${code}: ${message}`);
  }
  return data;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url: string, opts: RequestInit, timeoutMs: number): Promise<Response> {
  // AbortController + clearTimeout (NOT AbortSignal.timeout): a pending
  // abort timer at process.exit() trips a libuv assertion on Windows.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function ping(timeoutMs = 2000): Promise<boolean> {
  const info = runtimeInfo();
  if (!info) return false;
  try {
    const res = await fetchWithTimeout(
      `http://127.0.0.1:${info.port}/ping`,
      { headers: { authorization: `Bearer ${info.token}` } },
      timeoutMs,
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** Start the Electron host detached if it is not running, then wait for it. */
export async function ensureHost(timeoutMs = 45_000): Promise<void> {
  if (await ping()) return;

  // stale runtime file from a dead host
  try {
    fs.rmSync(path.join(dataDir(), "runtime.json"), { force: true });
  } catch {
    /* ignore */
  }

  const electronPath = require("electron");
  // 注意:不要加 windowsHide —— 它会通过 STARTUPINFO(SW_HIDE)把隐藏状态
  // 传给 Electron,导致宿主全部窗口 Win32 层不可见(show 事件已触发但不上屏)
  const child = spawn(electronPath as unknown as string, ["host"], {
    cwd: repoRoot(),
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(300);
    if (await ping()) return;
  }
  throw new Error("Host 启动超时(可查看 data/logs/host.log)");
}

export const api = {
  apps: () => req("GET", "/apps"),
  app: (id: string) => req("GET", `/apps/${encodeURIComponent(id)}`),
  start: (id: string) => req("POST", `/apps/${encodeURIComponent(id)}/start`),
  stop: (id: string) => req("POST", `/apps/${encodeURIComponent(id)}/stop`),
  reload: (id: string) => req("POST", `/apps/${encodeURIComponent(id)}/reload`),
  invoke: (id: string, command: string, args?: unknown) =>
    req("POST", `/apps/${encodeURIComponent(id)}/invoke`, { command, args }),
  settings: () => req("GET", "/settings"),
  patchSettings: (patch: unknown) => req("PATCH", "/settings", patch),
  enable: (id: string) => req("POST", `/apps/${encodeURIComponent(id)}/enable`),
  disable: (id: string) => req("POST", `/apps/${encodeURIComponent(id)}/disable`),
  favorite: (id: string, value: boolean) => req("POST", `/apps/${encodeURIComponent(id)}/${value ? "favorite" : "unfavorite"}`),
  history: (id?: string) => req("GET", id ? `/apps/${encodeURIComponent(id)}/history` : "/history"),
  shutdown: () => req("POST", "/host/shutdown"),
};
