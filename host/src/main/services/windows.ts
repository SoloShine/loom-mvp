import { BrowserWindow, screen } from "electron";
import fs from "node:fs";
import path from "node:path";
import { paths } from "../config";
import { logHost } from "../logging";
import * as registry from "../registry";
import * as state from "../state";
import type { AppEntry } from "../registry";
import { resolveDevTarget } from "./devTarget";
import { sanitizeRestoredBounds } from "./winBounds";

/**
 * Mini App windows. One primary window per manifest ui declaration
 * (created automatically on app start), plus extra windows on demand
 * via host.window.create. All load the same shell: dist/index.html +
 * the app's built dist/ui.js, bridged by the host preload.
 */

const windowsByApp = new Map<string, Map<string, BrowserWindow>>();
const appByWebContents = new Map<number, string>();
// 窗口几何防抖保存的挂起 timer,按 windowId 存,窗口 closed 时清理。
const saveTimers = new Map<string, NodeJS.Timeout>();
let seq = 0;

function windowOptions(type: string, width: number, height: number): Electron.BrowserWindowConstructorOptions {
  const common: Electron.BrowserWindowConstructorOptions = {
    width,
    height,
    show: false,
    title: "Mini App",
    webPreferences: {
      preload: paths.appWindowPreload,
      // sandbox 关闭:本机 sandboxed preload 的 contextBridge 注入不稳定
      // (launcher 同款代码正常,App 窗口 __miniHost 不出现);仍保留 contextIsolation
      sandbox: false,
      contextIsolation: true,
    },
  };
  switch (type) {
    case "floating":
      return { ...common, alwaysOnTop: true, frame: false, skipTaskbar: true, resizable: false };
    case "overlay":
      return {
        ...common,
        alwaysOnTop: true,
        frame: false,
        transparent: true,
        hasShadow: false,
        skipTaskbar: true,
        resizable: false,
        backgroundColor: "#00000000",
      };
    default:
      return common;
  }
}

