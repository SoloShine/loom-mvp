import { contextBridge, ipcRenderer } from "electron";

// 诊断:preload 是否执行、原始 ipc 是否可用(contextBridge 之外的事实)
try {
  ipcRenderer.send("mini:preload-loaded", "app-window ok");
} catch (e: any) {
  try {
    ipcRenderer.send("mini:preload-loaded", "app-window ERR " + e?.message);
  } catch {
    /* 完全无法通信 */
  }
}

/**
 * Bridge inside Mini App windows. Two surfaces:
 *  - __miniHost.call: host service calls (renderer side of @mini/sdk)
 *  - app message bus: window ↔ app runtime process, relayed by host
 */
contextBridge.exposeInMainWorld("__miniHost", {
  call: (service: string, method: string, args?: unknown) =>
    ipcRenderer.invoke("mini:svc", { service, method, args }),

  appSend: (msg: unknown) => ipcRenderer.send("mini:ui-to-app", msg),

  onAppMessage: (cb: (msg: unknown) => void) => {
    ipcRenderer.on("mini:app-to-ui", (_e, data) => cb(data));
  },

  onSvcEvent: (cb: (m: { key: string; event: string; data: unknown }) => void) => {
    ipcRenderer.on("mini:svc-event", (_e, data) => cb(data));
  },
});
