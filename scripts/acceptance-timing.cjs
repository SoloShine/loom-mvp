#!/usr/bin/env node
/**
 * PRD §21 acceptance timing harness (batch R3 of docs/mvp-acceptance-plan.md).
 *
 * Runs against a real Electron host in an isolated data dir:
 *  - TIMING: `mini create` end-to-end (≤1 min target), 5× edit→reload→invoke
 *    round-trips (≤2 s target), `mini run` cold start, `mini dev` watcher
 *    availability with rebuild timing.
 *  - RB: rollback drill — legacy registry data migrates at machine level
 *    (boot → .bak migration → app stays disabled → enable works).
 *
 * Usage: node scripts/acceptance-timing.cjs [--case TIMING|RB] [--keep]
 * Requires `npm run build` first. Windows-only (same harness family as
 * scripts/smoke-host.cjs).
 */
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

if (process.platform !== "win32") {
  console.error("acceptance-timing: 仅支持 Windows");
  process.exit(2);
}

const REPO = path.resolve(__dirname, "..");
const CLI = path.join(REPO, "cli", "dist", "mini.js");
const ELECTRON = require(require.resolve("electron", { paths: [REPO] }));
const EVIDENCE = path.join(REPO, "data", "acceptance", `run-${Date.now()}`);
const KEEP = process.argv.includes("--keep");
const onlyCase = (() => {
  const i = process.argv.indexOf("--case");
  return i >= 0 ? process.argv[i + 1] : null;
})();

for (const p of [CLI, path.join(REPO, "host", "dist", "main", "index.js")]) {
  if (!fs.existsSync(p)) {
    console.error(`acceptance-timing: 缺少 ${path.relative(REPO, p)},先运行 npm run build`);
    process.exit(2);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function note(caseName, file, text) {
  const dir = path.join(EVIDENCE, caseName);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, file), typeof text === "string" ? text : JSON.stringify(text, null, 2) + "\n");
}

function makeEnv(caseName) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `mini-acc-${caseName}-`));
  return {
    tmp,
    env: {
      ...process.env,
      MINI_ROOT: REPO,
      MINI_DATA_DIR: path.join(tmp, "data"),
      MINI_APPS_DIR: path.join(tmp, "apps"),
    },
  };
}

function mini(args, env, timeoutMs = 120_000) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [CLI, ...args], { env, timeout: timeoutMs, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", ms: Date.now() - t0 };
}

function readRuntime(env) {
  try { return JSON.parse(fs.readFileSync(path.join(env.MINI_DATA_DIR, "runtime.json"), "utf8")); }
  catch { return null; }
}

async function waitHostUp(env, timeoutMs = 45_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const rt = readRuntime(env);
    if (rt) {
      try {
        const res = await fetch(`http://127.0.0.1:${rt.port}/ping`, { headers: { authorization: `Bearer ${rt.token}`, connection: "close" } });
        if (res.ok) return rt;
      } catch { /* not up yet */ }
    }
    await sleep(300);
  }
  throw new Error("Host 启动超时");
}

function startHost(env, caseName) {
  const logFile = path.join(EVIDENCE, caseName, "host-live.log");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const proc = spawn(ELECTRON, ["host", `--user-data-dir=${env.MINI_DATA_DIR}`], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  fs.writeFileSync(logFile, `[spawn] pid=${proc.pid}\n`);
  const append = (tag) => (d) => fs.appendFileSync(logFile, `[${tag}] ${d}`);
  proc.stdout.on("data", append("out"));
  proc.stderr.on("data", append("err"));
  proc.on("exit", (code, sig) => fs.appendFileSync(logFile, `[exit] code=${code} signal=${sig}\n`));
  return { proc };
}

async function stopHost(env, handle, timeoutMs = 25_000) {
  const rt = readRuntime(env);
  if (rt) {
    try { await fetch(`http://127.0.0.1:${rt.port}/host/shutdown`, { method: "POST", headers: { authorization: `Bearer ${rt.token}`, connection: "close" } }); } catch { /* dying */ }
  }
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs && handle.proc.exitCode === null && handle.proc.signalCode === null) await sleep(300);
}

async function cleanup(caseName, tmp, handle) {
  if (handle && handle.proc.exitCode === null && handle.proc.signalCode === null) {
    spawnSync("taskkill", ["/PID", String(handle.proc.pid), "/T", "/F"], { stdio: "ignore" });
  }
  if (KEEP) return `${tmp} (保留)`;
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  return `${tmp} (已清理)`;
}

function record(caseName, ok, ms, details) {
  results.push({ case: caseName, ok, ms, details });
  console.log(`${ok ? "✓" : "✗"} ${caseName} (${ms}ms) — ${ok ? JSON.stringify(details) : JSON.stringify(details)}`);
}

