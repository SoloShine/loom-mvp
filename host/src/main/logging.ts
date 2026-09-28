import fs from "node:fs";
import path from "node:path";
import { paths } from "./config";

 type Level = "info" | "warn" | "error";
let maxLogBytes = 10 * 1024 * 1024;
let retentionDays = 14;

export function configureLogging(settings: { maxLogBytesPerApp: number; logRetentionDays: number }): void {
  maxLogBytes = settings.maxLogBytesPerApp;
  retentionDays = settings.logRetentionDays;
}

export function currentLoggingConfig(): { maxLogBytesPerApp: number; logRetentionDays: number } {
  return { maxLogBytesPerApp: maxLogBytes, logRetentionDays: retentionDays };
}
function line(level: Level, msg: string): string {
  return `${new Date().toISOString()} [${level}] ${msg}\n`;
}

function rotate(file: string): void {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < maxLogBytes) return;
    const rotated = `${file}.${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
    fs.renameSync(file, rotated);
  } catch {
    /* logging must never crash the host */
  }
}

function prune(dir: string, prefix: string): void {
  try {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(`${prefix}.`) || !name.endsWith(".log")) continue;
      const file = path.join(dir, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    }
  } catch {
    /* logging must never crash the host */
  }
}

function append(file: string, text: string, prefix: string): void {
  try {
    rotate(file);
    fs.appendFileSync(file, text);
    prune(path.dirname(file), prefix);
  } catch {
    /* logging must never crash the host */
  }
}

export function initLogging(): void {
  logHost("info", "host starting");
}

export function appLogPath(appId: string): string {
  return path.join(paths.appLogs, `${appId}.log`);
}

export function logHost(level: Level, msg: string): void {
  const text = line(level, msg);
  append(path.join(paths.logs, "host.log"), text, "host.log");
  if (level === "error") console.error(text.trimEnd());
  else console.log(text.trimEnd());
}

export function logApp(appId: string, level: Level, msg: string): void {
  append(appLogPath(appId), line(level, msg), appId);
}

export function logAppStd(appId: string, stream: "stdout" | "stderr", msg: string): void {
  append(appLogPath(appId), `${new Date().toISOString()} [helper:${stream}] ${msg}\n`, appId);
}
