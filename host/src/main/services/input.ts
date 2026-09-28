import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { paths } from "../config";
import { logHost } from "../logging";

/**
 * Mouse + keyboard control via a persistent PowerShell helper
 * (SendInput). The helper is spawned lazily and stays alive for the
 * host lifetime. Coordinates: physical pixels.
 */

let proc: ChildProcess | null = null;
let rl: readline.Interface | null = null;
let starting: Promise<void> | null = null;
let chain: Promise<unknown> = Promise.resolve();

function ensureProc(): Promise<void> {
  if (proc && proc.stdin && proc.stdin.writable) return Promise.resolve();
  if (starting) return starting;
  starting = new Promise<void>((resolve, reject) => {
    logHost("info", "starting input helper");
    const p = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", paths.inputHelper],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    proc = p;
    rl = readline.createInterface({ input: p.stdout! });
    p.stderr!.on("data", (d: Buffer) => {
      logHost("warn", `input-helper stderr: ${d.toString().trim()}`);
    });
    p.on("exit", (code) => {
      logHost("warn", `input-helper exited (${code})`);
      proc = null;
      rl = null;
      starting = null;
    });
    p.on("error", (e) => {
      starting = null;
      reject(e);
    });
    resolve();
  });
  return starting;
}

function request(payload: Record<string, unknown>, timeoutMs = 10_000): Promise<any> {
  const run = async (): Promise<any> => {
    await ensureProc();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("input-helper 响应超时")), timeoutMs);
      rl!.once("line", (line) => {
        clearTimeout(timer);
        try {
          const res = JSON.parse(line);
          if (res.ok) resolve(res); // 完整响应:{ result, diag? }
          else reject(new Error(res.error ?? "input-helper error"));
        } catch {
          reject(new Error(`input-helper 响应解析失败: ${line.slice(0, 100)}`));
        }
      });
      proc!.stdin!.write(JSON.stringify(payload) + "\n");
    });
  };
  // the helper answers strictly in order; serialize requests
  const next = chain.then(run, run);
  chain = next.catch(() => {});
  return next;
}

export const mouseApi = {
  position: async (): Promise<{ x: number; y: number }> =>
    (await request({ op: "position" })).result,
  move: (x: number, y: number) => request({ op: "move", x, y }),
  click: (x: number, y: number, button: string) => request({ op: "click", x, y, button }),
  doubleClick: (x: number, y: number) => request({ op: "dblclick", x, y }),
  /**
   * 全局等待一次左键点击(真实屏幕物理坐标;Esc 取消 / 超时返回标记)。
   * 用独立的一次性 PowerShell 进程:wait-click 会长时间阻塞,
   * 不能占用常驻 helper 的串行点击链。
   */
  waitClick: async () => {
    const p = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", paths.inputHelper, "-WaitClick"],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    try {
      const line = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("wait-click 超时(120s)")), 120_000);
        rl2(p, (l) => {
          clearTimeout(timer);
          resolve(l);
        });
        p.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`wait-click 进程退出 (${code})`));
        });
      });
      const res = JSON.parse(line);
      if (res.ok) return res.result;
      throw new Error(res.error ?? "wait-click failed");
    } finally {
      try {
        p.kill();
      } catch {
        /* ignore */
      }
    }
  },
};

function rl2(p: ChildProcess, cb: (line: string) => void): void {
  let buf = "";
  p.stdout!.on("data", (d: Buffer) => {
    buf += d.toString();
    const idx = buf.indexOf("\n");
    if (idx >= 0) cb(buf.slice(0, idx).trim());
  });
}

export const keyboardApi = {
  press: (key: string) => request({ op: "press", key }),
  hotkey: (keys: string[]) => request({ op: "hotkey", keys }),
  type: (text: string) => request({ op: "type", text }, 30_000),
};
