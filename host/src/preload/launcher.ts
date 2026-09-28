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
    ipcRenderer.on("mini:launcher:error", (_event, message: string) => cb(message));
  },
  onRefresh: (cb: () => void) => {
    ipcRenderer.on("mini:launcher:refresh", () => cb());
  },
});
