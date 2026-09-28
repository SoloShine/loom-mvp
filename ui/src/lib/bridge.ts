import type { AppInfo, HistoryEvent, ManagementBridge, HostSettings } from "@/types";
import { mockApps, mockHistory, mockLogs, mockSettings } from "@/mocks";

// In the Electron management window the sandboxed preload exposes
// window.__management; in a plain browser (UI development) it is absent and
// the demo mocks below keep every page functional.

const real = (window as unknown as { __management?: ManagementBridge }).__management ?? null;

export const demoMode = !real;

function demoFail<T>(what: string): Promise<T> {
  return Promise.reject(new Error(`演示模式:未接入 Host,${what}不可用`));
}

export const bridge: ManagementBridge =
  real ?? {
    getApps: async () => mockApps,
    getApp: async (id) => {
      const app = mockApps.find((a) => a.id === id);
      if (!app) return Promise.reject(new Error(`NOT_FOUND: ${id}`));
      return app;
    },
    action: (_id, _action) => demoFail<AppInfo>("App 操作"),
    getHistory: async (id) => ({ events: (mockHistory[id] ?? []) as HistoryEvent[] }),
    getLogs: async (id) => ({ lines: mockLogs[id] ?? [] }),
    getSettings: async () => mockSettings,
    patchSettings: (_patch) => demoFail<HostSettings>("保存设置"),
  };

/** IPC rejections arrive as "Error invoking remote method 'x': Error: msg"; strip to msg. */
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "");
}
