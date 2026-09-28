import { globalShortcut } from "electron";
import { logApp, logHost } from "../logging";

/**
 * Global hotkeys. Conflict rule (per PRD): first registration wins;
 * later ones fail with an error in the app log. System-wide conflicts
 * (globalShortcut returns false) behave the same way.
 */

const owners = new Map<string, string>(); // combo → appId or host
const HOST = "@host";

export function registerHost(combo: string, cb: () => void): boolean {
  if (owners.has(combo)) return false;
  try {
    if (!globalShortcut.register(combo, cb)) return false;
    owners.set(combo, HOST);
    return true;
  } catch { return false; }
}

export function changeHost(oldCombo: string, nextCombo: string, commit: () => void, cb: () => void): void {
  if (oldCombo === nextCombo) { commit(); return; }
  if (!registerHost(nextCombo, cb)) throw new Error(`热键不可用或已被占用: ${nextCombo}`);
  try { commit(); } catch (e) { unregister(nextCombo, HOST); throw e; }
  if (owners.get(oldCombo) === HOST) {
    try { unregister(oldCombo, HOST); } catch (e) { logHost("warn", `旧 Launcher 热键释放失败: ${String(e)}`); }
  }
}

export function register(combo: string, appId: string, cb: () => void): boolean {
  if (owners.has(combo)) {
    logApp(
      appId,
      "warn",
      `热键 ${combo} 注册失败:已被 ${owners.get(combo)} 注册(先到先得)`,
    );
    return false;
  }
  let ok = false;
  try {
    ok = globalShortcut.register(combo, cb);
  } catch (e: any) {
    logApp(appId, "warn", `热键 ${combo} 注册异常: ${e?.message ?? e}`);
    return false;
  }
  if (!ok) {
    logApp(appId, "warn", `热键 ${combo} 注册失败:可能被系统或其他程序占用`);
    return false;
  }
  owners.set(combo, appId);
  return true;
}

export function unregister(combo: string, appId: string): boolean {
  if (owners.get(combo) !== appId) return false;
  globalShortcut.unregister(combo);
  owners.delete(combo);
  return true;
}

/**
 * Windows 上 globalShortcut.unregister 是异步释放的:stop→start 立即
 * 重注册会失败。带重试的注册(reload 场景),默认重试 ~1.5s。
 */
export async function registerWithRetry(
  combo: string,
  appId: string,
  cb: () => void,
  retries = 6,
  delayMs = 250,
): Promise<boolean> {
  for (let i = 0; i <= retries; i++) {
    if (owners.get(combo) === appId) return true; // already ours
    if (register(combo, appId, cb)) return true;
    if (owners.get(combo) === appId) return true; // register may have lagged through
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

export function unregisterApp(appId: string): void {
  for (const [combo, owner] of [...owners.entries()]) {
    if (owner !== appId) continue;
    try {
      globalShortcut.unregister(combo);
    } catch {
      /* ignore */
    }
    owners.delete(combo);
  }
}

export function unregisterHost(): void {
  for (const [combo, owner] of [...owners.entries()]) {
    if (owner !== HOST) continue;
    try { globalShortcut.unregister(combo); } catch { /* ignore */ }
    owners.delete(combo);
  }
}

export function unregisterAll(): void {
  try {
    globalShortcut.unregisterAll();
  } catch {
    /* ignore */
  }
  owners.clear();
}

export function reservedByHost(): string[] {
  return [...owners.entries()].filter(([, owner]) => owner === HOST).map(([combo]) => combo);
}

export function describe(): { combo: string; appId: string }[] {
  return [...owners.entries()].map(([combo, appId]) => ({ combo, appId }));
}

export function logOwnerSummary(): void {
  if (owners.size > 0) {
    logHost("info", `hotkeys: ${[...owners.keys()].join(", ")}`);
  }
}
