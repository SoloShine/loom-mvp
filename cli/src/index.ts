import fs from "node:fs";
import path from "node:path";
import { parseManifest, type Manifest } from "../../host/src/main/manifest";
import { api, appsDir, dataDir, ensureHost, ping, repoRoot } from "./client";
import { buildApp, needsBuild } from "./build";
import { createApp, type UiType } from "./create";

const HELP = `mini — Personal Mini App Host CLI

  mini host [--shutdown]        启动 Host(已运行则跳过);--shutdown 关闭
  mini create <name> [--ui none|window|floating|overlay]
  mini list                     列出 App(优先读运行中的 Host)
  mini validate <id>            校验 app.yaml 与产物(不依赖 Host)
  mini build <id>               构建 App(esbuild)
  mini run <id>                 构建(如需要)并启动
  mini dev <id>                 watch + 自动 reload
  mini reload <id> / stop <id>
  mini invoke <id> <command> [--args '<json>']
  mini logs <id> [--follow]
  mini settings get|set <key> <value>
  mini info|enable|disable|favorite|unfavorite <id>
  mini history [id]
  mini status                   Host 状态
`;

const DIE = Symbol.for("mini-cli-die");

function die(msg: string): never {
  console.error(`错误: ${msg}`);
  throw DIE;
}

function argFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function appDirOf(id: string): string {
  const dir = path.join(appsDir(), id);
  if (!fs.existsSync(dir)) die(`未找到 App 目录: ${dir}`);
  return dir;
}

function capabilityOfSource(source: string): string[] {
  const found = new Set<string>();
  const re = /host\.([A-Za-z]+)\./g;
  for (const match of source.matchAll(re)) found.add(match[1].toLowerCase());
  return [...found];
}

function declaredCapabilities(m: Manifest): string[] {
  return (m?.permissions ?? []).map((p: string) => p.split(/[.:]/, 1)[0].toLowerCase());
}

