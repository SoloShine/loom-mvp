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
