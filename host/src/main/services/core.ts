import { clipboard, dialog, Notification } from "electron";
import fs from "node:fs";
import path from "node:path";
import { paths } from "../config";
import { logHost } from "../logging";
import { validateClickCommand } from "./notificationClick";

// --- clipboard ------------------------------------------------------------

export const clipboardApi = {
  readText: (): Promise<string> => Promise.resolve(clipboard.readText()),
  writeText: (text: string): Promise<null> => {
    clipboard.writeText(text);
    return Promise.resolve(null);
  },
};

// --- files -----------------------------------------------------------------

function sameRoot(a: string, b: string): boolean {
  return path.parse(a).root.toLowerCase() === path.parse(b).root.toLowerCase();
}

/** 跨卷复制后的最低校验:尺寸一致(文件比大小,目录比累计大小)。 */
function verifyCopied(from: string, to: string): void {
  const sizeOf = (p: string): number => {
    const st = fs.statSync(p);
    return st.isFile() ? st.size : fs.readdirSync(p).reduce((n, name) => n + sizeOf(path.join(p, name)), 0);
  };
  if (sizeOf(from) !== sizeOf(to)) throw new Error(`E_VERIFY: 跨卷复制校验失败(尺寸不一致): ${to}`);
}

export const filesApi = {
  read: (p: string): string => fs.readFileSync(p, "utf8"),
  write: (p: string, data: string): null => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
    return null;
  },
  // copy/move 默认不覆盖已存在目标;跨卷 move 走「复制到同卷临时名 → 校验 →
  // rename 就位 → 删源」,任一步失败保源并清理临时文件。
  copy: (from: string, to: string, opts?: { overwrite?: boolean }): null => {
    if (!opts?.overwrite && fs.existsSync(to)) throw new Error(`E_EXISTS: 目标已存在: ${to}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true, force: !!opts?.overwrite, errorOnExist: !opts?.overwrite });
    return null;
  },
  move: (from: string, to: string, opts?: { sameVolume?: (a: string, b: string) => boolean }): null => {
    if (fs.existsSync(to)) throw new Error(`E_EXISTS: 目标已存在,不覆盖: ${to}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const sameVolume = opts?.sameVolume ?? sameRoot;
    if (sameVolume(from, to)) {
      fs.renameSync(from, to); // 同卷改名;失败即报错,不静默转复制(会覆盖/丢源)
      return null;
    }
    const tmp = path.join(
      path.dirname(to),
      `.${path.basename(to)}.mini-move-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    try {
      fs.cpSync(from, tmp, { recursive: true, force: false, errorOnExist: true });
      verifyCopied(from, tmp);
      fs.renameSync(tmp, to);
    } catch (e) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
      throw e;
    }
    fs.rmSync(from, { recursive: true, force: true });
    return null;
  },
  remove: (p: string): null => {
    fs.rmSync(p, { recursive: true, force: true });
    return null;
  },
  async selectFile(): Promise<string | null> {
    const res = await dialog.showOpenDialog({ properties: ["openFile"] });
    return res.canceled ? null : res.filePaths[0] ?? null;
  },
  async selectDirectory(): Promise<string | null> {
    const res = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return res.canceled ? null : res.filePaths[0] ?? null;
  },
};

// --- storage (per-app namespace, JSON file per app) -------------------------

const caches = new Map<string, Record<string, unknown>>();

function storageFile(appId: string): string {
  return path.join(paths.storage, `${appId}.json`);
}

function loadStore(appId: string): Record<string, unknown> {
  const existing = caches.get(appId);
  if (existing) return existing;
  const file = storageFile(appId);
  let store: Record<string, unknown> = {};
  let corrupt = false;
  if (fs.existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) store = parsed as Record<string, unknown>;
      else corrupt = true;
    } catch {
      corrupt = true;
    }
  }
  if (corrupt) {
    // 坏文件不静默清零:改名留证,从空数据起步
    const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      fs.renameSync(file, backup);
      logHost("warn", `storage ${appId}: 数据文件损坏,已保留为 ${path.basename(backup)},从空数据起步`);
    } catch (e) {
      logHost("warn", `storage ${appId}: 数据文件损坏且备份失败: ${String(e)}`);
    }
  }
  caches.set(appId, store);
  return store;
}

function saveStore(appId: string, candidate: Record<string, unknown>): void {
  const file = storageFile(appId);
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(candidate, null, 2));
  fs.renameSync(tmp, file);
}

export const storageApi = {
  get: (appId: string, key: string): unknown => loadStore(appId)[key] ?? null,
  // 先写盘成功、再更新内存 cache:写失败时内存与磁盘保持一致
  set: (appId: string, key: string, value: unknown): null => {
    const store = loadStore(appId);
    saveStore(appId, { ...store, [key]: value });
    store[key] = value;
    return null;
  },
  delete: (appId: string, key: string): null => {
    const store = loadStore(appId);
    if (!(key in store)) return null;
    const candidate: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(store)) if (k !== key) candidate[k] = v;
    saveStore(appId, candidate);
    delete store[key];
    return null;
  },
  keys: (appId: string): string[] => Object.keys(loadStore(appId)),
};

// --- notification ------------------------------------------------------------

// 通知 click 的分发回调由 manager 启动时注入(同 setWindowActivityHook 先例):
// core 不能 import manager(manager → dispatcher → core 成环)。
let clickDispatcher: ((appId: string, command: string) => Promise<void>) | null = null;

export function setNotificationClickDispatcher(fn: (appId: string, command: string) => Promise<void>): void {
  clickDispatcher = fn;
}

export const notificationApi = {
  show(opts: { appId: string; title: string; body?: string; clickCommand?: string; declaredCommands: string[] }): boolean {
    // 校验不依赖系统是否支持通知:拼写错在任何平台上都当场经 SDK promise 拒绝
    if (opts.clickCommand !== undefined) {
      const invalid = validateClickCommand(opts.clickCommand, opts.declaredCommands);
      if (invalid) throw new Error(invalid);
    }
    if (!Notification.isSupported()) return false;
    const notification = new Notification({ title: opts.title, body: opts.body ?? "" });
    if (opts.clickCommand) {
      const command = opts.clickCommand;
      notification.on("click", () => {
        // 通知留在通知中心,点击可能发生在任意时刻(App 或已 stop/重启);
        // 分发失败绝不能向主进程顶层抛,这里整体吞掉(注入侧已自带 warn 日志)。
        try {
          void clickDispatcher?.(opts.appId, command).catch(() => {});
        } catch { /* 通知点击不得影响 Host 进程 */ }
      });
    }
    notification.show();
    return true;
  },
};
