import { BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import fs from "node:fs";
import { paths } from "./config";
import * as registry from "./registry";
import * as manager from "./runtime/manager";
import * as state from "./state";
import * as history from "./history";
import { appLogPath } from "./logging";
import { setEnabledAndReconcile } from "./appManagement";
import { isTrustedPage, lockControlPage } from "./controlPage";
import { patchHostSettings } from "./settingsCommit";

let window: BrowserWindow | null = null;
let updateHotkey: ((next: string, commit: () => void) => void) | null = null;

function allowed(sender: Electron.WebContents): boolean { return isTrustedPage(sender, window?.webContents, pageFile()); }
function pageFile(): string { return path.join(paths.hostDist, "management", "index.html"); }
function idOf(value: unknown): string {
  if (typeof value !== "string" || !state.validId(value)) throw new Error("INVALID_ARGUMENT: 无效 App ID");
  return value;
}
function entry(id: string): registry.RegistryEntry {
  const found = registry.list().find((item) => item.id === id);
  if (!found) throw new Error(`NOT_FOUND: 未知 App: ${id}`);
  return found;
}
function api(e: registry.RegistryEntry) {
  if (registry.isBroken(e)) return { id: e.id, name: e.id, path: e.dir, status: "broken", enabled: false, favorite: false, error: e.error, permissions: [] as string[], commands: [], hotkeys: [], manifestIssues: [] };
  return {
    id: e.id, name: e.name, version: e.version, path: e.path, uiType: e.manifest.ui.type,
    status: manager.status(e.id), enabled: e.enabled, favorite: e.favorite, lastUsedAt: e.lastUsedAt,
    useCount: e.useCount, manifestIssues: e.manifestIssues, commands: e.manifest.commands,
    hotkeys: e.hotkeys, permissions: e.manifest.permissions,
  };
}
function guard(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => { if (!allowed(event.sender)) throw new Error("FORBIDDEN: 管理窗口归属校验失败"); return fn(...args); });
}
function page(cursor: unknown, limit: unknown): { cursor: number; limit: number } {
  const c = cursor === undefined ? 0 : Number(cursor); const l = limit === undefined ? 50 : Number(limit);
  if (!Number.isSafeInteger(c) || c < 0 || !Number.isSafeInteger(l) || l < 1 || l > 100) throw new Error("分页参数无效");
  return { cursor: c, limit: l };
}

export function initManagement(onHotkey: (next: string, commit: () => void) => void): void {
  updateHotkey = onHotkey;
  guard("mini:management:getApps", () => registry.list().map(api));
  guard("mini:management:getApp", (raw: unknown) => api(entry(idOf(raw))));
  guard("mini:management:action", async (raw: unknown, action: unknown) => {
    const id = idOf(raw); const name = String(action); const current = entry(id);
    if (registry.isBroken(current)) throw new Error(`BROKEN_MANIFEST: ${current.error}`);
    if (name === "start") await manager.start(id);
    else if (name === "stop") await manager.stop(id);
    else if (name === "reload") await manager.reload(id);
    else if (name === "enable") await setEnabledAndReconcile(id, true);
    else if (name === "disable") await setEnabledAndReconcile(id, false);
    else if (name === "favorite" || name === "unfavorite") { if (!registry.setFavorite(id, name === "favorite")) throw new Error("PERSISTENCE_FAILED: 收藏未保存"); }
    else throw new Error("INVALID_ARGUMENT: 未知管理动作");
    return api(entry(id));
  });
  guard("mini:management:getHistory", (raw: unknown, cursor: unknown, limit: unknown) => history.query(idOf(raw), page(cursor, limit).cursor, page(cursor, limit).limit));
  guard("mini:management:getLogs", (raw: unknown, cursor: unknown, limit: unknown) => {
    const id = idOf(raw); entry(id); const p = page(cursor, Math.min(Number(limit ?? 50), 100));
    const file = appLogPath(id); if (!fs.existsSync(file)) return { lines: [], nextCursor: null, truncated: false };
    const size = fs.statSync(file).size; const start = Math.max(0, size - 256 * 1024); const fd = fs.openSync(file, "r");
    let text = ""; try { const buf = Buffer.alloc(size - start); if (buf.length) fs.readSync(fd, buf, 0, buf.length, start); text = buf.toString("utf8"); } finally { fs.closeSync(fd); }
    const lines = text.split(/\r?\n/).filter(Boolean).slice(start ? 1 : 0).reverse().map((line) => line.slice(0, 2048));
    return { lines: lines.slice(p.cursor, p.cursor + p.limit), nextCursor: p.cursor + p.limit < lines.length ? p.cursor + p.limit : null, truncated: start > 0 };
  });
  guard("mini:management:getSettings", () => state.settings());
  guard("mini:management:patchSettings", (patch: unknown) => patchHostSettings(patch));
}

export function showManagement(): void {
  if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
  window = new BrowserWindow({ width: 1080, height: 720, minWidth: 860, minHeight: 560, show: false,
    title: "Mini App 管理中心", webPreferences: { preload: paths.managementPreload, sandbox: true, contextIsolation: true, partition: "persist:mini-control-management" } });
  window.setMenu(null); lockControlPage(window, "management"); window.loadFile(pageFile());
  window.once("ready-to-show", () => window?.show()); window.on("closed", () => { window = null; });
}
export function shutdownManagement(): void { if (window && !window.isDestroyed()) window.destroy(); window = null; }
