export interface AppInfo {
  id: string;
  name: string;
  version?: string;
  path?: string;
  uiType?: string;
  status: string;
  enabled: boolean;
  favorite?: boolean;
  error?: string;
  pid?: number;
  lastUsedAt?: string;
  useCount?: number;
  manifestIssues?: string[];
  commands: { id: string; title: string }[];
  hotkeys?: { combo: string; command: string }[];
  permissions: string[];
}

export interface HostSettings {
  launcherHotkey: string;
  logRetentionDays: number;
  maxLogBytesPerApp: number;
}

export interface HistoryEvent {
  at: string;
  kind: string;
  outcome: string;
  command?: string;
  message?: string;
}

export interface Page {
  cursor?: number;
  limit?: number;
}

/** Shape of window.__management, injected by host/src/preload/management.ts. */
export interface ManagementBridge {
  getApps(): Promise<AppInfo[]>;
  getApp(id: string): Promise<AppInfo>;
  action(id: string, action: string): Promise<AppInfo>;
  getHistory(id: string, page?: Page): Promise<{ events?: HistoryEvent[] }>;
  getLogs(id: string, page?: Page): Promise<{ lines?: string[] }>;
  getSettings(): Promise<HostSettings>;
  patchSettings(patch: Partial<HostSettings>): Promise<HostSettings>;
}