function localScan(): { id: string; name: string; ok: boolean; error?: string; capabilities?: string[] }[] {
  const out: { id: string; name: string; ok: boolean; error?: string; capabilities?: string[] }[] = [];
  if (!fs.existsSync(appsDir())) return out;
  for (const d of fs.readdirSync(appsDir(), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(appsDir(), d.name);
    const yamlPath = path.join(dir, "app.yaml");
    if (!fs.existsSync(yamlPath)) {
      out.push({ id: d.name, name: d.name, ok: false, error: "缺少 app.yaml" });
      continue;
    }
    const parsed = parseManifest(fs.readFileSync(yamlPath, "utf8"), d.name);
    if (!parsed.ok) {
      out.push({ id: d.name, name: d.name, ok: false, error: parsed.errors.join("; ") });
    } else {
      const sourceFiles = fs.existsSync(path.join(dir, "src"))
        ? fs.readdirSync(path.join(dir, "src")).filter((name) => name.endsWith(".ts")).map((name) => fs.readFileSync(path.join(dir, "src", name), "utf8")).join("\n")
        : "";
      const used = capabilityOfSource(sourceFiles);
      const declared = declaredCapabilities(parsed.manifest!);
      const missing = used.filter((cap) => !["app", "ui", "log", "window"].includes(cap) && !declared.includes(cap));
      out.push({ id: parsed.manifest!.id, name: parsed.manifest!.name, ok: true, capabilities: used, error: missing.length ? `能力声明提示: ${missing.join(", ")}` : undefined });
    }
  }
  return out;
}

async function cmdHost(args: string[]): Promise<void> {
  if (args.includes("--shutdown")) {
    if (await ping()) {
      await api.shutdown();
      console.log("Host 已请求关闭");
    } else {
      console.log("Host 未运行");
    }
    return;
  }
  if (await ping()) {
    console.log("Host 已在运行");
    return;
  }
  await ensureHost();
  console.log("Host 已启动");
}

async function cmdList(): Promise<void> {
  if (await ping()) {
    const { apps } = await api.apps();
    for (const a of apps) {
      const flags = [
        a.status,
        a.status === "broken" ? "" : a.enabled ? "enabled" : "disabled",
        ...(a.favorite ? ["favorite"] : []),
        ...(a.manifestIssues ?? []),
      ].filter(Boolean);
      console.log(`${a.id.padEnd(20)} ${a.name.padEnd(24)} ${flags.join(", ")}`);
      if (a.error) console.log(`  └ error: ${a.error}`);
      if (a.commands?.length) console.log(`  └ commands: ${a.commands.map((c: any) => c.id).join(", ")}`);
    }
  } else {
    console.log("(Host 未运行,以下为本地扫描)\n");
    for (const a of localScan()) {
      console.log(`${a.id.padEnd(20)} ${a.name.padEnd(24)} ${a.ok ? "ok" : "broken"}${a.error ? `: ${a.error}` : ""}`);
      if (a.capabilities?.length) console.log(`  └ capabilities: ${a.capabilities.join(", ")}`);
    }
  }
}

async function cmdValidate(id: string): Promise<void> {
  const dir = appDirOf(id);
  const yamlPath = path.join(dir, "app.yaml");
  if (!fs.existsSync(yamlPath)) die("缺少 app.yaml");
  const parsed = parseManifest(fs.readFileSync(yamlPath, "utf8"), path.basename(dir));
  if (!parsed.ok) {
    for (const e of parsed.errors) console.error(`✗ ${e}`);
    process.exit(1);
  }
  const m = parsed.manifest!;
  const issues: string[] = [];
  if (!fs.existsSync(path.join(dir, m.entry))) issues.push(`entry 不存在: ${m.entry}`);
  const sourceFiles = fs.existsSync(path.join(dir, "src"))
    ? fs.readdirSync(path.join(dir, "src")).filter((name) => name.endsWith(".ts")).map((name) => fs.readFileSync(path.join(dir, "src", name), "utf8")).join("\n")
    : "";
  const used = capabilityOfSource(sourceFiles);
  const declared = declaredCapabilities(m);
  const missingCapabilities = used.filter((cap) => !["app", "ui", "log", "window"].includes(cap) && !declared.includes(cap));
  if (missingCapabilities.length > 0) console.warn(`⚠ ${id}: 能力声明提示(不阻止运行): ${missingCapabilities.join(", ")}`);
  if (m.entry.endsWith(".ts") && !fs.existsSync(path.join(dir, "dist", "main.js"))) {
    issues.push("缺少 dist/main.js(先 mini build)");
  }
  if (m.ui.type !== "none" && !fs.existsSync(path.join(dir, "src", "ui.ts"))) {
    issues.push(`ui.type=${m.ui.type} 但缺少 src/ui.ts`);
  }
  if (m.ui.type !== "none" && !fs.existsSync(path.join(dir, "dist", "ui.js"))) {
    issues.push("缺少 dist/ui.js(先 mini build)");
  }
  if (issues.length > 0) {
    for (const i of issues) console.error(`✗ ${i}`);
    process.exit(1);
  }
  console.log(`✓ ${id}: manifest 与产物检查通过(${m.commands.length} commands, ${Object.keys(m.hotkeys).length} hotkeys)`);
}

async function cmdRun(id: string): Promise<void> {
  const dir = appDirOf(id);
  const t0 = Date.now();
  if (needsBuild(dir)) await buildApp(dir);
  console.log(`build ok (${Date.now() - t0}ms)`);
  await ensureHost();
  try {
    const { app } = await api.app(id);
    if (app.status === "broken") die(`BROKEN_MANIFEST: ${app.error ?? id}`);
    if (!app.enabled) die(`APP_DISABLED: App ${id} 已禁用`);
    if (app.status && app.status !== "stopped") {
      await api.reload(id);
      console.log(`${id} 已重载并启动`);
      return;
    }
  } catch (e: any) {
    if (!String(e?.message ?? e).startsWith("NOT_FOUND:")) throw e;
  }
  await api.start(id);
  console.log(`${id} 已启动`);
}

async function cmdDev(id: string): Promise<void> {
  const dir = appDirOf(id);
  await buildApp(dir);
  await ensureHost();
  await api.start(id);
  console.log(`dev 模式: watching ${path.relative(repoRoot(), dir)}(Ctrl+C 退出,App 继续运行)`);
  const yamlPath = path.join(dir, "app.yaml");
  if (fs.existsSync(yamlPath)) {
    const parsed = parseManifest(fs.readFileSync(yamlPath, "utf8"), path.basename(dir));
    if (parsed.manifest?.ui.devUrl) {
      console.log(`dev 提示: ui.devUrl=${parsed.manifest.ui.devUrl}(dev server 未起时窗口回退产物;起/停后重开窗口切换)`);
    }
  }

  let timer: NodeJS.Timeout | null = null;
  const rebuild = (file: string) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      const t = Date.now();
      try {
        await buildApp(dir);
        await api.reload(id);
        console.log(`[dev] rebuilt & reloaded (${Date.now() - t}ms) ← ${file}`);
      } catch (e: any) {
        console.error(`[dev] build failed: ${e?.message ?? e}(保留旧产物运行)`);
      }
    }, 200);
  };

  const srcDir = path.join(dir, "src");
  fs.watch(srcDir, { recursive: true }, (_e, file) => rebuild(file ?? ""));
  fs.watch(path.join(dir, "app.yaml"), () => rebuild("app.yaml"));

  // keep alive
  await new Promise(() => {});
}

