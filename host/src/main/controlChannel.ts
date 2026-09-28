import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { paths } from "./config";
import { appLogPath, logHost } from "./logging";
import * as registry from "./registry";
import * as manager from "./runtime/manager";
import * as state from "./state";
import * as history from "./history";
import { setEnabledAndReconcile } from "./appManagement";
import * as windows from "./services/windows";
import { patchHostSettings } from "./settingsCommit";

/**
 * Local control channel for the `mini` CLI: 127.0.0.1 + random port,
 * bearer token. The CLI discovers it via data/runtime.json.
 */

let server: http.Server | null = null;
let port = 0;
const token = crypto.randomBytes(24).toString("hex");

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.setTimeout(180_000, () => reject(new Error("请求超时")));
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new Error("请求体超过 1 MiB")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function appToApi(e: registry.RegistryEntry) {
  if (registry.isBroken(e)) {
    return { id: e.id, name: e.id, path: e.dir, status: "broken", enabled: false, favorite: false, error: e.error, permissions: [], commands: [], hotkeys: [], manifestIssues: [] };
  }
  const run = manager.status(e.id);
  const runInfo = manager.listStatuses()[e.id];
  return {
    id: e.id,
    name: e.name,
    version: e.version,
    enabled: e.enabled,
    favorite: e.favorite,
    lastUsedAt: e.lastUsedAt,
    useCount: e.useCount,
    path: e.path,
    uiType: e.manifest.ui.type,
    status: run,
    startedAt: run === "running" ? runInfo?.startedAt : undefined,
    pid: run === "running" ? runInfo?.pid : undefined,
    manifestIssues: e.manifestIssues,
    commands: e.manifest.commands,
    hotkeys: e.hotkeys,
    permissions: e.manifest.permissions,
  };
}

