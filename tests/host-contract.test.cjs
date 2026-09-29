const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-host-contract-'));
function load(source) {
  const output = path.join(dir, `${path.basename(source, '.ts')}.cjs`);
  esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'host/src/main', source)], outfile: output, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  return require(output);
}
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

test('shutdown prevents repeated quit and reports timeout once', async () => {
  const { createShutdownCoordinator } = load('shutdown.ts');
  const calls = [];
  const shutdown = createShutdownCoordinator({
    drain: () => calls.push('drain'), activeIds: () => ['sample'],
    stop: () => new Promise(() => {}), force: id => calls.push(`force:${id}`), isActive: () => false, waitForExit: () => Promise.resolve(),
    finalize: result => calls.push(result[0].outcome), quit: () => calls.push('quit'),
    log: text => calls.push(text),
  }, 5);
  const event = { preventDefault: () => calls.push('prevent') };
  shutdown.beforeQuit(event);
  shutdown.beforeQuit(event);
  await shutdown.pending;
  shutdown.beforeQuit(event);
  assert.equal(shutdown.phase, 'ready');
  assert.deepEqual(calls, ['prevent', 'drain', 'prevent', 'force:sample', 'timeout', 'quit']);
});

test('history recovery writes one terminal event and clears active on repeated startup', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-history-'));
  const { spawnSync } = require('node:child_process');
  const source = path.join(__dirname, '..', 'host/src/main/history.ts');
  const output = path.join(dir, 'history.cjs');
  esbuild.buildSync({ entryPoints: [source], outfile: output, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  const run = script => spawnSync(process.execPath, ['-e', `const h=require(${JSON.stringify(output)}); ${script}`], { env: { ...process.env, MINI_DATA_DIR: data }, encoding: 'utf8' });
  try {
    fs.writeFileSync(path.join(data, 'active-runs.json'), JSON.stringify({ schemaVersion: 1, epoch: 'old', runs: [{ appId: 'sample', runId: 'run1', startedAt: new Date().toISOString(), pid: 123 }] }));
    assert.equal(run('h.initRuns()').status, 0);
    assert.equal(run('h.initRuns()').status, 0);
    const events = fs.readFileSync(path.join(data, 'history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventId, 'run1:terminal');
    assert.equal(events[0].kind, 'interrupted');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'active-runs.json'), 'utf8')).runs, []);
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test('control-page sender rejects forged, destroyed and navigated contents', () => {
  const { isTrustedPage } = load('controlPage.ts');
  const file = path.join(dir, 'index.html');
  const url = require('node:url').pathToFileURL(file).href;
  const wc = { getURL: () => url, isDestroyed: () => false };
  assert.equal(isTrustedPage(wc, wc, file), true);
  assert.equal(isTrustedPage({ ...wc }, wc, file), false);
  assert.equal(isTrustedPage({ getURL: () => 'https://example.org', isDestroyed: () => false }, wc, file), false);
  assert.equal(isTrustedPage({ getURL: () => url, isDestroyed: () => true }, wc, file), false);
});

test('settings patch applies log rotation on next append and failed hotkey preserves state', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-settings-'));
  const { spawnSync } = require('node:child_process');
  const output = path.join(dir, 'settingsCommit.cjs');
  esbuild.buildSync({ stdin: { contents: `export { configureSettingsCommitter, patchHostSettings } from './host/src/main/settingsCommit.ts'; export { logApp } from './host/src/main/logging.ts';`, resolveDir: path.join(__dirname, '..'), loader: 'ts' }, outfile: output, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  const script = `const c=require(${JSON.stringify(output)}); const fs=require('fs'), p=require('path'); (async()=>{c.configureSettingsCommitter((next,commit)=>{throw Error('occupied')}); try{await c.patchHostSettings({launcherHotkey:'Ctrl+Alt+Q'})}catch{}; const f=p.join(process.env.MINI_DATA_DIR,'host-state.json'); if(JSON.parse(fs.readFileSync(f)).settings.launcherHotkey!=='Ctrl+Shift+M')process.exit(2); await c.patchHostSettings({maxLogBytesPerApp:1024,logRetentionDays:1}); const log=p.join(process.env.MINI_DATA_DIR,'logs','apps','sample.log'); fs.mkdirSync(p.dirname(log),{recursive:true});fs.writeFileSync(log,'x'.repeat(1100)); c.logApp('sample','info','next');if(!fs.readdirSync(p.dirname(log)).some(n=>n.startsWith('sample.log.')&&n.endsWith('.log')))process.exit(3); })().catch(e=>{console.error(e);process.exit(4)})`;
  try {
    const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, MINI_DATA_DIR: data }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test('build output gives both control pages strict external-only CSP', () => {
  for (const page of ['management', 'launcher']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'host/dist', page, 'index.html'), 'utf8');
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /style-src 'self'/);
    assert.doesNotMatch(html, /<style>|unsafe-inline|unsafe-eval|<script(?![^>]*src=)/);
    assert.match(html, /<link rel="stylesheet" href="\.\/.*\.css">/);
  }
});

test('manifest ui.devUrl accepts http(s) strings and rejects other schemes and types', () => {
  const { parseManifest } = load('manifest.ts');
  const yaml = devUrl => `id: sample\nname: 样例\nversion: 0.0.1\nentry: dist/main.js\nui:\n  type: window\n  devUrl: ${devUrl}\n`;
  const ok = parseManifest(yaml('"http://localhost:5173"'), 'sample');
  assert.equal(ok.ok, true);
  assert.equal(ok.manifest.ui.devUrl, 'http://localhost:5173');
  const badScheme = parseManifest(yaml('"ftp://x"'), 'sample');
  assert.equal(badScheme.ok, false);
  assert.match(badScheme.errors.join('; '), /ui\.devUrl/);
  const badType = parseManifest(yaml('123'), 'sample');
  assert.equal(badType.ok, false);
  assert.match(badType.errors.join('; '), /ui\.devUrl/);
});

test('resolveDevTarget picks dev only when devUrl declared and probe reachable', async () => {
  const { resolveDevTarget } = load('services/devTarget.ts');
  assert.equal(await resolveDevTarget('http://localhost:5173', async () => true), 'dev');
  assert.equal(await resolveDevTarget('http://localhost:5173', async () => false), 'artifact');
  assert.equal(await resolveDevTarget(undefined, async () => { throw new Error('probe must not be called'); }), 'artifact');
});

test('sanitizeRestoredBounds keeps visible bounds, clamps partial ones, rejects invisible ones', () => {
  const { sanitizeRestoredBounds } = load('services/winBounds.ts');
  const big = { x: 0, y: 0, width: 2560, height: 1440 };
  const wa = { x: 0, y: 0, width: 1920, height: 1080 };
  // 完全可见:原样返回并取整(x∈[-336,2496]、y∈[-252,1392] 均不触界)
  assert.deepEqual(
    sanitizeRestoredBounds({ x: 100.4, y: 200.6, width: 400, height: 300 }, [{ workArea: big }]),
    { x: 100, y: 201, width: 400, height: 300 },
  );
  // 部分越界:可见部分不足 64×48 时钳回边界(x=-350 只露 50 → -336;y=-280 只露 20 → -252)
  assert.deepEqual(
    sanitizeRestoredBounds({ x: -350, y: -280, width: 400, height: 300 }, [{ workArea: wa }]),
    { x: -336, y: -252, width: 400, height: 300 },
  );
  // 零相交(显示器拔了/坐标完全过期)→ null,调用方回退默认位置
  assert.equal(sanitizeRestoredBounds({ x: 5000, y: 5000, width: 400, height: 300 }, [{ workArea: big }]), null);
  // 结构垃圾:缺字段 / 宽 0 / 非对象 / 空 displays → null
  assert.equal(sanitizeRestoredBounds({ x: 100, y: 100, width: 400 }, [{ workArea: big }]), null);
  assert.equal(sanitizeRestoredBounds({ x: 0, y: 0, width: 0, height: 300 }, [{ workArea: big }]), null);
  assert.equal(sanitizeRestoredBounds('junk', [{ workArea: big }]), null);
  assert.equal(sanitizeRestoredBounds({ x: 0, y: 0, width: 400, height: 300 }, []), null);
  // 超大宽高钳到 workArea 尺寸(4000×2000 → 1920×1080),x/y 仍在合法区间
  assert.deepEqual(
    sanitizeRestoredBounds({ x: -100, y: 50, width: 4000, height: 2000 }, [{ workArea: wa }]),
    { x: -100, y: 50, width: 1920, height: 1080 },
  );
  // 双屏取相交最大者(d2 相交 350×300 > d1 50×300):按 d2 判定 x=1870 合法;
  // 若误选 d1 会被钳到 1856
  const dual = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }, { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } }];
  assert.deepEqual(
    sanitizeRestoredBounds({ x: 1870, y: 100, width: 400, height: 300 }, dual),
    { x: 1870, y: 100, width: 400, height: 300 },
  );
});