async function cmdInvoke(args: string[]): Promise<void> {
  const [id, command] = args;
  if (!id || !command) die("用法: mini invoke <id> <command> [--args '<json>']");
  const argsJson = argFlag(args, "--args");
  let parsedArgs: unknown = {};
  if (argsJson) {
    try {
      parsedArgs = JSON.parse(argsJson);
    } catch {
      die("--args 不是合法 JSON");
    }
  }
  await ensureHost();
  const { result } = await api.invoke(id, command, parsedArgs);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdLogs(id: string, follow: boolean): Promise<void> {
  const file = path.join(dataDir(), "logs", "apps", `${id}.log`);
  if (!fs.existsSync(file)) {
    console.log(`(暂无日志: ${file})`);
    return;
  }
  let identity = fs.statSync(file).ino;
  let size = fs.statSync(file).size;
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  for (const l of lines.slice(Math.max(0, lines.length - 51), lines.length - 1)) console.log(l);

  if (!follow) return;
  console.log("--- following (Ctrl+C 退出) ---");
  setInterval(() => {
    try {
      const stat = fs.statSync(file);
      if (stat.ino !== identity || stat.size < size) {
        identity = stat.ino;
        size = 0;
      }
      if (stat.size > size) {
        const fd = fs.openSync(file, "r");
        const buf = Buffer.alloc(stat.size - size);
        fs.readSync(fd, buf, 0, buf.length, size);
        fs.closeSync(fd);
        size = stat.size;
        process.stdout.write(buf.toString("utf8"));
      }
    } catch {
      // rotation can briefly hide the path; retry on the next tick
    }
  }, 400);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case undefined:
      case "help":
      case "--help":
        console.log(HELP);
        return;
      case "host":
        return await cmdHost(rest);
      case "create": {
        const name = rest.find((a) => !a.startsWith("--"));
        if (!name) die("用法: mini create <name> [--ui window]");
        const ui = (argFlag(rest, "--ui") ?? "none") as UiType;
        const dir = createApp(name, ui);
        console.log(`已创建 ${path.relative(process.cwd(), dir)}\n下一步: mini run ${name}`);
        return;
      }
      case "list":
        return await cmdList();
      case "validate": {
        const id = rest[0];
        if (!id) die("用法: mini validate <id>");
        return await cmdValidate(id);
      }
      case "build": {
        const id = rest[0];
        if (!id) die("用法: mini build <id>");
        const t0 = Date.now();
        const { uiBuilt } = await buildApp(appDirOf(id));
        console.log(`build ok (${Date.now() - t0}ms${uiBuilt ? ", 含 ui" : ""})`);
        return;
      }
      case "run": {
        const id = rest[0];
        if (!id) die("用法: mini run <id>");
        return await cmdRun(id);
      }
      case "dev": {
        const id = rest[0];
        if (!id) die("用法: mini dev <id>");
        return await cmdDev(id);
      }
      case "stop": {
        const id = rest[0];
        if (!id) die("用法: mini stop <id>");
        await ensureHost();
        await api.stop(id);
        console.log(`${id} 已停止`);
        return;
      }
      case "reload": {
        const id = rest[0];
        if (!id) die("用法: mini reload <id>");
        const dir = appDirOf(id);
        if (needsBuild(dir)) await buildApp(dir); // never reload stale dist
        await ensureHost();
        await api.reload(id);
        console.log(`${id} 已重载`);
        return;
      }
      case "invoke":
        return await cmdInvoke(rest);
      case "logs": {
        const id = rest[0];
        if (!id) die("用法: mini logs <id> [--follow]");
        return await cmdLogs(id, rest.includes("--follow"));
      }
      case "info": {
        if (!rest[0]) die("用法: mini info <id>");
        await ensureHost();
        console.log(JSON.stringify((await api.app(rest[0])).app, null, 2));
        return;
      }
      case "enable":
      case "disable":
      case "favorite":
      case "unfavorite": {
        if (!rest[0]) die(`用法: mini ${cmd} <id>`);
        await ensureHost();
        if (cmd === "enable") await api.enable(rest[0]);
        else if (cmd === "disable") await api.disable(rest[0]);
        else await api.favorite(rest[0], cmd === "favorite");
        console.log(`${rest[0]}: ${cmd} ok`);
        return;
      }
      case "settings": {
        await ensureHost();
        if (rest[0] === "get") { console.log(JSON.stringify((await api.settings()).data, null, 2)); return; }
        if (rest[0] === "set" && rest[1] && rest[2]) {
          const value = rest[1] === "launcherHotkey" ? rest[2] : Number(rest[2]);
          console.log(JSON.stringify((await api.patchSettings({ [rest[1]]: value })).data, null, 2));
          return;
        }
        die("用法: mini settings get|set <key> <value>");
      }
      case "history": {
        await ensureHost();
        console.log(JSON.stringify((await api.history(rest[0])).data, null, 2));
        return;
      }
      case "status": {
        if (!(await ping())) {
          console.log("Host 未运行");
          process.exit(2);
        }
        const { apps } = await api.apps();
        console.log(`Host 运行中,${apps.length} 个 App:`);
        for (const a of apps) {
          console.log(`  ${a.id.padEnd(20)} ${a.status.padEnd(10)} ${a.status === "broken" ? `(清单损坏: ${a.error ?? "未知错误"})` : a.enabled ? "(enabled)" : "(disabled)"}${a.commands?.length ? ` commands: ${a.commands.map((c: any) => c.id).join(", ")}` : ""}`);
        }
        return;
      }
      default:
        die(`未知命令: ${cmd}\n${HELP}`);
    }
  } catch (e) {
    if (e !== DIE) {
      console.error(`错误: ${(e as any)?.message ?? String(e)}`);
    }
    process.exitCode = 1;
  }
}

// No process.exit() on error paths: exiting with live undici sockets trips
// a libuv assertion on Windows (exit 127). Let the process drain instead.
main().catch((e) => {
  if (e !== DIE) console.error(String((e as any)?.stack ?? e));
  process.exitCode = 1;
});
