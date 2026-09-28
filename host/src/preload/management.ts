import { contextBridge, ipcRenderer } from "electron";

type Page = { cursor?: number; limit?: number };
contextBridge.exposeInMainWorld("__management", {
  getApps: () => ipcRenderer.invoke("mini:management:getApps"),
  getApp: (id: string) => ipcRenderer.invoke("mini:management:getApp", id),
  action: (id: string, action: string) => ipcRenderer.invoke("mini:management:action", id, action),
  getHistory: (id: string, page?: Page) => ipcRenderer.invoke("mini:management:getHistory", id, page?.cursor, page?.limit),
  getLogs: (id: string, page?: Page) => ipcRenderer.invoke("mini:management:getLogs", id, page?.cursor, page?.limit),
  getSettings: () => ipcRenderer.invoke("mini:management:getSettings"),
  patchSettings: (patch: unknown) => ipcRenderer.invoke("mini:management:patchSettings", patch),
});
