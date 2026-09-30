// runner util 动作：纯计算与只读 IO，不经 @mini/sdk——「凡改变世界或读
// 屏幕的走 host.*，纯计算的走 runner util」（design.md 词表分界）。
// fs.list 用 Node fs（只读）、http 用 Node fetch。全部 reading 类
// （dry-run 照真执行），例外见各动作注释。

import fsp from "node:fs/promises";
import path from "node:path";
import type { ActionTable } from "../engine/types";

function reqStr(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string") throw new Error(`参数 ${name} 必须是字符串`);
  return v;
}

/** 简化 glob：`*` 任意字符序列、`?` 单字符，其余按字面量；不区分大小写（Windows） */
export function globToRegExp(pattern: string): RegExp {
  const re = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" || ch === "?" ? ch : `\\${ch}`))
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${re}$`, "i");
}

export interface FileEntry {
  /** 正斜杠形式（windows-pitfalls：落 JSON/state 的路径一律正斜杠） */
  path: string;
  name: string;
  stem: string;
  ext: string;
  size: number;
  mtimeMs: number;
}

export function buildUtilActions(): ActionTable {
  return {
    // ---- fs.list：目录顶层文件清单（只读；不含子目录，递归遍历是 v1 候选）----
    "fs.list": {
      category: "reading",
      run: async (args) => {
        const dir = reqStr(args, "dir");
        const filter = typeof args.filter === "string" && args.filter !== "" ? globToRegExp(args.filter) : null;
        const dirents = await fsp.readdir(dir, { withFileTypes: true });
        const entries: FileEntry[] = [];
        for (const d of dirents) {
          if (!d.isFile()) continue;
          if (filter && !filter.test(d.name)) continue;
          const full = path.join(dir, d.name);
          try {
            const st = await fsp.stat(full);
            entries.push({
              path: full.split(path.sep).join("/"),
              name: d.name,
              stem: path.basename(d.name, path.extname(d.name)),
              ext: path.extname(d.name),
              size: st.size,
              mtimeMs: st.mtimeMs,
            });
          } catch {
            // readdir 与 stat 之间文件消失：跳过（file-organizer 同口径）
          }
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return entries;
      },
    },

    // ---- text 变换 ----
    "text.match": {
      category: "reading",
      run: async (args) => {
        const text = reqStr(args, "text");
        const pattern = reqStr(args, "pattern");
        const flags = typeof args.flags === "string" ? args.flags : "";
        if (args.all === true) {
          const g = flags.includes("g") ? flags : `${flags}g`;
          return [...text.matchAll(new RegExp(pattern, g))].map((m) => m[0]);
        }
        return text.match(new RegExp(pattern, flags))?.[0] ?? null;
      },
    },
    "text.replace": {
      category: "reading",
      run: async (args) => {
        const text = reqStr(args, "text");
        const flags = typeof args.flags === "string" ? args.flags : "g";
        // replacement 保持 JS 语义：$1 等反向引用可用
        return text.replace(new RegExp(reqStr(args, "pattern"), flags), reqStr(args, "replacement"));
      },
    },

    // ---- json ----
    "json.parse": {
      category: "reading",
      run: async (args) => JSON.parse(reqStr(args, "text")),
    },

    // ---- http.request：Node fetch，超时透传 ----
    "http.request": {
      category: "reading",
      run: async (args, ctx) => {
        const url = reqStr(args, "url");
        const method = typeof args.method === "string" && args.method !== "" ? args.method.toUpperCase() : "GET";
        const timeoutMs = typeof args.timeoutMs === "number" && args.timeoutMs > 0 ? args.timeoutMs : 30_000;
        const headers: Record<string, string> = {};
        if (args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)) {
          for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) {
            if (v !== null && v !== undefined) headers[k] = String(v);
          }
        }
        // AbortSignal.any：取消/步骤超时（ctx.signal）与请求超时取先到者
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
        const init: RequestInit = { method, headers, signal };
        if (args.body !== undefined && args.body !== null) {
          init.body = typeof args.body === "string" ? args.body : JSON.stringify(args.body);
        }
        const res = await fetch(url, init);
        const body = await res.text();
        return {
          status: res.status,
          ok: res.ok,
          headers: Object.fromEntries(res.headers),
          body,
        };
      },
    },

    // ---- delay：计时计入 run 总超时（design FAQ），故不设独立动作超时——
    // 上限 = 剩余 run 预算（engine 取 min 后超时报「run 总超时」而非步骤超时）----
    "delay": {
      category: "reading",
      timeoutMs: Number.MAX_SAFE_INTEGER,
      run: (args, ctx) => new Promise<void>((resolve, reject) => {
        const ms = args.ms;
        if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
          reject(new Error("参数 ms 必须是非负数字"));
          return;
        }
        const onAbort = () => { cleanup(); reject(new Error("已取消")); };
        const cleanup = () => {
          clearTimeout(timer);
          ctx.signal?.removeEventListener("abort", onAbort);
        };
        const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
        if (ctx.signal?.aborted) { cleanup(); reject(new Error("已取消")); return; }
        ctx.signal?.addEventListener("abort", onAbort, { once: true });
      }),
    },

    // ---- js.eval：内联 JS，上下文同表达式（params/steps/env/循环变量）。
    // 逃生舱而非主路径（design）；async 包装允许表达式位的 await 与
    // Promise.all——「并发取 10 个 URL」是单个动作内部的事 ----
    "js.eval": {
      category: "reading",
      run: async (args, ctx) => {
        const code = reqStr(args, "code");
        const scope = ctx.scope;
        if (!scope) throw new Error("js.eval 缺少求值上下文（须由 engine 注入 scope）");
        const names = ["params", "steps", "env", ...Object.keys(scope.vars)];
        const values = [scope.params, scope.steps, scope.env, ...Object.values(scope.vars)];
        const fn = new Function(...names, `"use strict"; return (async () => (${code}))();`);
        return fn(...values);
      },
    },
  };
}
