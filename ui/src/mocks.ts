import type { AppInfo, HistoryEvent, HostSettings } from "@/types";

// Demo data used when the page runs outside Electron (no preload bridge),
// so the UI can be developed and reviewed in a plain browser.

export const mockApps: AppInfo[] = [
  {
    id: "lianliankan",
    name: "连连看助手",
    version: "0.1.0",
    path: "D:\\Project\\loom-mvp\\apps\\lianliankan",
    uiType: "floating",
    status: "running",
    enabled: true,
    favorite: true,
    lastUsedAt: "2026-09-28 10:12",
    useCount: 46,
    commands: [
      { id: "select-region", title: "框选棋盘区域" },
      { id: "solve", title: "扫描并求解" },
      { id: "selftest", title: "自检" },
    ],
    hotkeys: [{ combo: "Ctrl+Shift+K", command: "solve" }],
    permissions: ["screen.capture", "screen.selectRegion", "mouse.click", "process.spawn", "storage", "notification.show", "log"],
  },
  {
    id: "file-organizer",
    name: "文件整理器",
    version: "0.2.0",
    path: "D:\\Project\\loom-mvp\\apps\\file-organizer",
    uiType: "window",
    status: "running",
    enabled: true,
    lastUsedAt: "2026-09-27 23:50",
    useCount: 8,
    commands: [
      { id: "preview", title: "扫描目录并预览计划" },
      { id: "execute", title: "执行当前计划" },
    ],
    permissions: ["files.move", "files.selectDirectory", "storage", "notification.show", "log"],
  },
  {
    id: "hello",
    name: "Hello",
    version: "0.1.0",
    path: "D:\\Project\\loom-mvp\\apps\\hello",
    uiType: "window",
    status: "stopped",
    enabled: true,
    useCount: 21,
    lastUsedAt: "2026-09-26 18:40",
    commands: [{ id: "ping", title: "Ping" }, { id: "selftest", title: "自检" }],
    permissions: ["storage", "log"],
  },
  {
    id: "screen-inspector",
    name: "屏幕检查器",
    version: "0.1.0",
    path: "D:\\Project\\loom-mvp\\apps\\screen-inspector",
    uiType: "window",
    status: "stopped",
    enabled: true,
    useCount: 3,
    lastUsedAt: "2026-09-27 11:52",
    commands: [{ id: "capture", title: "截取屏幕" }],
    permissions: ["screen.capture", "screen.getMonitors", "storage"],
  },
  {
    id: "clipboard-tool",
    name: "剪贴板工具",
    version: "0.1.0",
    path: "D:\\Project\\loom-mvp\\apps\\clipboard-tool",
    uiType: "window",
    status: "stopped",
    enabled: false,
    useCount: 1,
    lastUsedAt: "2026-09-27 11:55",
    commands: [{ id: "read", title: "读取剪贴板" }],
    permissions: ["clipboard.readText", "clipboard.writeText", "notification.show"],
  },
];

export const mockLogs: Record<string, string[]> = {
  "file-organizer": [
    "2026-09-27T15:50:19.798Z [info] file-organizer started",
    "2026-09-27T15:50:26.881Z [info] file-organizer moved 3, skipped 1, failed 0 in C:/Users/.../Temp/mini-org-smoke-3h6c (6ms)",
    "2026-09-27T15:51:02.104Z [info] file-organizer stopped",
  ],
  lianliankan: [
    "2026-09-28T10:12:03.220Z [info] session started, board 10x14",
    "2026-09-28T10:12:05.881Z [info] plan ready: 30 classes, 0 odd, threshold auto (0.62)",
    "2026-09-28T10:12:44.517Z [info] pair (3,4)<->(3,7) verified, remaining 138",
  ],
  hello: ["2026-09-26T18:40:11.003Z [info] selftest ok (5/5)"],
  "screen-inspector": ["2026-09-27T11:52:44.010Z [info] captured 3840x2160 @1.5"],
  "clipboard-tool": ["2026-09-27T11:55:07.392Z [info] text copied (24 chars)"],
};

export const mockHistory: Record<string, HistoryEvent[]> = {
  "file-organizer": [
    { at: "2026-09-27T15:50:19Z", kind: "start", outcome: "ok" },
    { at: "2026-09-27T15:50:26Z", kind: "invoke", outcome: "ok", command: "preview", message: "total 4 / move 3 / conflict 1" },
    { at: "2026-09-27T15:50:41Z", kind: "invoke", outcome: "ok", command: "execute", message: "moved 3, skipped 1" },
    { at: "2026-09-27T15:51:02Z", kind: "stop", outcome: "ok" },
  ],
  lianliankan: [
    { at: "2026-09-28T10:12:03Z", kind: "start", outcome: "ok" },
    { at: "2026-09-28T10:14:52Z", kind: "invoke", outcome: "ok", command: "solve" },
  ],
};

export const mockSettings: HostSettings = {
  launcherHotkey: "Ctrl+Shift+M",
  logRetentionDays: 14,
  maxLogBytesPerApp: 1048576,
  recycle: { enabled: false, defaultMinutes: 30, exemptAppIds: ["lianliankan"], notify: false },
};
