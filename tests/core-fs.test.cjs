const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');

const coreBundle = path.join(os.tmpdir(), `mini-core-test-${process.pid}.cjs`);
const historyBundle = path.join(os.tmpdir(), `mini-history-test-${process.pid}.cjs`);
esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'host', 'src', 'main', 'services', 'core.ts')], outfile: coreBundle, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'host', 'src', 'main', 'history.ts')], outfile: historyBundle, bundle: true, platform: 'node', format: 'cjs' });
process.on('exit', () => { fs.rmSync(coreBundle, { force: true }); fs.rmSync(historyBundle, { force: true }); });

function run(bundle, dir, code) {
  return spawnSync(process.execPath, ['-e', `const fs=require("fs"); process.chdir(${JSON.stringify(dir)}); const c=require(${JSON.stringify(bundle)}); ${code}`], {
    env: {
      ...process.env,
      MINI_ROOT: path.join(__dirname, '..'),
      MINI_DATA_DIR: dir,
      // bundle 里 external 的 require("electron") 要能解析到仓库内的 electron 包
      NODE_PATH: path.join(__dirname, '..', 'node_modules'),
    },
    encoding: 'utf8', timeout: 60_000,
  });
}
function ok(result, what) {
  assert.equal(result.status, 0, `${what} failed: ${result.stderr || result.stdout}`);
}
function tmpdir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mini-corefs-${label}-`));
}

// --- C1: files.move / files.copy ---------------------------------------------

test('same-volume move relocates file and removes source', () => {
  const dir = tmpdir('move');
  try {
    ok(run(coreBundle, dir, `
      fs.writeFileSync("a.txt", "A");
      c.filesApi.move("a.txt", "sub/b.txt");
      if (fs.existsSync("a.txt")) process.exit(2);
      if (fs.readFileSync("sub/b.txt", "utf8") !== "A") process.exit(3);
    `), 'move');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('move/copy never overwrite an existing destination (E_EXISTS, both sides intact)', () => {
  const dir = tmpdir('nooverwrite');
  try {
    ok(run(coreBundle, dir, `
      fs.writeFileSync("x1", "V1");
      fs.writeFileSync("x2", "V2");
      for (const op of ["move", "copy"]) {
        try { c.filesApi[op]("x1", "x2"); process.exit(5); }
        catch (e) { if (!/E_EXISTS/.test(String(e.message))) process.exit(6); }
      }
      if (fs.readFileSync("x1", "utf8") !== "V1" || fs.readFileSync("x2", "utf8") !== "V2") process.exit(7);
    `), 'no-overwrite');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cross-volume move (injected) succeeds via temp and leaves no temp files', () => {
  const dir = tmpdir('crossvol');
  try {
    ok(run(coreBundle, dir, `
      fs.writeFileSync("a.txt", "CROSS");
      c.filesApi.move("a.txt", "out/b.txt", { sameVolume: () => false });
      if (fs.existsSync("a.txt")) process.exit(2);
      if (fs.readFileSync("out/b.txt", "utf8") !== "CROSS") process.exit(3);
      const leftovers = fs.readdirSync("out").filter((n) => n.includes(".mini-move-"));
      if (leftovers.length) process.exit(4);
    `), 'cross-volume move');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cross-volume move failure keeps the source and leaves no temp files', () => {
  const dir = tmpdir('crossfail');
  try {
    ok(run(coreBundle, dir, `
      fs.writeFileSync("keep.txt", "KEEP");
      fs.writeFileSync("blocker", "not a dir");
      try { c.filesApi.move("keep.txt", "blocker/inner/y.txt", { sameVolume: () => false }); process.exit(5); }
      catch (e) { if (/E_EXISTS/.test(String(e.message))) process.exit(6); }
      if (fs.readFileSync("keep.txt", "utf8") !== "KEEP") process.exit(7);
      const leftovers = fs.readdirSync(".").filter((n) => n.includes(".mini-move-"));
      if (leftovers.length) process.exit(8);
    `), 'cross-volume failure');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- C2: storage consistency ---------------------------------------------------

test('storage set persists and stays readable across processes', () => {
  const dir = tmpdir('store');
  try {
    ok(run(coreBundle, dir, `
      c.storageApi.set("testapp", "k", "v1");
      if (c.storageApi.get("testapp", "k") !== "v1") process.exit(2);
    `), 'set');
    ok(run(coreBundle, dir, `
      if (c.storageApi.get("testapp", "k") !== "v1") process.exit(3);
    `), 'fresh-process get');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('storage write failure leaves memory and disk consistent (old value intact)', () => {
  const dir = tmpdir('storefail');
  try {
    ok(run(coreBundle, dir, `c.storageApi.set("testapp", "k", "v1");`), 'seed');
    // 故障注入:占住 tmp 写入路径(同名目录使 writeFileSync 抛 EISDIR)
    fs.mkdirSync(path.join(dir, 'storage', 'testapp.json.tmp'));
    const failed = run(coreBundle, dir, `
      try { c.storageApi.set("testapp", "k", "v2"); }
      catch (e) { if (!/EISDIR|EPERM|EACCES/.test(String((e && e.code) || e))) process.exit(2); process.exit(42); }
      process.exit(3);
    `);
    assert.equal(failed.status, 42, `failed set must throw with EISDIR-class error: ${failed.stderr}`);
    const probe = run(coreBundle, dir, `
      if (c.storageApi.get("testapp", "k") !== "v1") process.exit(4);
      console.log("ok");
    `);
    assert.match(probe.stdout, /ok/);
    // 移除阻塞后恢复可用
    fs.rmdirSync(path.join(dir, 'storage', 'testapp.json.tmp'));
    ok(run(coreBundle, dir, `
      c.storageApi.set("testapp", "k", "v2");
      if (c.storageApi.get("testapp", "k") !== "v2") process.exit(5);
    `), 'recovered set');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt storage file is preserved as .corrupt-* and never silently wiped', () => {
  const dir = tmpdir('storecorrupt');
  try {
    fs.mkdirSync(path.join(dir, 'storage'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'storage', 'testapp.json'), '{oops');
    ok(run(coreBundle, dir, `
      if (c.storageApi.get("testapp", "k") !== null) process.exit(2);
      c.storageApi.set("testapp", "k", "fresh");
      if (c.storageApi.get("testapp", "k") !== "fresh") process.exit(3);
    `), 'corrupt recovery');
    const files = fs.readdirSync(path.join(dir, 'storage'));
    assert.ok(files.some((n) => /^testapp\.json\.corrupt-/.test(n)), `corrupt backup missing: ${files.join(',')}`);
    ok(run(coreBundle, dir, `
      if (c.storageApi.get("testapp", "k") !== "fresh") process.exit(4);
    `), 'fresh get after corrupt');
    // 非对象 JSON(数组)同样走损坏路径
    fs.writeFileSync(path.join(dir, 'storage', 'other.json'), '[1,2]');
    ok(run(coreBundle, dir, `
      if (c.storageApi.keys("other").length !== 0) process.exit(5);
    `), 'array json treated as corrupt');
    assert.ok(fs.readdirSync(path.join(dir, 'storage')).some((n) => /^other\.json\.corrupt-/.test(n)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- C3: history bounded scans -------------------------------------------------

function seedHistory(dir, lines) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'history.jsonl'), lines.join('\n') + '\n');
}

test('query paging covers the whole file when it fits the tail window (small history)', () => {
  const dir = tmpdir('histsmall');
  try {
    const lines = [];
    for (let i = 0; i < 1000; i++) {
      lines.push(JSON.stringify({
        eventId: `e${i}`, appId: i % 10 === 0 ? 'app-a' : 'app-b', runId: 'r',
        kind: 'invoke', outcome: 'success', at: `2026-01-01T00:00:00.${String(i).padStart(4, '0')}Z`,
      }));
    }
    seedHistory(dir, lines);
    const out = run(historyBundle, dir, `
      const first = c.query("app-a", 0, 30);
      if (first.events.length !== 30 || first.nextCursor !== 30) process.exit(2);
      if (first.events[0].eventId !== "e990") process.exit(3); // newest app-a, newest first
      let cursor = first.nextCursor, total = first.events.length, prev = 990;
      for (;;) {
        const page = c.query("app-a", cursor, 40);
        for (const e of page.events) {
          const n = Number(e.eventId.slice(1));
          if (n >= prev) process.exit(4); // 严格递减(新→旧)
          prev = n;
        }
        total += page.events.length;
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      if (total !== 100) process.exit(5);
      const mixed = c.query(undefined, 0, 5);
      if (mixed.events.length !== 5 || mixed.events[0].eventId !== "e999") process.exit(6);
      console.log("ok");
    `);
    assert.match(out.stdout, /ok/, out.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('query on a large file stays newest-first and chain-paginates within the tail window', () => {
  const dir = tmpdir('histbig');
  try {
    const lines = [];
    for (let i = 0; i < 30000; i++) {
      lines.push(JSON.stringify({
        eventId: `e${i}`, appId: i % 30 === 0 ? 'app-a' : 'app-b', runId: 'r',
        kind: 'invoke', outcome: 'success', at: `2026-01-01T00:00:00.${String(i).padStart(4, '0')}Z`,
      }));
    }
    seedHistory(dir, lines); // ≈3.3 MB,超出 1 MiB 尾窗口(设计如此,只保证尾部可查)
    const out = run(historyBundle, dir, `
      const first = c.query("app-a", 0, 10);
      if (first.events.length !== 10 || first.nextCursor !== 10) process.exit(2);
      if (first.events[0].eventId !== "e29970") process.exit(3); // 文件中最大的 app-a 事件
      let cursor = first.nextCursor, count = 10, prev = 29960;
      for (;;) {
        const page = c.query("app-a", cursor, 100);
        for (const e of page.events) {
          const n = Number(e.eventId.slice(1));
          if (n >= prev) process.exit(4);
          prev = n;
        }
        count += page.events.length;
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      if (count < 100) process.exit(5); // 窗口内至少覆盖一批 app-a 事件
      const mixed = c.query(undefined, 0, 5);
      if (mixed.events[0].eventId !== "e29999") process.exit(6);
      console.log("ok " + count);
    `);
    assert.match(out.stdout, /ok/, out.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hasTerminal finds a terminal buried at the oldest line and terminates when absent', () => {
  const dir = tmpdir('histterminal');
  try {
    const lines = [JSON.stringify({ eventId: 't', appId: 'app-a', runId: 'deep-run', kind: 'stop', outcome: 'success', at: '2026-01-01T00:00:00Z' })];
    for (let i = 0; i < 30000; i++) {
      lines.push(JSON.stringify({ eventId: `e${i}`, appId: 'app-b', kind: 'invoke', outcome: 'success', at: '2026-01-01T00:00:00Z' }));
    }
    seedHistory(dir, lines);
    const before = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').split('\n').filter(Boolean).length;
    ok(run(historyBundle, dir, `
      if (!c.hasTerminal("deep-run")) process.exit(2);      // 埋在最老一行的终态也要找到
      if (c.hasTerminal("never-existed")) process.exit(3);  // 不存在时全量反向扫描需正常终止
      // 终态去重:同一 run 再 append stop 不得产生第二条
      if (!c.event({ appId: "app-a", runId: "deep-run", kind: "stop", outcome: "success" })) process.exit(4);
      console.log("ok");
    `), 'hasTerminal + dedup');
    const after = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').split('\n').filter(Boolean).length;
    assert.equal(after, before, 'deduplicated stop must not append a line');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('initRuns recovery: buried terminal suppresses interrupted; missing terminal gets exactly one; idempotent', () => {
  const dir = tmpdir('histrecover');
  try {
    const lines = [JSON.stringify({ eventId: 't', appId: 'app-a', runId: 'deep-run', kind: 'crash', outcome: 'failure', at: '2026-01-01T00:00:00Z' })];
    for (let i = 0; i < 30000; i++) {
      lines.push(JSON.stringify({ eventId: `e${i}`, appId: 'app-b', kind: 'invoke', outcome: 'success', at: '2026-01-01T00:00:00Z' }));
    }
    seedHistory(dir, lines);
    fs.writeFileSync(path.join(dir, 'active-runs.json'), JSON.stringify({
      schemaVersion: 1, epoch: 'ep1',
      runs: [
        { appId: 'app-a', pid: 1, runId: 'deep-run', startedAt: '2026-01-01T00:00:00Z' },
        { appId: 'app-a', pid: 2, runId: 'ghost-run', startedAt: '2026-01-01T00:00:00Z' },
      ],
    }));
    ok(run(historyBundle, dir, `c.initRuns(); console.log("ok");`), 'initRuns');
    const text = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8');
    const ghostInterrupted = text.split('\n').filter((l) => l.includes('ghost-run') && l.includes('"interrupted"'));
    assert.equal(ghostInterrupted.length, 1, 'ghost-run 需要恰好一条 interrupted');
    const deepInterrupted = text.split('\n').filter((l) => l.includes('deep-run') && l.includes('"interrupted"'));
    assert.equal(deepInterrupted.length, 0, 'deep-run 已有埋藏终态,不应再写 interrupted');
    const active = JSON.parse(fs.readFileSync(path.join(dir, 'active-runs.json'), 'utf8'));
    assert.deepEqual(active.runs, [], '恢复后 active 应清空');
    // 二次启动幂等
    ok(run(historyBundle, dir, `c.initRuns(); console.log("ok");`), 'second initRuns');
    const text2 = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8');
    const ghostAgain = text2.split('\n').filter((l) => l.includes('ghost-run') && l.includes('"interrupted"'));
    assert.equal(ghostAgain.length, 1, '二次启动不得重复 interrupted');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('initRuns returns only appIds marked interrupted this boot, in order and deduped; second call returns []', () => {
  const dir = tmpdir('histreturn');
  try {
    const lines = [
      // run-b 有埋藏终态(不进恢复名单);run-a 与 run-c 无终态 → 补 interrupted
      JSON.stringify({ eventId: 't', appId: 'app-b', runId: 'run-b', kind: 'stop', outcome: 'success', at: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ eventId: 'i1', appId: 'app-a', kind: 'invoke', outcome: 'success', at: '2026-01-01T00:00:01Z' }),
    ];
    seedHistory(dir, lines);
    fs.writeFileSync(path.join(dir, 'active-runs.json'), JSON.stringify({
      schemaVersion: 1, epoch: 'ep1',
      runs: [
        { appId: 'app-a', pid: 1, runId: 'run-a', startedAt: '2026-01-01T00:00:00Z' },
        { appId: 'app-b', pid: 2, runId: 'run-b', startedAt: '2026-01-01T00:00:00Z' },
        { appId: 'app-a', pid: 3, runId: 'run-c', startedAt: '2026-01-01T00:00:00Z' }, // 同 appId 第二个 run → 去重
        { appId: 'app-c', pid: 4, runId: 'run-d', startedAt: '2026-01-01T00:00:00Z' },
      ],
    }));
    const out = run(historyBundle, dir, `
      const first = c.initRuns();
      if (JSON.stringify(first) !== JSON.stringify(["app-a","app-c"])) process.exit(2);
      const second = c.initRuns();
      if (JSON.stringify(second) !== JSON.stringify([])) process.exit(3);
      console.log("ok");
    `);
    assert.match(out.stdout, /ok/, out.stderr);
    // interrupted 照常只落在无终态的 run 上(run-b 已有终态不补)
    const text = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8');
    const interrupted = text.split('\n').filter((l) => l.includes('"interrupted"')).map((l) => JSON.parse(l).runId);
    assert.deepEqual(interrupted.sort(), ['run-a', 'run-c', 'run-d']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('restored events are accepted and queryable, and do not suppress later terminal judgment', () => {
  const dir = tmpdir('histrestored');
  try {
    seedHistory(dir, [
      JSON.stringify({ eventId: 'e0', appId: 'app-a', kind: 'invoke', outcome: 'success', at: '2026-01-01T00:00:00Z' }),
    ]);
    ok(run(historyBundle, dir, `
      // restored 是伴随事件:不带 runId 也必须能写、能 query 回来
      if (!c.event({ appId: "app-a", kind: "restored", outcome: "success" })) process.exit(2);
      if (!c.event({ appId: "app-b", kind: "restored", outcome: "failure", message: "APP_DISABLED: App app-b 已禁用" })) process.exit(3);
      const restoredA = c.query("app-a", 0, 10).events.filter((e) => e.kind === "restored");
      if (restoredA.length !== 1 || restoredA[0].outcome !== "success") process.exit(4);
      const restoredB = c.query("app-b", 0, 10).events.filter((e) => e.kind === "restored");
      if (restoredB.length !== 1 || restoredB[0].message !== "APP_DISABLED: App app-b 已禁用") process.exit(5);
      // restored 不进 TERMINAL_KINDS:同 runId 先写 restored,首次 stop 仍落为终态且只落一条
      if (!c.event({ appId: "app-a", runId: "run-x", kind: "restored", outcome: "success" })) process.exit(6);
      if (!c.event({ appId: "app-a", runId: "run-x", kind: "stop", outcome: "success" })) process.exit(7);
      const stops = c.query("app-a", 0, 20).events.filter((e) => e.kind === "stop" && e.runId === "run-x");
      if (stops.length !== 1 || stops[0].eventId !== "run-x:terminal") process.exit(8);
      console.log("ok");
    `), 'restored event');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
