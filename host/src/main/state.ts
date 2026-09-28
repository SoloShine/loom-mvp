import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { paths } from "./config";
import { logHost } from "./logging";

export interface AppMeta {
  enabled: boolean;
  favorite: boolean;
  addedAt: string;
  lastUsedAt?: string;
  useCount: number;
}
export interface RecycleSettings {
  /** 总开关。关闭时清单声明也不生效。 */
  enabled: boolean;
  /** 全局默认闲置回收时长(分钟)。0 = 只回收清单声明过的 App。 */
  defaultMinutes: number;
  /** 例外名单:名单内的 App 永不自动回收。 */
  exemptAppIds: string[];
  /** 回收触发时弹系统通知;默认关,避免打扰。历史与日志始终可查。 */
  notify: boolean;
}
export interface Settings {
  launcherHotkey: string;
  logRetentionDays: number;
  maxLogBytesPerApp: number;
  recycle: RecycleSettings;
}
interface State {
  schemaVersion: 1;
  settings: Settings;
  apps: Record<string, AppMeta>;
  migratedFrom?: string;
}
export const defaults: Settings = {
  launcherHotkey: "Ctrl+Shift+M",
  logRetentionDays: 14,
  maxLogBytesPerApp: 10 * 1024 * 1024,
  recycle: { enabled: false, defaultMinutes: 0, exemptAppIds: [], notify: false },
};
const stateFile = () => path.join(paths.data, "host-state.json");
let state: State | undefined;
let readonly = false;

