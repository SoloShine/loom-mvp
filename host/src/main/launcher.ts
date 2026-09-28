import { BrowserWindow, Menu, Tray, app, ipcMain, nativeImage } from "electron";
import path from "node:path";
import { paths } from "./config";
import { logHost } from "./logging";
import * as registry from "./registry";
import * as manager from "./runtime/manager";
import * as windows from "./services/windows";
import * as hotkeys from "./services/hotkeys";
import * as state from "./state";
import { showManagement } from "./management";
import { isTrustedPage, lockControlPage } from "./controlPage";

/**
 * Launcher: tray icon + a minimal Command Palette (fuzzy search over
 * apps and their commands). Palette hotkey: Ctrl+Shift+M.
 */

async function startOrFocus(id: string): Promise<void> {
  const entry = registry.list().find((item) => item.id === id);
  if (!entry) throw new Error(`NOT_FOUND: 未知 App: ${id}`);
  if (registry.isBroken(entry)) throw new Error(`BROKEN_MANIFEST: ${entry.error}`);
  if (!entry.enabled) throw new Error(`APP_DISABLED: App ${id} 已禁用`);
  if (manager.status(id) === "running") {
    if (windows.focusApp(id)) return;
    if (entry.manifest.ui.type !== "none") {
      windows.createAppWindow(entry);
      logHost("warn", `app ${id} 运行中但窗口丢失,已按 manifest 重建`);
    }
    return;
  }
  await manager.start(id);
}

function notifyLauncherError(error: unknown): void {
  const message = String((error as Error)?.message ?? error);
  logHost("error", `launcher: ${message}`);
  if (palette && !palette.isDestroyed()) {
    showPalette();
    palette.webContents.send("mini:launcher:error", message);
  }
}

let tray: Tray | null = null;
let palette: BrowserWindow | null = null;

function makeTrayIcon(): Electron.NativeImage {
  // 16x16 BGRA bitmap, white "M" on a blue square
  const pattern = [
    "X......X",
    "XX....XX",
    "X.X..X.X",
    "X..XX..X",
    "X......X",
    "X......X",
    "X......X",
    "X......X",
  ];
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const on = pattern[Math.floor(y / 2)][Math.floor(x / 2)] === "X";
      const i = (y * size + x) * 4;
      if (on) {
        buf[i] = 0xff;
        buf[i + 1] = 0xff;
        buf[i + 2] = 0xff;
        buf[i + 3] = 0xff;
      } else {
        buf[i] = 0xff; // B
        buf[i + 1] = 0x9c; // G
        buf[i + 2] = 0x4f; // R
        buf[i + 3] = 0xff;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function showPalette(): void {
  const win = palette;
  if (!win) return;
  const { screen } = require("electron") as typeof import("electron");
  const area = screen.getPrimaryDisplay().workArea;
  win.setPosition(
    area.x + Math.floor((area.width - win.getBounds().width) / 2),
    area.y + Math.floor(area.height * 0.25),
  );
  win.show();
  win.focus();
  win.webContents.send("mini:launcher:refresh");
}

function rebuildTray(): void {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 Launcher (Ctrl+Shift+M)", click: showPalette },
    { label: "管理中心", click: showManagement },
    { type: "separator" },
    ...registry.list().map((e) => ({
      label: registry.isBroken(e) ? `${e.id} (清单损坏)` : `${e.name}${e.enabled ? "" : " (已禁用)"}`,
      submenu: registry.isBroken(e)
        ? [{ label: `(清单损坏: ${e.error})`, enabled: false }, { label: "打开管理中心", click: showManagement }]
        : e.enabled
          ? [{ label: "打开 / 唤起", click: () => { void startOrFocus(e.id).catch(notifyLauncherError); } }, { type: "separator" as const }, ...e.manifest.commands.map((c) => ({ label: c.title, click: () => { void manager.invoke(e.id, c.id).catch(notifyLauncherError); } }))]
          : [{ label: "已禁用 (在管理中心启用)", enabled: false }, { label: "打开管理中心", click: showManagement }],
    })),
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]));
}

function buildTray(): void {
  tray = new Tray(makeTrayIcon());
  tray.setToolTip("Mini App Host");
  tray.on("click", showPalette);
  rebuildTray();
}

function buildPalette(): void {
  palette = new BrowserWindow({
    width: 520,
    height: 400,
    frame: false,
    show: false,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      preload: paths.launcherPreload,
      sandbox: true,
      contextIsolation: true,
      partition: "persist:mini-control-launcher",
    },
  });
  const win = palette;
  win.setMenu(null);
  lockControlPage(win, "launcher");
  win.loadFile(path.join(paths.hostDist, "launcher", "index.html"));
  win.on("blur", () => win.hide());
}

function launcherSender(sender: Electron.WebContents): boolean {
  return isTrustedPage(sender, palette?.webContents, path.join(paths.hostDist, "launcher", "index.html"));
}

export function initLauncher(): void {
  ipcMain.handle("mini:launcher:getApps", (e) => {
    if (!launcherSender(e.sender)) throw new Error("FORBIDDEN: Launcher sender");
    // 面板只显示可启动项:禁用/损坏的 App 不出现(恢复入口在托盘与管理中心)
    return registry.list()
      .filter((entry): entry is Exclude<registry.RegistryEntry, registry.BrokenAppEntry> => !registry.isBroken(entry))
      .filter((entry) => entry.enabled)
      .map((entry) => ({ id: entry.id, name: entry.name, version: entry.version, status: manager.status(entry.id), enabled: entry.enabled, favorite: entry.favorite, lastUsedAt: entry.lastUsedAt, commands: entry.manifest.commands }));
  });
  ipcMain.handle("mini:launcher:startApp", (e, id: string) => {
    if (!launcherSender(e.sender)) throw new Error("FORBIDDEN: Launcher sender");
    if (typeof id !== "string" || !state.validId(id)) throw new Error("INVALID_ARGUMENT: App ID");
    return startOrFocus(id).then(() => true, (err) => { notifyLauncherError(err); return false; });
  });
  ipcMain.handle("mini:launcher:invoke", (e, payload: { id: string; command: string }) => {
    if (!launcherSender(e.sender)) throw new Error("FORBIDDEN: Launcher sender");
    if (!payload || typeof payload.id !== "string" || !state.validId(payload.id) || typeof payload.command !== "string" || payload.command.length > 80) throw new Error("INVALID_ARGUMENT: command");
    return manager.invoke(payload.id, payload.command).then(() => true, (err) => {
      notifyLauncherError(err);
      return false;
    });
  });
  ipcMain.on("mini:launcher:hide", (e) => { if (launcherSender(e.sender)) palette?.hide(); });
  ipcMain.on("mini:launcher:manage", (e) => { if (launcherSender(e.sender)) showManagement(); });

  buildPalette();
  buildTray();
  if (!hotkeys.registerHost(state.settings().launcherHotkey, showPalette)) logHost("warn", `Launcher 热键注册失败: ${state.settings().launcherHotkey}`);
}

export function showLauncher(): void {
  showPalette();
}

export function updateLauncherHotkey(next: string, commit: () => void): void {
  hotkeys.changeHost(state.settings().launcherHotkey, next, commit, showPalette);
}

export function notifyRegistryChanged(): void {
  rebuildTray();
  if (palette && !palette.isDestroyed()) palette.webContents.send("mini:launcher:refresh");
}

export function shutdownLauncher(): void {
  hotkeys.unregisterHost();
  tray?.destroy();
  palette?.destroy();
  tray = null;
  palette = null;
}