test('state winBounds round-trips via setWinBounds and survives a fresh process', () => {
  const { spawnSync } = require('node:child_process');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-winbounds-'));
  const output = path.join(dir, 'state.cjs');
  esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'host/src/main/state.ts')], outfile: output, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  const run = script => spawnSync(process.execPath, ['-e', `const s=require(${JSON.stringify(output)}); ${script}`], { env: { ...process.env, MINI_DATA_DIR: data }, encoding: 'utf8' });
  try {
    assert.equal(run('s.initState(); s.setWinBounds("sample",{x:10,y:20,width:300,height:200}); const m=s.meta("sample"); if(!m||m.winBounds?.x!==10||m.winBounds?.width!==300) process.exit(2);').status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'host-state.json'), 'utf8')).apps.sample.winBounds, { x: 10, y: 20, width: 300, height: 200 });
    assert.equal(run('s.initState(); if(s.meta("sample")?.winBounds?.height!==200) process.exit(3);').status, 0);
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test('invalid winBounds trips the corrupt bypass and leaves state readonly', () => {
  const { spawnSync } = require('node:child_process');
  const output = path.join(dir, 'state.cjs');
  esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'host/src/main/state.ts')], outfile: output, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  const cases = [
    ['string coordinate', { x: 'a', y: 0, width: 400, height: 300 }],
    ['negative width', { x: 0, y: 0, width: -1, height: 300 }],
  ];
  for (const [label, winBounds] of cases) {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-winbounds-bad-'));
    try {
      const file = JSON.stringify({
        schemaVersion: 1,
        settings: { launcherHotkey: 'Ctrl+Shift+M', logRetentionDays: 14, maxLogBytesPerApp: 10485760, recycle: { enabled: false, defaultMinutes: 0, exemptAppIds: [], notify: false } },
        apps: { sample: { enabled: true, favorite: false, addedAt: '2026-01-01T00:00:00.000Z', useCount: 0, winBounds } },
      });
      fs.writeFileSync(path.join(data, 'host-state.json'), file);
      const run = script => spawnSync(process.execPath, ['-e', `const s=require(${JSON.stringify(output)}); ${script}`], { env: { ...process.env, MINI_DATA_DIR: data }, encoding: 'utf8' });
      // 加载即旁路:默认只读状态,元数据为空;同进程内 setWinBounds 走 warn 不抛、不写入
      const script = 's.initState(); if(s.meta("sample")) process.exit(2); s.setWinBounds("sample2",{x:1,y:1,width:10,height:10}); if(s.meta("sample2")) process.exit(3);';
      const result = run(script);
      assert.equal(result.status, 0, `${label}: ${result.stderr}`);
      assert.ok(fs.readdirSync(data).some(n => n.endsWith('.corrupt')), label);
      assert.equal(fs.existsSync(path.join(data, 'host-state.json')), false, label);
    } finally { fs.rmSync(data, { recursive: true, force: true }); }
  }
});