function ensureShellHtml(app: AppEntry): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden}
  </style></head><body><div id="root"></div><script src="./ui.js"></script></body></html>`;
  const file = path.join(app.distDir, "index.html");
  fs.mkdirSync(app.distDir, { recursive: true });
  fs.writeFileSync(file, html);
  return file;
}

// 闲置自动停止的活跃度钩子:窗口 show/focus 时回调(manager 启动时注册),
// windows.ts 不反向 import manager,避免循环依赖。
let activityHook: (appId: string) => void = () => {};
export function setWindowActivityHook(fn: (appId: string) => void): void {
  activityHook = fn;
}

function trackWindow(appId: string, windowId: string, win: BrowserWindow): void {
  let m = windowsByApp.get(appId);
  if (!m) {
    m = new Map();
    windowsByApp.set(appId, m);
  }
  m.set(windowId, win);
  const webContentsId = win.webContents.id;
  appByWebContents.set(webContentsId, appId);
  win.on("closed", () => {
    // 注意:closed 触发时窗口已销毁,不能再访问 win.webContents
    const pending = saveTimers.get(windowId);
    if (pending) clearTimeout(pending);
    saveTimers.delete(windowId);
    m!.delete(windowId);
    appByWebContents.delete(webContentsId);
    logHost("info", `window closed (app=${appId}, id=${windowId})`);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    logHost("error", `app window renderer gone (app=${appId}, id=${windowId}): ${details.reason}`);
  });
  // 页面侧错误/日志进 host 日志(Electron 44 新签名:单个 details 对象)
  win.webContents.on("console-message" as any, (...args: any[]) => {
    const d = args[0];
    const details = d && typeof d === "object" && "message" in d ? d : { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] };
    logHost(
      Number(details.level) >= 3 ? "error" : "info",
      `app-window console (app=${appId}): ${details.message} (${details.sourceId}:${details.lineNumber})`,
    );
  });
  win.on("show", () => {
    logHost("info", `window shown (app=${appId}, id=${windowId})`);
    activityHook(appId);
  });
  win.on("focus", () => activityHook(appId));
}

export function createAppWindow(app: AppEntry): string {
  const ui = app.manifest.ui;
  const width = ui.width ?? 360;
  const height = ui.height ?? 240;
  return createWindow(app.id, ui.type === "none" ? "window" : ui.type, width, height, app.name, true);
}

export function createWindow(
  appId: string,
  type: "window" | "floating" | "overlay",
  width: number,
  height: number,
  title?: string,
  // 仅 manifest 窗口持久化几何;SDK 动态窗口(默认 false)生命周期由 App 自管,行为不变。
  persist = false,
): string {
  const win = new BrowserWindow({
    ...windowOptions(type, width, height),
    title: title ?? "Mini App",
  });
  win.setMenu(null);
  const windowId = `win-${++seq}`;
  const app = { distDir: path.join(paths.apps, appId, "dist") } as AppEntry;
  const shell = ensureShellHtml(app);
  const devUrl = registry.get(appId)?.manifest.ui.devUrl;
  if (persist) {
    // 恢复:上次的几何过可见性校验后应用(全程 DIP,不换算);过期/不可见回退默认。
    const saved = state.meta(appId)?.winBounds;
    const displays = screen.getAllDisplays().map((d) => ({ workArea: d.workArea }));
    const fixed = saved ? sanitizeRestoredBounds(saved, displays) : null;
    if (fixed) {
      // Electron 跨不同 scale 显示器的一次性 setBounds 会把宽高按
      // targetScale/oldScale 缩放(实测 1.5→1.0 宽高缩成 2/3,x/y 不受影响):
      // 先移动、窗口落到目标屏后再定尺寸,绕开一次性跨屏换算
      win.setBounds({ x: fixed.x, y: fixed.y });
      win.setSize(fixed.width, fixed.height);
    }
    if (saved && !fixed) logHost("info", `winBounds 不可见,回退默认位置 (app=${appId})`);
    // 保存:用户移动/缩放结束后 500ms 防抖全量重写。win.destroy() 不发 close,
    // 不能靠关闭钩子存盘;最大化/最小化期间 getBounds 是铺满/怪值,直接丢弃。
    const scheduleSave = (): void => {
      const prev = saveTimers.get(windowId);
      if (prev) clearTimeout(prev);
      saveTimers.set(windowId, setTimeout(() => {
        saveTimers.delete(windowId);
        try {
          if (!win.isDestroyed() && !win.isMaximized() && !win.isMinimized()) state.setWinBounds(appId, win.getBounds());
        } catch (e) {
          logHost("warn", `窗口几何保存失败 (app=${appId}): ${String(e)}`);
        }
      }, 500));
    };
    win.on("moved", scheduleSave);
    win.on("resized", scheduleSave);
  }
  // 加载决策放后台:窗口 show:false,ready-to-show 才上屏,探测不影响可见性;
  // 未声明 devUrl 的 App 不探测,仍走产物 loadFile,行为同前。
  void (async () => {
    const target = await resolveDevTarget(devUrl);
    if (win.isDestroyed()) return;
    if (target === "dev" && devUrl) {
      try {
        const u = new URL(devUrl);
        u.searchParams.set("__miniWindowId", windowId);
        await win.loadURL(u.toString());
        return;
      } catch (e: any) {
        if (win.isDestroyed()) return;
        logHost("warn", `devUrl 加载失败,回退产物 (app=${appId}): ${e?.message ?? e}`);
      }
    } else if (devUrl) {
      logHost("info", `devUrl 不可达,回退产物 (app=${appId})`);
    }
    try {
      await win.loadFile(shell, { query: { __miniWindowId: windowId } });
    } catch (e: any) {
      // mid-load 被销毁(stop/关窗竞速)时 loadFile 会 reject,detached promise
      // 里的 unhandled rejection 在主进程是致命的
      if (!win.isDestroyed()) logHost("error", `window load failed (app=${appId}): ${e?.message ?? e}`);
    }
  })();
  win.once("ready-to-show", () => win.show());
  trackWindow(appId, windowId, win);
  logHost("info", `window created (app=${appId}, id=${windowId}, type=${type})`);
  return windowId;
}

export function closeWindow(appId: string, windowId: string): boolean {
  const win = windowsByApp.get(appId)?.get(windowId);
  if (!win) return false;
  win.destroy();
  windowsByApp.get(appId)!.delete(windowId);
  return true;
}

export function closeAppWindows(appId: string): void {
  for (const win of windowsByApp.get(appId)?.values() ?? []) {
    try {
      win.destroy();
    } catch {
      /* ignore */
    }
  }
  windowsByApp.delete(appId);
}

/** 隐藏 App 的全部窗口。浮窗/面板类 App 的"关闭"语义 = 隐藏到托盘:
 *  渲染状态保留,启动器或托盘唤起时 focusApp 会 show 回来;真正销毁
 *  走 closeWindow(按 windowId)或 mini stop。返回隐藏的窗口数。 */
export function hideApp(appId: string): number {
  let n = 0;
  for (const win of windowsByApp.get(appId)?.values() ?? []) {
    if (!win.isDestroyed()) {
      win.hide();
      n += 1;
    }
  }
  if (n > 0) logHost("info", `window hidden (app=${appId}, count=${n})`);
  return n;
}

/** 把 App 的窗口提到最前(已最小化则还原);没有存活窗口返回 false。 */
export function focusApp(appId: string): boolean {
  const m = windowsByApp.get(appId);
  if (!m || m.size === 0) return false;
  for (const win of m.values()) {
    if (win.isDestroyed()) continue;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return true;
  }
  return false;
}

export function hasWindows(appId: string): boolean {
  const m = windowsByApp.get(appId);
  if (!m) return false;
  for (const win of m.values()) if (!win.isDestroyed()) return true;
  return false;
}

export function sendToUi(appId: string, msg: unknown): void {
  for (const win of windowsByApp.get(appId)?.values() ?? []) {
    if (!win.isDestroyed()) win.webContents.send("mini:app-to-ui", msg);
  }
}

export function appFromWebContents(webContentsId: number): string | undefined {
  return appByWebContents.get(webContentsId);
}

/** 诊断:当前 wc→app 归属表 */
export function ownershipDump(): string {
  return [...appByWebContents.entries()].map(([wc, id]) => `${wc}→${id}`).join(", ") || "(空)";
}
