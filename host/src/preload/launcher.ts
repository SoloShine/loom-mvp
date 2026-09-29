import { contextBridge, ipcRenderer } from "electron";

/** Bridge for the launcher palette page. */
contextBridge.exposeInMainWorld("__launcher", {
  getApps: () => ipcRenderer.invoke("mini:launcher:getApps"),
  startApp: (id: string) => ipcRenderer.invoke("mini:launcher:startApp", id),
  invokeCommand: (id: string, command: string) =>
    ipcRenderer.invoke("mini:launcher:invoke", { id, command }),
  hide: () => ipcRenderer.send("mini:launcher:hide"),
  openManagement: () => ipcRenderer.send("mini:launcher:manage"),
  onError: (cb: (message: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string) => cb(message);
    ipcRenderer.on("mini:launcher:error", handler);
    return () => ipcRenderer.removeListener("mini:launcher:error", handler);
  },
  onRefresh: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("mini:launcher:refresh", handler);
    return () => ipcRenderer.removeListener("mini:launcher:refresh", handler);
  },
});
