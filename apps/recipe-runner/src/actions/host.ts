// host.* 直通动作：recipe 词表里的桌面能力全部转发 @mini/sdk。
//
// 边界纪律：engine 不认识 host——这里把 SDK 方法包成 ActionTable 注入
// interp；host 形参签名以 sdk/src/index.ts 为准（spec: sdk/backend/api-surface.md）。
// 依赖以参数注入（缺省真 SDK），单测用 fake host 走同一条路径。
//
// dry-run 分类对照 design.md 语义表：
//   mutating    files.write/copy/move/remove、clipboard.writeText、mouse.move/click/doubleClick、
//               keyboard.press/hotkey/type、process.run（改变世界 / 注入输入）
//   reading     files.read、clipboard.readText、screen.capture/captureRegion/getMonitors、
//               mouse.position、log（照真执行，无副作用风险）
//   interactive files.selectFile/selectDirectory、screen.selectRegion——阻塞等用户操作，
//               走 ui 类 120s 超时（design 语义表把 screen 归 real，此处按「等用户」拆出）
//   notify      notification.show（dry-run 下 engine 统一加 [dry-run] 前缀）

import { host } from "@mini/sdk";
import type { ActionTable } from "../engine/types";

/** 结构化注入面：typeof host 的可用子集（测试 fake 只需实现用到的部分） */
export type HostDeps = typeof host;

/** 必填字符串参数在动作边界拒绝（脏参数不进 host 服务） */
function reqStr(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || v === "") throw new Error(`参数 ${name} 必须是非空字符串`);
  return v;
}

function optStr(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  return typeof v === "string" ? v : undefined;
}