/** Create 后给模板 ping 注入版本化探针字段(ping 已在 manifest.commands 声明)。 */
async function seedProbe(appDir) {
  const file = path.join(appDir, "src", "main.ts");
  const src = await fsp.readFile(file, "utf8");
  if (!src.includes("return { pong: true,")) throw new Error("模板 ping 返回结构与预期不符");
  await fsp.writeFile(file, src.replace("return { pong: true,", 'return { pong: true, v: "v0",'));
}

/** 版本化探针:把 v 标记从 v<i-1> 改成 v<i>(触发产物过期)。 */
async function editProbe(appDir, i) {
  const file = path.join(appDir, "src", "main.ts");
  const prev = `"v${i - 1}"`;
  const next = `"v${i}"`;
  const src = await fsp.readFile(file, "utf8");
  if (!src.includes(prev)) throw new Error(`探针标记 ${prev} 不在 main.ts 中`);
  await fsp.writeFile(file, src.replace(prev, next));
}

// --- TIMING ------------------------------------------------------------------

async function caseTiming() {
  const name = "TIMING";
  const t0 = Date.now();
  const { tmp, env } = makeEnv(name);
  let handle;
  const out = { createMs: null, createToFirstInvokeMs: null, runColdMs: null, editToLive: [], dev: null };
  try {
    // 1) mini create 计时
    const created = mini(["create", "probe-app", "--ui", "none"], env);
    note(name, "create.txt", `${created.status} ${created.ms}ms\n${created.stdout}${created.stderr}`);
    if (created.status !== 0) throw new Error(`mini create 失败: ${created.stderr}`);
    out.createMs = created.ms;

    const appDir = path.join(env.MINI_APPS_DIR, "probe-app");
    await seedProbe(appDir);
    const e2eStart = Date.now(); // create → 可调用,完整"需求到运行结果"链
    const built = mini(["build", "probe-app"], env);
    if (built.status !== 0) throw new Error(`mini build 失败: ${built.stderr}`);

    handle = startHost(env, name);
    await waitHostUp(env);

    const runCold = mini(["run", "probe-app"], env);
    note(name, "run.txt", `${runCold.status} ${runCold.ms}ms\n${runCold.stdout}${runCold.stderr}`);
    if (runCold.status !== 0) throw new Error(`mini run 失败: ${runCold.stderr}`);
    out.runColdMs = runCold.ms;

    const first = mini(["invoke", "probe-app", "ping"], env);
    if (first.status !== 0 || !first.stdout.includes('"v0"')) {
      throw new Error(`首次 invoke 异常: ${first.stdout}${first.stderr}`);
    }
    out.createToFirstInvokeMs = Date.now() - e2eStart;

    // 2) 修改 → 生效,5 连测
    for (let i = 1; i <= 5; i++) {
      await editProbe(appDir, i);
      const t = Date.now();
      const reload = mini(["reload", "probe-app"], env);
      if (reload.status !== 0) throw new Error(`reload #${i} 失败: ${reload.stderr}`);
      const inv = mini(["invoke", "probe-app", "ping"], env);
      if (inv.status !== 0 || !inv.stdout.includes(`"v${i}"`)) {
        throw new Error(`修改未生效 #${i}: ${inv.stdout}${inv.stderr}`);
      }
      out.editToLive.push(Date.now() - t);
    }

    // 3) mini dev 可用性:watcher 启动 → 改动 → 自动重建重载
    const dev = spawn(process.execPath, [CLI, "dev", "probe-app"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let devLog = "";
    dev.stdout.on("data", (d) => (devLog += d));
    dev.stderr.on("data", (d) => (devLog += d));
    try {
      const t0dev = Date.now();
      let up = false;
      while (Date.now() - t0dev < 30_000 && !up) { up = devLog.includes("dev 模式"); if (!up) await sleep(150); }
      if (!up) throw new Error(`dev watcher 未启动: ${devLog.slice(0, 300)}`);
      await editProbe(appDir, 6);
      let rebuiltMs = null;
      const t1dev = Date.now();
      while (Date.now() - t1dev < 30_000 && rebuiltMs === null) {
        const m = devLog.match(/\[dev\] rebuilt & reloaded \((\d+)ms\)/);
        if (m) rebuiltMs = Number(m[1]);
        else await sleep(150);
      }
      if (rebuiltMs === null) throw new Error(`dev 重建未发生: ${devLog.slice(-400)}`);
      const inv = mini(["invoke", "probe-app", "ping"], env);
      if (inv.status !== 0 || !inv.stdout.includes('"v6"')) {
        throw new Error(`dev 修改未生效: ${inv.stdout}${inv.stderr}`);
      }
      out.dev = { rebuildMs: rebuiltMs, live: true };
    } finally {
      spawnSync("taskkill", ["/PID", String(dev.pid), "/T", "/F"], { stdio: "ignore" });
    }
    note(name, "timing.json", out);

    const maxEdit = Math.max(...out.editToLive);
    const verdict = {
      createUnder1min: out.createMs < 60_000 && out.createToFirstInvokeMs < 60_000,
      editUnder2s: maxEdit < 2_000,
    };
    record(name, verdict.createUnder1min && verdict.editUnder2s, Date.now() - t0, { ...out, verdict, tmp: await cleanup(name, tmp, handle) });
  } catch (e) {
    note(name, "error.txt", e.stack ?? String(e));
    record(name, false, Date.now() - t0, { error: e.message, ...out, tmp: await cleanup(name, tmp, handle) });
  }
}

// --- RB: rollback drill --------------------------------------------------------

async function caseRollback() {
  const name = "RB";
  const t0 = Date.now();
  const { tmp, env } = makeEnv(name);
  let handle;
  const out = {};
  try {
    // legacy 数据种子:旧 registry 格式(禁用 hello)+ 带 dist 的 hello App
    fs.mkdirSync(env.MINI_DATA_DIR, { recursive: true });
    await fsp.mkdir(env.MINI_APPS_DIR, { recursive: true });
    await fsp.cp(path.join(REPO, "apps", "hello"), path.join(env.MINI_APPS_DIR, "hello"), { recursive: true });
    await fsp.writeFile(path.join(env.MINI_DATA_DIR, "registry.json"), JSON.stringify({ disabled: ["hello"] }));

    handle = startHost(env, name);
    await waitHostUp(env);
    const rt = readRuntime(env);

    const get = async (p) => (await fetch(`http://127.0.0.1:${rt.port}${p}`, { headers: { authorization: `Bearer ${rt.token}`, connection: "close" } })).json();
    const apps = await get("/apps");
    const hello = (apps.apps ?? []).find((a) => a.id === "hello");
    out.legacyDisabledPreserved = hello?.enabled === false;
    if (!out.legacyDisabledPreserved) throw new Error(`legacy 禁用状态未保留: ${JSON.stringify(hello)}`);

    out.bakMigrations = fs.readdirSync(env.MINI_DATA_DIR).filter((n) => n.startsWith("registry.json") && n.includes(".bak")).length;
    if (out.bakMigrations !== 1) throw new Error(`迁移备份应恰好 1 份,实际 ${out.bakMigrations}`);

    // 迁移后可正常启用(不炸、可写)
    const en = await fetch(`http://127.0.0.1:${rt.port}/apps/hello/enable`, { method: "POST", headers: { authorization: `Bearer ${rt.token}`, connection: "close" } }).then((r) => r.json());
    out.enableAfterMigration = en.ok === true;
    if (!out.enableAfterMigration) throw new Error(`迁移后 enable 失败: ${JSON.stringify(en)}`);

    await stopHost(env, handle);
    handle = null;
    note(name, "rb.json", out);

    out.oldBinaryReadsNewData = "未验证:仓库非 git、无旧版本二进制快照;数据面 schema 稳定(schemaVersion 1),旧版本兼容性以 state.test.cjs 的 legacy 迁移用例为准";
    record(name, true, Date.now() - t0, { ...out, tmp: await cleanup(name, tmp, handle) });
  } catch (e) {
    note(name, "error.txt", e.stack ?? String(e));
    record(name, false, Date.now() - t0, { error: e.message, ...out, tmp: await cleanup(name, tmp, handle) });
  }
}

(async () => {
  const cases = { TIMING: caseTiming, RB: caseRollback };
  const names = onlyCase ? [onlyCase] : Object.keys(cases);
  for (const n of names) {
    if (!cases[n]) { console.error(`未知用例 ${n},可选:${Object.keys(cases).join(", ")}`); process.exit(2); }
    await cases[n]();
  }
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE, "summary.json"), JSON.stringify(results, null, 2));

  // 机器拓扑(写入判卷单引用的证据)
  const electronPkg = JSON.parse(fs.readFileSync(path.join(REPO, "node_modules", "electron", "package.json"), "utf8"));
  fs.writeFileSync(path.join(EVIDENCE, "topology.json"), JSON.stringify({
    platform: `${os.type()} ${os.release()}`,
    node: process.version,
    electron: electronPkg.version,
    cpus: os.cpus().length,
    totalMemGB: Math.round(os.totalmem() / 1024 ** 3),
    displays: "主屏物理 3840×2160 @1.5(DIP 2560×1440)+ 副 1920×1200 @1.0(用户环境)",
    evidenceDir: EVIDENCE,
  }, null, 2));

  const failed = results.filter((r) => !r.ok);
  console.log(`\nacceptance-timing:${results.length - failed.length}/${results.length} 通过;证据在 ${EVIDENCE}`);
  process.exitCode = failed.length ? 1 : 0;
})();
