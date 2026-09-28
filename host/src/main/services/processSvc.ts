import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { logAppStd, logHost } from "../logging";

/**
 * Helper processes spawned by Mini Apps via host.process.spawn.
 * The HOST owns them: stdout/stderr are tee'd into the app log, and the
 * whole tree is killed when the app stops (a crash of the app process
 * must not leave orphan helpers).
 */

interface TrackedProc {
  appId: string;
  child: ChildProcess;
}

const procs = new Map<string, TrackedProc>();
let seq = 0;

export function spawnHelper(
  appId: string,
  opts: { command: string; args?: string[]; cwd?: string; env?: Record<string, string> },
  pushEvent: (key: string, event: string, data: unknown) => void,
): { handleId: string; pid: number } {
  const handleId = `spawn-${++seq}`;
  const child = spawn(opts.command, opts.args ?? [], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  procs.set(handleId, { appId, child });

  const pipe = (stream: "stdout" | "stderr") => {
    if (!child[stream]) return;
    readline.createInterface({ input: child[stream]! }).on("line", (line) => {
      logAppStd(appId, stream, line);
      pushEvent(`${handleId}:${stream}`, "line", { line });
    });
  };
  pipe("stdout");
  pipe("stderr");

  child.on("error", (e) => {
    logAppStd(appId, "stderr", `spawn error: ${e.message}`);
  });
  child.on("exit", (code) => {
    procs.delete(handleId);
    logAppStd(appId, "stdout", `[helper] exited with code ${code}`);
    pushEvent(`${handleId}:exit`, "exit", { code });
  });

  logAppStd(appId, "stdout", `[helper] spawned ${opts.command} (pid ${child.pid})`);
  return { handleId, pid: child.pid ?? -1 };
}

export function write(appId: string, handleId: string, data: string): boolean {
  const p = procs.get(handleId);
  if (!p || p.appId !== appId || !p.child.stdin) return false;
  p.child.stdin.write(data);
  return true;
}

function treeKill(pid: number): void {
  if (!pid || pid <= 0) return;
  const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
  killer.on("error", (e) => logHost("warn", `taskkill ${pid} 失败: ${e.message}`));
}

export function kill(appId: string, handleId: string): boolean {
  const p = procs.get(handleId);
  if (!p || p.appId !== appId) return false;
  procs.delete(handleId);
  treeKill(p.child.pid ?? -1);
  return true;
}

export function killAppHelpers(appId: string): void {
  for (const [handleId, p] of [...procs.entries()]) {
    if (p.appId !== appId) continue;
    procs.delete(handleId);
    treeKill(p.child.pid ?? -1);
  }
}

export function killAllHelpers(): void {
  for (const [handleId, p] of [...procs.entries()]) {
    procs.delete(handleId);
    treeKill(p.child.pid ?? -1);
  }
}
