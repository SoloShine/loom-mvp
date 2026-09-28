import fs from "node:fs";
import path from "node:path";
import { paths } from "./config";
import { parseManifest, type Manifest } from "./manifest";
import * as state from "./state";
import { logHost } from "./logging";

export interface HotkeyBinding {
  combo: string;
  command: string;
}

export interface AppEntry {
  id: string;
  name: string;
  version: string;
  /** app directory (absolute) */
  path: string;
  distDir: string;
  manifest: Manifest;
  enabled: boolean;
  favorite: boolean;
  addedAt?: string;
  lastUsedAt?: string;
  useCount: number;
  /** declared in manifest but missing from disk */
  manifestIssues: string[];
  hotkeys: HotkeyBinding[];
}

export interface BrokenAppEntry {
  id: string;
  dir: string;
  status: "broken";
  error: string;
}

export type RegistryEntry = AppEntry | BrokenAppEntry;

export function isBroken(e: RegistryEntry): e is BrokenAppEntry {
  return (e as BrokenAppEntry).status === "broken";
}

export function loadApp(dir: string): RegistryEntry {
  const dirName = path.basename(dir);
  const manifestPath = path.join(dir, "app.yaml");
  if (!fs.existsSync(manifestPath)) {
    return { id: dirName, dir, status: "broken", error: "缺少 app.yaml" };
  }
  const parsed = parseManifest(fs.readFileSync(manifestPath, "utf8"), dirName);
  if (!parsed.ok || !parsed.manifest) {
    return { id: dirName, dir, status: "broken", error: parsed.errors.join("; ") };
  }
  const m = parsed.manifest;

  const issues: string[] = [];
  if (!fs.existsSync(path.join(dir, m.entry))) {
    issues.push(`entry 不存在: ${m.entry}`);
  }
  if (m.ui.type !== "none" && !fs.existsSync(path.join(dir, "dist", "ui.js"))) {
    issues.push("manifest 声明了 ui 但缺少 dist/ui.js(需要 src/ui.ts 并构建)");
  }
  if (m.entry.endsWith(".ts") && !fs.existsSync(path.join(dir, "dist", "main.js"))) {
    issues.push("缺少构建产物 dist/main.js(先运行 mini build)");
  }

  const meta = state.meta(m.id);
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    path: dir,
    distDir: path.join(dir, "dist"),
    manifest: m,
    enabled: meta?.enabled ?? true,
    favorite: meta?.favorite ?? false,
    addedAt: meta?.addedAt,
    lastUsedAt: meta?.lastUsedAt,
    useCount: meta?.useCount ?? 0,
    manifestIssues: issues,
    hotkeys: Object.entries(m.hotkeys).map(([command, combo]) => ({ combo, command })),
  };
}

export function scanApps(): RegistryEntry[] {
  const out: RegistryEntry[] = [];
  let dirs: string[] = [];
  try {
    dirs = fs
      .readdirSync(paths.apps, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(paths.apps, d.name));
  } catch {
    return out;
  }
  for (const dir of dirs) {
    try {
      out.push(loadApp(dir));
    } catch (e: any) {
      out.push({ id: path.basename(dir), dir, status: "broken", error: String(e?.message ?? e) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// registry singleton
// ---------------------------------------------------------------------------

const apps = new Map<string, RegistryEntry>();
let watcher: fs.FSWatcher | null = null;
let rescanTimer: NodeJS.Timeout | null = null;
const changeListeners = new Set<() => void>();

export function initRegistry(): void {
  rescan();
  try {
    watcher = fs.watch(paths.apps, { recursive: false }, () => {
      if (rescanTimer) clearTimeout(rescanTimer);
      rescanTimer = setTimeout(() => {
        const before = JSON.stringify(serializable());
        rescan();
        const after = JSON.stringify(serializable());
        if (before !== after) {
          logHost("info", "apps 目录变化,registry 已更新");
          for (const fn of changeListeners) fn();
        }
      }, 400);
    });
  } catch (e: any) {
    logHost("warn", `apps 目录 watch 失败: ${e?.message ?? e}`);
  }
}

function serializable(): RegistryEntry[] {
  return [...apps.values()];
}

export function rescan(): void {
  apps.clear();
  for (const entry of scanApps()) apps.set(entry.id, entry);
}

export function onRegistryChange(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

export function get(id: string): AppEntry | undefined {
  const e = apps.get(id);
  return e && !isBroken(e) ? e : undefined;
}

export function getError(id: string): string | undefined {
  const e = apps.get(id);
  return e && isBroken(e) ? e.error : undefined;
}

export function list(): RegistryEntry[] {
  return [...apps.values()];
}

export function setEnabled(id: string, enabled: boolean): boolean {
  const e = apps.get(id);
  if (!e || isBroken(e)) return false;
  state.setMeta(id, { enabled });
  e.enabled = enabled;
  return true;
}

export function setFavorite(id: string, favorite: boolean): boolean {
  const e = apps.get(id);
  if (!e || isBroken(e)) return false;
  state.setMeta(id, { favorite });
  e.favorite = favorite;
  return true;
}

export function recordUse(id: string): void {
  state.recordUse(id);
  const e = apps.get(id);
  const m = state.meta(id);
  if (e && !isBroken(e) && m) {
    e.lastUsedAt = m.lastUsedAt;
    e.useCount = m.useCount;
  }
}

export function shutdownRegistry(): void {
  watcher?.close();
  watcher = null;
}