export function buildHostActions(h: HostDeps = host): ActionTable {
  return {
    // ---- clipboard ----
    "clipboard.readText": {
      category: "reading",
      run: async () => h.clipboard.readText(),
    },
    "clipboard.writeText": {
      category: "mutating",
      run: async (args) => h.clipboard.writeText(reqStr(args, "text")),
    },

    // ---- files（host 侧无覆盖语义：目标存在即失败）----
    "files.read": {
      category: "reading",
      run: async (args) => h.files.read(reqStr(args, "path")),
    },
    "files.write": {
      category: "mutating",
      run: async (args) => h.files.write(reqStr(args, "path"), typeof args.data === "string" ? args.data : String(args.data ?? "")),
    },
    "files.copy": {
      category: "mutating",
      run: async (args) => h.files.copy(reqStr(args, "from"), reqStr(args, "to")),
    },
    "files.move": {
      category: "mutating",
      run: async (args) => h.files.move(reqStr(args, "from"), reqStr(args, "to")),
    },
    "files.remove": {
      category: "mutating",
      run: async (args) => h.files.remove(reqStr(args, "path")),
    },
    // 文件/目录选择是模态对话框：等用户，取消返回 null（不是错误——
    // recipe 可用 when 判空走「没选」分支，与 ui.* 的「取消即停」区分）
    "files.selectFile": {
      category: "interactive",
      run: async () => h.files.selectFile(),
    },
    "files.selectDirectory": {
      category: "interactive",
      run: async () => h.files.selectDirectory(),
    },

    // ---- screen（对外全部物理像素）----
    "screen.capture": {
      category: "reading",
      run: async () => h.screen.capture(),
    },
    "screen.captureRegion": {
      category: "reading",
      run: async (args) => {
        const rect = args.rect;
        if (rect === null || typeof rect !== "object") throw new Error("参数 rect 必须是 {x,y,width,height}");
        const r = rect as Record<string, unknown>;
        for (const k of ["x", "y", "width", "height"] as const) {
          if (typeof r[k] !== "number") throw new Error(`参数 rect.${k} 必须是数字`);
        }
        return h.screen.captureRegion(r as unknown as { x: number; y: number; width: number; height: number });
      },
    },
    // 系统截图工具选区：阻塞等用户框选（Esc 取消 → null，同 selectFile 口径）
    "screen.selectRegion": {
      category: "interactive",
      run: async () => h.screen.selectRegion(),
    },
    "screen.getMonitors": {
      category: "reading",
      run: async () => h.screen.getMonitors(),
    },

    // ---- mouse / keyboard ----
    "mouse.position": {
      category: "reading",
      run: async () => h.mouse.position(),
    },
    "mouse.move": {
      category: "mutating",
      run: async (args) => h.mouse.move(reqNum(args, "x"), reqNum(args, "y")),
    },
    "mouse.click": {
      category: "mutating",
      run: async (args) => {
        const button = args.button === "right" ? "right" : "left";
        return h.mouse.click(reqNum(args, "x"), reqNum(args, "y"), button);
      },
    },
    "mouse.doubleClick": {
      category: "mutating",
      run: async (args) => h.mouse.doubleClick(reqNum(args, "x"), reqNum(args, "y")),
    },
    "keyboard.press": {
      category: "mutating",
      run: async (args) => h.keyboard.press(reqStr(args, "key")),
    },
    "keyboard.hotkey": {
      category: "mutating",
      run: async (args) => {
        const keys = args.keys;
        if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => typeof k === "string")) {
          throw new Error("参数 keys 必须是非空字符串数组（如 [\"ctrl\", \"c\"]）");
        }
        return h.keyboard.hotkey(keys as string[]);
      },
    },
    "keyboard.type": {
      category: "mutating",
      run: async (args) => h.keyboard.type(reqStr(args, "text")),
    },

    // ---- notification / log ----
    "notification.show": {
      category: "notify",
      run: async (args) => h.notification.show({
        title: reqStr(args, "title"),
        ...(optStr(args, "body") !== undefined ? { body: optStr(args, "body") } : {}),
        ...(optStr(args, "clickCommand") !== undefined ? { clickCommand: optStr(args, "clickCommand") } : {}),
      }),
    },
    "log": {
      category: "reading",
      run: async (args) => {
        const m = reqStr(args, "msg");
        const level = args.level;
        if (level === "warn") return h.log.warn(m);
        if (level === "error") return h.log.error(m);
        return h.log.info(m);
      },
    },

    // ---- process.run：spawn + 阻塞至退出码 + stdout/stderr 行收集 ----
    // out = { exitCode, stdout, stderr }。非零退出码不是错误（recipe 用
    // when: steps.<id>.exitCode 自行分支），命令不存在/无法 spawn 才报错。
    // timeoutMs 交给 run 剩余预算（engine min() 兜底）：子进程不该有独立于
    // run 总超时的第二时钟。
    "process.run": {
      category: "mutating",
      timeoutMs: Number.MAX_SAFE_INTEGER,
      run: async (args, ctx) => {
        const command = reqStr(args, "command");
        const argv = Array.isArray(args.args)
          ? args.args.map((a) => (typeof a === "string" ? a : String(a)))
          : undefined;
        const cwd = optStr(args, "cwd");
        const env: Record<string, string> | undefined = args.env && typeof args.env === "object" && !Array.isArray(args.env)
          ? Object.fromEntries(Object.entries(args.env as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)]))
          : undefined;

        const handle = await h.process.spawn({
          command,
          ...(argv !== undefined ? { args: argv } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          ...(env !== undefined ? { env } : {}),
        });

        const stdout: string[] = [];
        const stderr: string[] = [];
        const offOut = handle.stdout((line) => stdout.push(line));
        const offErr = handle.stderr((line) => stderr.push(line));

        // 取消/步骤超时 → 杀子进程并让动作以「已取消」拒绝（engine 归因 cancelled）
        let onAbort: (() => void) | null = null;
        const abortWait = ctx.signal
          ? new Promise<never>((_, reject) => {
            onAbort = () => { void handle.kill().catch(() => {}); reject(new Error("已取消")); };
            ctx.signal!.addEventListener("abort", onAbort, { once: true });
          })
          : null;
        try {
          const exitCode = abortWait
            ? await Promise.race([handle.wait(), abortWait])
            : await handle.wait();
          return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
        } finally {
          offOut();
          offErr();
          if (onAbort && ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
        }
      },
    },
  };
}

function reqNum(args: Record<string, unknown>, name: string): number {
  const v = args[name];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`参数 ${name} 必须是有限数字`);
  return v;
}