function page(url: URL): { cursor: number; limit: number } {
  const cursor = Number(url.searchParams.get("cursor") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? 50);
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("分页参数无效 (limit 1..100)");
  return { cursor, limit };
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/ping") {
    return json(res, 200, { ok: true, name: "mini-host", pid: process.pid });
  }

  if (url.pathname === "/settings") {
    if (req.method === "GET") return json(res, 200, { ok: true, data: state.settings() });
    if (req.method === "PATCH") {
      await patchHostSettings(await readBody(req));
      return json(res, 200, { ok: true, data: state.settings() });
    }
  }
  if (req.method === "GET" && url.pathname === "/history") {
    return json(res, 200, { ok: true, data: history.query(undefined, page(url).cursor, page(url).limit) });
  }

  if (req.method === "GET" && url.pathname === "/apps") {
    return json(res, 200, {
      ok: true,
      apps: registry.list().map(appToApi),
      statuses: manager.listStatuses(),
    });
  }

  if (parts[0] === "apps" && parts.length >= 2) {
    const id = parts[1];
    if (!state.validId(id) || !registry.list().some((e) => e.id === id)) return json(res, 404, { ok: false, code: "NOT_FOUND", error: `未知 App: ${id}` });
    const action = parts[2] ?? "";
    if (req.method === "GET" && parts.length === 3 && action === "history") {
      const { cursor, limit } = page(url);
      return json(res, 200, { ok: true, data: history.query(id, cursor, limit) });
    }
    if (req.method === "GET" && parts.length === 3 && action === "logs") {
      const { cursor, limit } = page(url);
      const file = appLogPath(id);
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      const start = Math.max(0, size - 256 * 1024);
      const fd = size ? fs.openSync(file, "r") : undefined;
      let text = "";
      if (fd !== undefined) {
        try { const buf = Buffer.alloc(size - start); fs.readSync(fd, buf, 0, buf.length, start); text = buf.toString("utf8"); }
        finally { fs.closeSync(fd); }
      }
      const lines = text.split(/\r?\n/).filter(Boolean).slice(start ? 1 : 0).reverse();
      return json(res, 200, { ok: true, data: { lines: lines.slice(cursor, cursor + limit).map((line) => line.slice(0, 2048)), nextCursor: cursor + limit < lines.length ? cursor + limit : null, truncated: start > 0 } });
    }
    if (req.method === "GET" && parts.length === 2) {
      const entry = registry.list().find((e) => e.id === id);
      if (!entry) return json(res, 404, { ok: false, code: "NOT_FOUND", error: `未知 App: ${id}` });
      return json(res, 200, { ok: true, app: appToApi(entry) });
    }
    if (req.method !== "POST") return json(res, 405, { ok: false, code: "INVALID_ARGUMENT", error: "method not allowed" });
    const found = registry.list().find((e) => e.id === id)!;
    if (registry.isBroken(found)) return json(res, 409, { ok: false, code: "BROKEN_MANIFEST", error: found.error });
    if (!found.enabled && ["start", "reload", "invoke"].includes(action)) return json(res, 409, { ok: false, code: "APP_DISABLED", error: `App ${id} 已禁用` });
    if (!["start", "stop", "reload", "focus", "enable", "disable", "favorite", "unfavorite", "invoke"].includes(action)) return json(res, 400, { ok: false, code: "INVALID_ARGUMENT", error: `未知动作: ${action}` });
    switch (action) {
      case "focus": {
        if (manager.status(id) !== "running") return json(res, 409, { ok: false, code: "INVALID_ARGUMENT", error: `App ${id} 未在运行,无需唤起` });
        const focused = windows.focusApp(id);
        if (!focused && found.manifest.ui.type !== "none") windows.createAppWindow(found);
        else if (!focused) return json(res, 409, { ok: false, code: "INVALID_ARGUMENT", error: `App ${id} 没有可唤起的窗口` });
        return json(res, 200, { ok: true, data: appToApi(registry.get(id)!) });
      }
      case "start": {
        await manager.start(id);
        return json(res, 200, { ok: true, data: appToApi(registry.get(id)!) });
      }
      case "stop": {
        await manager.stop(id);
        return json(res, 200, { ok: true, data: appToApi(registry.get(id)!) });
      }
      case "reload": {
        await manager.reload(id);
        return json(res, 200, { ok: true, data: appToApi(registry.get(id)!) });
      }
      case "enable":
        await setEnabledAndReconcile(id, true);
        return json(res, 200, { ok: true, data: appToApi(registry.get(id)!) });
      case "disable":
        await setEnabledAndReconcile(id, false);
        return json(res, 200, { ok: true, data: appToApi(registry.get(id)!) });
      case "favorite":
      case "unfavorite":
        if (!registry.setFavorite(id, action === "favorite")) throw new Error("PERSISTENCE_FAILED: 收藏未保存");
        return json(res, 200, { ok: true, data: appToApi(registry.list().find((e) => e.id === id)!) });
      case "invoke": {
        const body = await readBody(req);
        if (!body || typeof body.command !== "string" || body.command.length > 80 || !body.command || !registry.get(id)?.manifest.commands.some((c) => c.id === body.command)) throw new Error("INVALID_ARGUMENT: 未知或无效命令");
        const result = await manager.invoke(id, body.command, body.args);
        return json(res, 200, { ok: true, data: { result: result ?? null }, result: result ?? null });
      }
    }
  }

  if (parts[0] === "host" && req.method === "POST" && parts[1] === "shutdown") {
    json(res, 200, { ok: true });
    logHost("info", "shutdown requested via control channel");
    setTimeout(() => {
      const { app } = require("electron") as typeof import("electron");
      app.quit();
    }, 100);
    return;
  }

  json(res, 404, { ok: false, code: "NOT_FOUND", error: `not found: ${req.method} ${url.pathname}` });
}

export async function startControlChannel(): Promise<void> {
  server = http.createServer((req, res) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, code: "FORBIDDEN", error: "unauthorized" }));
      return;
    }
    handle(req, res).catch((e: any) => {
      logHost("error", `control channel error: ${e?.stack ?? e}`);
      if (!res.headersSent) {
        const message = String(e?.message ?? e);
        const code = /^(BROKEN_MANIFEST|APP_DISABLED|APP_BUSY|PERSISTENCE_FAILED|INVALID_ARGUMENT|NOT_FOUND):/.exec(message)?.[1] ?? "INVALID_ARGUMENT";
        json(res, code === "NOT_FOUND" ? 404 : code === "PERSISTENCE_FAILED" ? 500 : code === "INVALID_ARGUMENT" ? 400 : 409, { ok: false, code, error: message });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as { port: number }).port;

  fs.writeFileSync(
    paths.runtimeFile,
    JSON.stringify({ port, token, pid: process.pid, startedAt: Date.now() }, null, 2),
    { mode: 0o600 },
  );
  logHost("info", `control channel listening on 127.0.0.1:${port}`);
}

export function shutdownControlChannel(): void {
  try {
    server?.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(paths.runtimeFile, { force: true });
  } catch {
    /* ignore */
  }
}