export function atomicWrite(file: string, value: string): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* leave old file intact */ }
  }
}
function object(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
function validId(id: string): boolean { return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id); }
export { validId };
function validSettings(s: unknown): s is Settings {
  if (!object(s)) return false;
  const r: unknown = s.recycle;
  return typeof s.launcherHotkey === "string" && s.launcherHotkey.length >= 3 && s.launcherHotkey.length <= 80 &&
    Number.isInteger(s.logRetentionDays) && (s.logRetentionDays as number) >= 1 && (s.logRetentionDays as number) <= 365 &&
    Number.isInteger(s.maxLogBytesPerApp) && (s.maxLogBytesPerApp as number) >= 1024 && (s.maxLogBytesPerApp as number) <= 1024 * 1024 * 1024 &&
    object(r) && typeof r.enabled === "boolean" &&
    Number.isInteger(r.defaultMinutes) && (r.defaultMinutes as number) >= 0 && (r.defaultMinutes as number) <= 7 * 24 * 60 &&
    typeof r.notify === "boolean" &&
    Array.isArray(r.exemptAppIds) && r.exemptAppIds.length <= 500 && r.exemptAppIds.every((id) => typeof id === "string" && validId(id));
}
/** 旧版本 host-state.json 缺少 recycle 段或段内新字段时逐项补默认值,避免整份文件被误判损坏。 */
function normalizeSettings(s: unknown): void {
  if (!object(s)) return;
  if (object(s.recycle)) {
    const r = s.recycle as Record<string, unknown>;
    if (r.enabled === undefined) r.enabled = false;
    if (r.defaultMinutes === undefined) r.defaultMinutes = 0;
    if (r.exemptAppIds === undefined) r.exemptAppIds = [];
    if (r.notify === undefined) r.notify = false;
  } else if (s.recycle === undefined) {
    s.recycle = { enabled: false, defaultMinutes: 0, exemptAppIds: [], notify: false };
  }
}
function validate(s: unknown): asserts s is State {
  if (!object(s) || s.schemaVersion !== 1 || !validSettings(s.settings) || !object(s.apps)) throw new Error("host-state schema 无效");
  for (const [id, meta] of Object.entries(s.apps)) {
    if (!validId(id) || !object(meta) || typeof meta.enabled !== "boolean" || typeof meta.favorite !== "boolean" ||
      typeof meta.addedAt !== "string" || (meta.lastUsedAt !== undefined && typeof meta.lastUsedAt !== "string") ||
      !Number.isSafeInteger(meta.useCount) || (meta.useCount as number) < 0) throw new Error(`host-state App 元数据无效: ${id}`);
  }
}
function backup(file: string): string {
  const source = fs.readFileSync(file);
  const digest = crypto.createHash("sha256").update(source).digest("hex");
  const target = `${file}.${new Date().toISOString().replace(/[:.]/g, "-")}.${digest.slice(0, 12)}.bak`;
  fs.writeFileSync(target, source, { flag: "wx", mode: 0o600 });
  if (crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex") !== digest) throw new Error(`迁移备份校验失败: ${target}`);
  return digest;
}
export function initState(): void {
  if (state) return;
  const file = stateFile();
  if (fs.existsSync(file)) {
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {
      const damaged = `${file}.${Date.now()}.corrupt`;
      fs.renameSync(file, damaged);
      logHost("error", `host-state 损坏，已旁路备份: ${damaged}: ${String(e)}`);
      readonly = true;
      state = { schemaVersion: 1, settings: { ...defaults }, apps: {} };
      return;
    }
    if (object(raw) && typeof raw.schemaVersion === "number" && raw.schemaVersion > 1) {
      readonly = true;
      state = { schemaVersion: 1, settings: { ...defaults }, apps: {} };
      logHost("error", `host-state 来自较新版本(${raw.schemaVersion})，本版本只读`);
      return;
    }
    normalizeSettings(object(raw) ? raw.settings : undefined);
    try { validate(raw); state = raw; return; } catch (e) {
      const damaged = `${file}.${Date.now()}.corrupt`;
      fs.renameSync(file, damaged);
      readonly = true;
      state = { schemaVersion: 1, settings: { ...defaults }, apps: {} };
      logHost("error", `host-state 格式无效，已旁路备份: ${damaged}: ${String(e)}`);
      return;
    }
  }
  const next: State = { schemaVersion: 1, settings: { ...defaults }, apps: {} };
  if (fs.existsSync(paths.registryFile)) {
    const digest = backup(paths.registryFile);
    next.migratedFrom = digest;
    try {
      const legacy: unknown = JSON.parse(fs.readFileSync(paths.registryFile, "utf8"));
      if (object(legacy) && Array.isArray(legacy.disabled) && legacy.disabled.every((v) => typeof v === "string")) {
        for (const id of legacy.disabled) if (validId(id)) next.apps[id] = { enabled: false, favorite: false, addedAt: new Date().toISOString(), useCount: 0 };
      } else logHost("warn", "旧 registry disabled 结构无效，按空集合迁移");
    } catch { logHost("warn", "旧 registry JSON 无效，按空集合迁移"); }
  }
  atomicWrite(file, JSON.stringify(next, null, 2));
  state = next;
}
function current(): State { if (!state) initState(); return state!; }
function update(mutator: (s: State) => void): void {
  if (readonly) throw new Error("host-state 只读，先处理损坏或较新版本文件");
  const next: State = structuredClone(current());
  mutator(next);
  validate(next);
  atomicWrite(stateFile(), JSON.stringify(next, null, 2));
  state = next;
}
export function meta(id: string): AppMeta | undefined { const value = current().apps[id]; return value ? { ...value } : undefined; }
export function settings(): Settings {
  const s = current().settings;
  return { ...s, recycle: { ...s.recycle, exemptAppIds: [...s.recycle.exemptAppIds] } };
}
export function patchSettings(patch: unknown): Settings {
  if (!object(patch) || Object.keys(patch).some((k) => !Object.hasOwn(defaults, k))) throw new Error("设置包含未知字段");
  const result = { ...settings(), ...patch };
  if (!validSettings(result)) throw new Error("设置值超出允许范围");
  update((s) => { s.settings = result; });
  return settings();
}
export function setMeta(id: string, patch: Partial<Pick<AppMeta, "enabled" | "favorite">>): AppMeta {
  if (!validId(id) || Object.keys(patch).some((k) => k !== "enabled" && k !== "favorite") || Object.values(patch).some((v) => typeof v !== "boolean")) throw new Error("无效 App 元数据");
  update((s) => { const existing = s.apps[id]; s.apps[id] = { ...(existing ?? { enabled: true, favorite: false, addedAt: new Date().toISOString(), useCount: 0 }), ...patch }; });
  return meta(id)!;
}
export function recordUse(id: string): void {
  try {
    update((s) => { const m = s.apps[id] ?? { enabled: true, favorite: false, addedAt: new Date().toISOString(), useCount: 0 }; m.lastUsedAt = new Date().toISOString(); m.useCount++; s.apps[id] = m; });
  } catch (e) { logHost("warn", `最近使用写入失败 ${id}: ${String(e)}`); }
}
