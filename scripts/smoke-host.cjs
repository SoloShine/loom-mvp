#!/usr/bin/env node
/**
 * Double-process Electron smoke for the loom-mvp host (batch R1 of
 * docs/mvp-acceptance-plan.md).
 *
 * Every case runs against its own temporary MINI_DATA_DIR / MINI_APPS_DIR and
 * asserts real process behaviour: exit codes, history.jsonl terminal events,
 * active-runs recovery, process-tree cleanup. Evidence lands in
 * data/smoke/<runId>/<case>/.
 *
 * Usage: node scripts/smoke-host.cjs [--case S1] [--keep]
 * Requires `npm run build` first (host/dist and cli/dist must exist).
 * Windows-only by design (taskkill / PowerShell process queries).
 */
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

if (process.platform !== "win32") {
  console.error("smoke-host: 仅支持 Windows(taskkill / Win32_Process 查询)");
  process.exit(2);
}

const REPO = path.resolve(__dirname, "..");
const CLI = path.join(REPO, "cli", "dist", "mini.js");
const ELECTRON = require(require.resolve("electron", { paths: [REPO] }));
const EVIDENCE_ROOT = path.join(REPO, "data", "smoke", `run-${Date.now()}`);
const KEEP = process.argv.includes("--keep");
const onlyCase = (() => {
  const i = process.argv.indexOf("--case");
  return i >= 0 ? process.argv[i + 1] : null;
})();

for (const p of [CLI, path.join(REPO, "host", "dist", "main", "index.js")]) {
  if (!fs.existsSync(p)) {
    console.error(`smoke-host: 缺少 ${path.relative(REPO, p)},先运行 npm run build`);
    process.exit(2);
  }
}

// --- small helpers -----------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

async function pollUntil(fn, timeoutMs, intervalMs = 300, what = "condition") {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`等待超时(${timeoutMs}ms):${what}`);
}

function note(caseName, file, text) {
  const dir = path.join(EVIDENCE_ROOT, caseName);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, file), typeof text === "string" ? text : JSON.stringify(text, null, 2) + "\n");
}

function makeEnv(caseName) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `mini-smoke-${caseName}-`));
  const env = {
    ...process.env,
    MINI_ROOT: REPO,
    MINI_DATA_DIR: path.join(tmp, "data"),
    MINI_APPS_DIR: path.join(tmp, "apps"),
  };
  return { tmp, env };
}

async function copyApp(env, id) {
  const src = path.join(REPO, "apps", id);
  const dest = path.join(env.MINI_APPS_DIR, id);
  await fsp.cp(src, dest, { recursive: true });
  return dest;
}

