import type { LauncherBridge } from "@/types";
import { mockLauncherApps } from "@/mocks";

// Palette bridge, structurally mirroring lib/bridge.ts: the sandboxed preload
// exposes window.__launcher inside the Electron palette window; in a plain
// browser it is absent and the demo mocks keep the palette explorable.

const real = (window as unknown as { __launcher?: LauncherBridge }).__launcher ?? null;

export const demoMode = !real;

function demoFail<T>(what: string): Promise<T> {
  return Promise.reject(new Error(`演示模式:未接入 Host,${what}不可用`));
}

export const bridge: LauncherBridge =
  real ?? {
    getApps: async () => mockLauncherApps,
    startApp: () => demoFail<boolean>("启动 App"),
    invokeCommand: () => demoFail<boolean>("执行命令"),
    hide: () => {},
    openManagement: () => {},
    onError: () => () => {},
    onRefresh: () => () => {},
  };
