import { app, ipcMain } from "electron";
import { initDataDir, paths } from "./config";
import { initLogging, logHost, configureLogging } from "./logging";
import * as registry from "./registry";
import { startControlChannel, shutdownControlChannel } from "./controlChannel";
import { initLauncher, showLauncher, shutdownLauncher, notifyRegistryChanged } from "./launcher";
import * as manager from "./runtime/manager";
import * as windows from "./services/windows";
import { dispatch } from "./services/dispatcher";
import * as processSvc from "./services/processSvc";
import * as hotkeys from "./services/hotkeys";
import * as state from "./state";
import * as history from "./history";
import { initManagement, shutdownManagement } from "./management";
import { configureSettingsCommitter } from "./settingsCommit";
import { createShutdownCoordinator } from "./shutdown";

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showLauncher());

  app.whenReady().then(boot).catch((e) => {
    console.error("host boot failed:", e);
    app.quit();
  });
}

function boot(): Promise<void> {
  initDataDir();
  initLogging();
  logHost("info", `host pid=${process.pid}, root=${paths.root}`);

  state.initState();
  configureLogging(state.settings());
  history.initRuns();
  registry.initRegistry();
  registry.onRegistryChange(() => {
    logHost("info", "registry changed");
    notifyRegistryChanged();
  });

  ipcMain.on("mini:preload-loaded", (_e, tag: string) => {
    logHost("info", `preload loaded: ${tag} (wc=${_e.sender.id})`);
  });

  // renderer → host service calls (app windows)
  ipcMain.handle("mini:svc", async (e, payload: { service: string; method: string; args?: unknown }) => {
    const appId = windows.appFromWebContents(e.sender.id);
    if (manager.isDraining() || !appId || !registry.get(appId)?.enabled || manager.status(appId) !== "running" || e.sender.isDestroyed()) {
      throw new Error("FORBIDDEN: App window unavailable");
    }
    return dispatch(
      { appId, appPath: registry.get(appId)?.path ?? "", pushEvent: () => {} },
      payload.service,
      payload.method,
      payload.args,
    );
  });

  // window → app runtime message relay
  ipcMain.on("mini:ui-to-app", (e, msg: unknown) => {
    const appId = windows.appFromWebContents(e.sender.id);
    if (!appId || manager.isDraining() || manager.status(appId) !== "running" || !registry.get(appId)?.enabled || e.sender.isDestroyed()) {
      logHost("warn", `ui-to-app: 拒绝窗口消息 (wc=${e.sender.id})`);
      return;
    }
    logHost("info", `ui-to-app app=${appId}: ${JSON.stringify(msg)?.slice(0, 120)}`);
    manager.uiMessageFromWindow(appId, msg);
  });

  configureSettingsCommitter((next, commit) => {
    const { updateLauncherHotkey } = require("./launcher") as typeof import("./launcher");
    updateLauncherHotkey(next, commit);
  });
  initManagement((next, commit) => {
    const { updateLauncherHotkey } = require("./launcher") as typeof import("./launcher");
    updateLauncherHotkey(next, commit);
  });
  initLauncher();

  process.on("uncaughtException", (e) => {
    logHost("error", `uncaughtException: ${e?.stack ?? e}`);
  });
  process.on("unhandledRejection", (e) => {
    logHost("error", `unhandledRejection: ${String(e)}`);
  });
  return startControlChannel();
}

app.on("window-all-closed", () => {
  // tray-resident host: stay alive
});

const shutdown = createShutdownCoordinator({
  drain: () => { manager.beginDraining(); shutdownControlChannel(); },
  activeIds: manager.activeIds,
  stop: manager.stop,
  force: manager.forceStop,
  isActive: (id) => manager.activeIds().includes(id),
  waitForExit: manager.waitForExit,
  finalize: (results) => {
    for (const result of results) if (result.outcome !== "stopped") logHost("error", `SHUTDOWN_INCOMPLETE ${result.appId}: ${result.outcome} ${result.error ?? ""}`);
    shutdownLauncher();
    shutdownManagement();
    processSvc.killAllHelpers();
    registry.shutdownRegistry();
    hotkeys.unregisterAll();
  },
  quit: () => app.quit(),
  log: (message) => logHost("error", message),
});
app.on("before-quit", shutdown.beforeQuit);