/** Run the real CLI binary; returns {status, stdout, stderr}. */
function mini(args, env, timeoutMs = 60_000) {
  const res = spawnSync(process.execPath, [CLI, ...args], { env, timeout: timeoutMs, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Authenticated HTTP call against the host control channel. */
async function http(env, method, p, body) {
  const info = JSON.parse(fs.readFileSync(path.join(env.MINI_DATA_DIR, "runtime.json"), "utf8"));
  const res = await fetch(`http://127.0.0.1:${info.port}${p}`, {
    method,
    headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json", connection: "close" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok && data.ok !== false, data };
}

function readRuntime(env) {
  try {
    return JSON.parse(fs.readFileSync(path.join(env.MINI_DATA_DIR, "runtime.json"), "utf8"));
  } catch {
    return null;
  }
}

async function waitHostUp(env, timeoutMs = 45_000) {
  return pollUntil(async () => {
    const rt = readRuntime(env);
    if (!rt) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${rt.port}/ping`, {
        headers: { authorization: `Bearer ${rt.token}`, connection: "close" },
      });
      if (res.ok) return rt;
    } catch { /* not up yet */ }
    return null;
  }, timeoutMs, 300, "Host 启动(runtime.json + /ping)");
}

/** Spawn the electron host WITHOUT windowsHide (it poisons window visibility).
 *  A private --user-data-dir gives the smoke instance its own single-instance
 *  lock, so the smoke can run while the user's real host is up. */
function startHost(env, caseName) {
  const logFile = path.join(EVIDENCE_ROOT, caseName, "host-live.log");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, `[spawn] pid pending\n`);
  const proc = spawn(ELECTRON, ["host", `--user-data-dir=${env.MINI_DATA_DIR}`], {
    cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"],
  });
  fs.writeFileSync(logFile, `[spawn] pid=${proc.pid} user-data-dir=${env.MINI_DATA_DIR}\n`);
  const append = (tag) => (d) => fs.appendFileSync(logFile, `[${tag}] ${d}`);
  proc.stdout.on("data", append("out"));
  proc.stderr.on("data", append("err"));
  proc.on("exit", (code, sig) => fs.appendFileSync(logFile, `[exit] code=${code} signal=${sig}\n`));
  return { proc };
}

function treeKill(pid) {
  return spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8" });
}

/** Processes whose command line contains marker. Excludes the PowerShell
 *  query itself — its own command line contains the marker string. */
function pidsMatching(marker) {
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${marker}*' } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`;
  const res = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8", timeout: 30_000 });
  if (res.status !== 0) return { error: res.stderr };
  const lines = (res.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return { pids: lines.map((l) => Number(l.split(" ")[0])), lines };
}

function historyLines(env) {
  const file = path.join(env.MINI_DATA_DIR, "history.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return { unparsable: l }; }
  });
}

async function stopHostGracefully(env, handle, caseName, timeoutMs = 25_000) {
  const shut = await http(env, "POST", "/host/shutdown");
  note(caseName, "shutdown.json", shut);
  await pollUntil(() => handle.proc.exitCode !== null || handle.proc.signalCode !== null, timeoutMs, 300, "Host 进程退出");
  return shut;
}

async function cleanupCase(caseName, tmp, handle) {
  if (handle && handle.proc.exitCode === null && handle.proc.signalCode === null) treeKill(handle.proc.pid);
  if (KEEP) return `${tmp} (保留)`;
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  return `${tmp} (已清理)`;
}

function record(caseName, ok, ms, details) {
  results.push({ case: caseName, ok, ms, details });
  console.log(`${ok ? "✓" : "✗"} ${caseName} (${ms}ms) — ${ok ? "ok" : JSON.stringify(details)}`);
}

// --- cases -------------------------------------------------------------------

/** S1 正常启停:在线 CLI、invoke、干净退出、无孤儿进程。 */
async function caseS1() {
  const name = "S1";
  const t0 = Date.now();
  const { tmp, env } = makeEnv(name);
  let handle;
  try {
    await copyApp(env, "hello");
    const build = mini(["build", "hello"], env);
    note(name, "build.json", build);
    if (build.status !== 0) throw new Error(`mini build 失败: ${build.stderr}`);

    handle = startHost(env, name);
    const rt = await waitHostUp(env);
    note(name, "runtime.json", rt);

    const list = mini(["list"], env);
    note(name, "list.txt", list.stdout + list.stderr);
    if (list.status !== 0) throw new Error(`mini list 失败: ${list.stderr}`);

    const start = await http(env, "POST", "/apps/hello/start");
    note(name, "start.json", start);
    if (!start.ok) throw new Error(`start hello 失败: ${JSON.stringify(start.data)}`);

    const selftest = mini(["invoke", "hello", "selftest"], env, 120_000);
    note(name, "selftest.txt", selftest.stdout + selftest.stderr);
    if (selftest.status !== 0) throw new Error(`hello selftest 失败: ${selftest.stderr || selftest.stdout}`);

    const stop = mini(["stop", "hello"], env);
    if (stop.status !== 0) throw new Error(`mini stop 失败: ${stop.stderr}`);

    const events = historyLines(env);
    note(name, "history.json", events);
    const stopOk = events.some((e) => e.appId === "hello" && e.kind === "stop" && e.outcome === "success");
    if (!stopOk) throw new Error("history 缺少 hello 的 stop/ok 终结事件");

    const shut = await stopHostGracefully(env, handle, name);
    if (!shut.ok) throw new Error(`/host/shutdown 未成功: ${JSON.stringify(shut.data)}`);

    // 子进程消亡有短暂窗口,宽限几秒再判孤儿
    await pollUntil(async () => (pidsMatching(tmp).pids?.length ?? 1) === 0, 8_000, 500, "孤儿进程清空");
    const orphans = pidsMatching(tmp);
    note(name, "orphans.json", orphans);
    if (orphans.pids?.length) throw new Error(`发现孤儿进程: ${orphans.lines.join(";")}`);

    record(name, true, Date.now() - t0, { tmp });
  } catch (e) {
    note(name, "error.txt", e.stack ?? String(e));
    record(name, false, Date.now() - t0, { error: e.message, tmp: await cleanupCase(name, tmp, handle) });
    return;
  }
  await cleanupCase(name, tmp, handle);
}

/** S2 App 崩溃隔离:外部杀 App utilityProcess,Host 存活,唯一 crash 终结事件。 */
async function caseS2() {
  const name = "S2";
  const t0 = Date.now();
  const { tmp, env } = makeEnv(name);
  let handle;
  try {
    await copyApp(env, "hello");
    await copyApp(env, "file-organizer");
    for (const id of ["hello", "file-organizer"]) {
      const b = mini(["build", id], env);
      if (b.status !== 0) throw new Error(`mini build ${id} 失败: ${b.stderr}`);
    }
    handle = startHost(env, name);
    await waitHostUp(env);
    for (const id of ["hello", "file-organizer"]) {
      const s = await http(env, "POST", `/apps/${id}/start`);
      if (!s.ok) throw new Error(`start ${id} 失败: ${JSON.stringify(s.data)}`);
    }

    // App PID 在 active-runs.json 里(pid 回填 > 0 本身就是对 Host 修复的回归断言)
    const active = JSON.parse(fs.readFileSync(path.join(env.MINI_DATA_DIR, "active-runs.json"), "utf8"));
    note(name, "active-before.json", active);
    const run = active.runs.find((r) => r.appId === "hello");
    if (!run?.runId) throw new Error(`active-runs 无 hello 条目: ${JSON.stringify(active)}`);
    if (!run.pid) throw new Error(`active-runs 的 pid 未回填(仍为 ${run.pid})`);
    const runId = run.runId;

    const kill = treeKill(run.pid);
    note(name, "kill.txt", kill.stdout + kill.stderr);
    await pollUntil(async () => {
      const r = await http(env, "GET", "/apps/hello").catch(() => null);
      return (r?.data?.app?.status ?? r?.data?.data?.status) === "crashed";
    }, 10_000, 300, "hello 状态变为 crashed");

    const list = mini(["list"], env);
    if (list.status !== 0) throw new Error(`崩溃后 mini list 失败: ${list.stderr}`);

    // 另一个 App 的 invoke 仍可达(preview 无目录时返回 App 自身的业务错误)
    const inv = mini(["invoke", "file-organizer", "preview"], env);
    note(name, "invoke-fo.txt", inv.stdout + inv.stderr);
    const roundtrip = inv.stdout + inv.stderr;
    if (!/No directory selected/i.test(roundtrip)) {
      throw new Error(`file-organizer invoke 未按预期返回业务错误: ${roundtrip.slice(0, 300)}`);
    }

    const after = historyLines(env);
    note(name, "history-after.json", after);
    const terminals = after.filter((e) => e.runId === runId && e.eventId === `${runId}:terminal`);
    if (terminals.length !== 1) throw new Error(`runId ${runId} 终结事件数=${terminals.length},应为 1`);
    if (terminals[0].kind === "stop") throw new Error(`外部 kill 被记成 stop: ${JSON.stringify(terminals[0])}`);

    record(name, true, Date.now() - t0, { tmp, crashedWithKind: terminals[0].kind });
  } catch (e) {
    note(name, "error.txt", e.stack ?? String(e));
    record(name, false, Date.now() - t0, { error: e.message, tmp: await cleanupCase(name, tmp, handle) });
    return;
  }
  await cleanupCase(name, tmp, handle);
}

/** S3 Host 猝死恢复:整树强杀后重启,active run 恢复为唯一 interrupted。 */
async function caseS3() {
  const name = "S3";
  const t0 = Date.now();
  const { tmp, env } = makeEnv(name);
  let handle;
  try {
    await copyApp(env, "hello");
    if (mini(["build", "hello"], env).status !== 0) throw new Error("mini build 失败");
    handle = startHost(env, name);
    await waitHostUp(env);
    const s = await http(env, "POST", "/apps/hello/start");
    if (!s.ok) throw new Error(`start 失败: ${JSON.stringify(s.data)}`);

    const activeBefore = JSON.parse(fs.readFileSync(path.join(env.MINI_DATA_DIR, "active-runs.json"), "utf8"));
    note(name, "active-before.json", activeBefore);
    const runEntry = activeBefore.runs.find((r) => r.appId === "hello");
    if (!runEntry?.runId) throw new Error(`active-runs 无 hello 条目: ${JSON.stringify(activeBefore)}`);
    if (!runEntry.pid) throw new Error(`active-runs 的 pid 未回填(仍为 ${runEntry.pid})`);
    const runId = runEntry.runId;

    const rt = readRuntime(env);
    const kill = treeKill(rt.pid);
    note(name, "kill.txt", kill.stdout + kill.stderr);
    await pollUntil(() => handle.proc.exitCode !== null || handle.proc.signalCode !== null, 15_000, 300, "Host 进程死亡");
    handle = null;
    // 强杀后 runtime.json 按设计残留在磁盘上,重启前清掉陈旧发现文件
    fs.rmSync(path.join(env.MINI_DATA_DIR, "runtime.json"), { force: true });

    handle = startHost(env, name);
    await waitHostUp(env);

    const events = historyLines(env);
    note(name, "history-after-restart.json", events);
    const terminals = events.filter((e) => e.runId === runId && e.eventId === `${runId}:terminal`);
    if (terminals.length !== 1) throw new Error(`runId ${runId} 终结事件数=${terminals.length},应为 1(去重失败)`);
    if (terminals[0].kind === "stop") throw new Error(`猝死被记成干净 stop: ${JSON.stringify(terminals[0])}`);

    const activeAfter = fs.existsSync(path.join(env.MINI_DATA_DIR, "active-runs.json"))
      ? JSON.parse(fs.readFileSync(path.join(env.MINI_DATA_DIR, "active-runs.json"), "utf8"))
      : { runs: [] };
    note(name, "active-after.json", activeAfter);
    if (activeAfter.runs?.length) {
      throw new Error(`重启后 active-runs 未清理: ${JSON.stringify(activeAfter)}`);
    }

    const again = await http(env, "POST", "/apps/hello/start");
    if (!again.ok) throw new Error(`恢复后再次启动失败: ${JSON.stringify(again.data)}`);

    record(name, true, Date.now() - t0, { tmp, recoveredKind: terminals[0].kind });
  } catch (e) {
    note(name, "error.txt", e.stack ?? String(e));
    record(name, false, Date.now() - t0, { error: e.message, tmp: await cleanupCase(name, tmp, handle) });
    return;
  }
  await cleanupCase(name, tmp, handle);
}

/** S4 stop 卡死强杀:onStop 挂住的 App 在 6s 超时后报错而非假成功,helper 被清。 */
async function caseS4() {
  const name = "S4";
  const t0 = Date.now();
  const { tmp, env } = makeEnv(name);
  const MARKER = `stop-hang-marker-${Date.now()}`;
  let handle;
  try {
    const appDir = await copyApp(env, "hello");
    await fsp.rm(appDir, { recursive: true, force: true });
    await fsp.mkdir(path.join(env.MINI_APPS_DIR, "stop-hang", "src"), { recursive: true });
    await fsp.writeFile(path.join(env.MINI_APPS_DIR, "stop-hang", "app.yaml"),
      `id: stop-hang\nname: Stop Hang\nversion: 0.0.1\nentry: src/main.ts\nui:\n  type: none\ncommands:\n  - id: ping\n    title: Ping\npermissions:\n  - process\n  - log\n`);
    await fsp.writeFile(path.join(env.MINI_APPS_DIR, "stop-hang", "src", "main.ts"),
      `import { host } from "@mini/sdk";\n` +
      `export async function onStart() {\n` +
      `  host.process.spawn({ command: "node", args: ["-e", "/*${MARKER}*/setInterval(function(){},60000)"] });\n` +
      `  await host.log.info("stop-hang started");\n` +
      `}\n` +
      `export async function onStop() { await new Promise(function () {}); }\n` +
      `export async function invoke(command: string) { if (command === "ping") return "pong"; throw new Error("unknown " + command); }\n`);
    const build = mini(["build", "stop-hang"], env);
    note(name, "build.txt", build.stdout + build.stderr);
    if (build.status !== 0) throw new Error("mini build stop-hang 失败");

    handle = startHost(env, name);
    await waitHostUp(env);
    const s = await http(env, "POST", "/apps/stop-hang/start");
    if (!s.ok) throw new Error(`start 失败: ${JSON.stringify(s.data)}`);
    await pollUntil(() => pidsMatching(MARKER).pids?.length > 0, 15_000, 400, "helper 进程出现");

    // mini stop 应在超时(~6s)后报错,而不是挂死或假成功
    const stop = mini(["stop", "stop-hang"], env, 30_000);
    note(name, "stop.txt", `status=${stop.status}\n${stop.stdout}\n${stop.stderr}`);
    if (stop.status === 0) throw new Error("stop 对挂死 App 返回了成功(假成功)");
    if (!/超时/.test(stop.stderr + stop.stdout)) throw new Error(`stop 错误未提示超时: ${stop.stderr}`);

    // helper 树应随 App 停止被清掉
    await pollUntil(async () => (pidsMatching(MARKER).pids?.length ?? 1) === 0, 15_000, 500, "helper 进程退出");
    const orphanAfter = pidsMatching(MARKER);
    if (orphanAfter.pids?.length) throw new Error(`helper 未被清理: ${orphanAfter.pids.join(",")}`);

    // 超时语义:仍保持启用,可重试 —— 强杀后再次 stop 应正常完成而非报错
    const again = await http(env, "POST", "/apps/stop-hang/stop");
    note(name, "stop2.json", again);
    if (!again.ok) throw new Error(`超时强杀后重试 stop 未恢复: ${JSON.stringify(again.data)}`);
    await stopHostGracefully(env, handle, name);
    handle = null;

    record(name, true, Date.now() - t0, { tmp });
  } catch (e) {
    note(name, "error.txt", e.stack ?? String(e));
    record(name, false, Date.now() - t0, { error: e.message, tmp: await cleanupCase(name, tmp, handle) });
    return;
  }
  await cleanupCase(name, tmp, handle);
}

/** S5 产物一致性:reload 自动重建过期产物,validate 通过。 */
async function caseS5() {
  const name = "S5";
  const t0 = Date.now();
  const { tmp, env } = makeEnv(name);
  let handle;
  try {
    const appDir = await copyApp(env, "hello");
    if (mini(["build", "hello"], env).status !== 0) throw new Error("mini build 失败");
    const dist = path.join(appDir, "dist", "main.js");
    const before = fs.statSync(dist).mtimeMs;

    handle = startHost(env, name);
    await waitHostUp(env);
    await sleep(1100); // mtime 粒度
    await fsp.appendFile(path.join(appDir, "src", "main.ts"), "\n// smoke-touch\n");

    const reload = mini(["reload", "hello"], env, 120_000);
    note(name, "reload.txt", reload.stdout + reload.stderr);
    if (reload.status !== 0) throw new Error(`mini reload 失败: ${reload.stderr}`);

    const after = fs.statSync(dist).mtimeMs;
    if (!(after > before)) throw new Error(`reload 未重建过期产物 (before=${before}, after=${after})`);

    const validate = mini(["validate", "hello"], env);
    if (validate.status !== 0) throw new Error(`mini validate 失败: ${validate.stderr}`);

    record(name, true, Date.now() - t0, { tmp, rebuilt: after > before });
  } catch (e) {
    note(name, "error.txt", e.stack ?? String(e));
    record(name, false, Date.now() - t0, { error: e.message, tmp: await cleanupCase(name, tmp, handle) });
    return;
  }
  await cleanupCase(name, tmp, handle);
}

// --- runner ------------------------------------------------------------------

(async () => {
  const cases = { S1: caseS1, S2: caseS2, S3: caseS3, S4: caseS4, S5: caseS5 };
  const names = onlyCase ? [onlyCase] : Object.keys(cases);
  for (const n of names) {
    if (!cases[n]) {
      console.error(`未知用例 ${n},可选:${Object.keys(cases).join(", ")}`);
      process.exit(2);
    }
    await cases[n]();
  }
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_ROOT, "summary.json"), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\nsmoke-host:${results.length - failed.length}/${results.length} 通过;证据在 ${EVIDENCE_ROOT}`);
  process.exitCode = failed.length ? 1 : 0;
})();
