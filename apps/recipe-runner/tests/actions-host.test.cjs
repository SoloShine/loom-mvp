// host 直通动作单测：fake host 注入走同一条路径。
// 覆盖：参数映射与边界拒绝、process.run（stdout 行收集 / exitCode /
// 取消杀进程）、dry-run 分类表（对照 design.md 语义表逐动作）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const actions = require('./helpers.actions.cjs');

const { buildHostActions } = actions;

function makeFakeHost() {
  const calls = [];
  const rec = (svc, method, impl) => (...args) => {
    calls.push([svc, method, ...args]);
    return Promise.resolve(impl ? impl(...args) : null);
  };
  const stdoutQueue = [];
  const handle = {
    pid: 4242,
    killed: false,
    exitCode: 0,
    _exitCbs: [],
    _outCbs: [],
    _errCbs: [],
    stdout(cb) { this._outCbs.push(cb); return () => {}; },
    stderr(cb) { this._errCbs.push(cb); return () => {}; },
    onExit(cb) { this._exitCbs.push(cb); return () => {}; },
    write: async () => {},
    kill: async function () { this.killed = true; },
    wait() { return new Promise((r) => this._exitCbs.push((c) => r(c))); },
    // 测试驱动：模拟子进程行为
    emit(lines, code) {
      for (const l of lines) {
        for (const cb of this._outCbs) cb(l);
      }
      for (const cb of this._exitCbs) cb(code);
    },
  };
  const fake = {
    calls,
    handle,
    clipboard: { readText: rec('clipboard', 'readText', () => 'clip-text'), writeText: rec('clipboard', 'writeText') },
    files: {
      read: rec('files', 'read', () => 'file-body'),
      write: rec('files', 'write'),
      copy: rec('files', 'copy'),
      move: rec('files', 'move'),
      remove: rec('files', 'remove'),
      selectFile: rec('files', 'selectFile', () => 'D:/x/y.txt'),
      selectDirectory: rec('files', 'selectDirectory', () => null),
    },
    screen: {
      capture: rec('screen', 'capture', () => ({ dataUrl: 'data:image/png;base64,x', width: 8, height: 6 })),
      captureRegion: rec('screen', 'captureRegion', () => ({ dataUrl: 'data:image/png;base64,r', width: 2, height: 2 })),
      selectRegion: rec('screen', 'selectRegion', () => ({ x: 1, y: 2, width: 3, height: 4 })),
      getMonitors: rec('screen', 'getMonitors', () => []),
    },
    mouse: {
      position: rec('mouse', 'position', () => ({ x: 10, y: 20 })),
      move: rec('mouse', 'move'),
      click: rec('mouse', 'click'),
      doubleClick: rec('mouse', 'doubleClick'),
    },
    keyboard: { press: rec('keyboard', 'press'), hotkey: rec('keyboard', 'hotkey'), type: rec('keyboard', 'type') },
    notification: { show: rec('notification', 'show') },
    log: { info: rec('log', 'info'), warn: rec('log', 'warn'), error: rec('log', 'error') },
    process: { spawn: rec('process', 'spawn', () => handle) },
  };
  return fake;
}

const ctx = { dryRun: false };

test('参数映射：clipboard / files / notification 直通', async () => {
  const fake = makeFakeHost();
  const t = buildHostActions(fake);

  assert.equal(await t['clipboard.readText'].run({}, ctx), 'clip-text');
  await t['clipboard.writeText'].run({ text: 'T' }, ctx);
  assert.equal(await t['files.read'].run({ path: 'D:/a.txt' }, ctx), 'file-body');
  await t['notification.show'].run({ title: 'T', body: 'B' }, ctx);
  assert.deepEqual(fake.calls.find((c) => c[0] === 'notification'), ['notification', 'show', { title: 'T', body: 'B' }]);
  assert.deepEqual(fake.calls.find((c) => c[0] === 'clipboard' && c[1] === 'writeText'), ['clipboard', 'writeText', 'T']);
});

test('参数边界拒绝：缺 path/text/坐标 → 中文错误', async () => {
  const t = buildHostActions(makeFakeHost());
  await assert.rejects(t['files.read'].run({}, ctx), /path/);
  await assert.rejects(t['clipboard.writeText'].run({ text: '' }, ctx), /text/);
  await assert.rejects(t['mouse.move'].run({ x: 'a', y: 1 }, ctx), /x/);
  await assert.rejects(t['screen.captureRegion'].run({ rect: { x: 0, y: 0, width: 1 } }, ctx), /rect/);
  await assert.rejects(t['keyboard.hotkey'].run({ keys: 'ctrl' }, ctx), /keys/);
});

test('mouse.click 缺省左键；screen.selectRegion 透传', async () => {
  const fake = makeFakeHost();
  const t = buildHostActions(fake);
  await t['mouse.click'].run({ x: 5, y: 6 }, ctx);
  assert.deepEqual(fake.calls.find((c) => c[0] === 'mouse' && c[1] === 'click'), ['mouse', 'click', 5, 6, 'left']);
  assert.deepEqual(await t['screen.selectRegion'].run({}, ctx), { x: 1, y: 2, width: 3, height: 4 });
  // files.selectDirectory 取消返回 null（不是错误——recipe 可 when 判空）
  assert.equal(await t['files.selectDirectory'].run({}, ctx), null);
});

test('process.run：stdout 行收集 + exitCode 为 out；非零退出码不报错', async () => {
  const fake = makeFakeHost();
  const t = buildHostActions(fake);
  const p = t['process.run'].run({ command: 'node', args: ['x.js'] }, ctx);
  setTimeout(() => fake.handle.emit(['line1', 'line2'], 3), 10);
  const out = await p;
  assert.deepEqual(out, { exitCode: 3, stdout: 'line1\nline2', stderr: '' });
  assert.deepEqual(fake.calls.find((c) => c[0] === 'process'), ['process', 'spawn', { command: 'node', args: ['x.js'] }]);
});

test('process.run：signal 取消 → 杀子进程并以「已取消」拒绝（engine 归因 cancelled）', async () => {
  const fake = makeFakeHost();
  const t = buildHostActions(fake);
  const ac = new AbortController();
  const p = t['process.run'].run({ command: 'sleep' }, { dryRun: false, signal: ac.signal });
  setTimeout(() => ac.abort(), 15);
  await assert.rejects(p, /已取消/);
  assert.equal(fake.handle.killed, true, '取消应杀掉子进程');
});

test('process.run：env 规整（非字符串值转字符串、空值剔除）', async () => {
  const fake = makeFakeHost();
  const t = buildHostActions(fake);
  const p = t['process.run'].run({ command: 'c', env: { A: 1, B: null, C: 'x' } }, ctx);
  setTimeout(() => fake.handle.emit([], 0), 5);
  await p;
  assert.deepEqual(fake.calls.find((c) => c[0] === 'process')[2], { command: 'c', env: { A: '1', C: 'x' } });
});

// design.md dry-run 语义表逐动作断言（mutating=skip、reading/interactive=
// real、notify=real+标记）
const CATEGORY_TABLE = {
  'clipboard.readText': 'reading',
  'clipboard.writeText': 'mutating',
  'files.read': 'reading',
  'files.write': 'mutating',
  'files.copy': 'mutating',
  'files.move': 'mutating',
  'files.remove': 'mutating',
  'files.selectFile': 'interactive',
  'files.selectDirectory': 'interactive',
  'screen.capture': 'reading',
  'screen.captureRegion': 'reading',
  'screen.selectRegion': 'interactive',
  'screen.getMonitors': 'reading',
  'mouse.position': 'reading',
  'mouse.move': 'mutating',
  'mouse.click': 'mutating',
  'mouse.doubleClick': 'mutating',
  'keyboard.press': 'mutating',
  'keyboard.hotkey': 'mutating',
  'keyboard.type': 'mutating',
  'notification.show': 'notify',
  'log': 'reading',
  'process.run': 'mutating',
};

test('dry-run 分类表：逐动作对照 design.md 语义表', () => {
  const t = buildHostActions(makeFakeHost());
  for (const [name, expected] of Object.entries(CATEGORY_TABLE)) {
    const def = t[name];
    assert.ok(def, `动作缺失: ${name}`);
    assert.equal(def.category, expected, `${name} 应为 ${expected}`);
  }
});

test('log：level 分派', async () => {
  const fake = makeFakeHost();
  const t = buildHostActions(fake);
  await t['log'].run({ msg: 'm1' }, ctx);
  await t['log'].run({ msg: 'm2', level: 'warn' }, ctx);
  await t['log'].run({ msg: 'm3', level: 'error' }, ctx);
  assert.deepEqual(
    fake.calls.filter((c) => c[0] === 'log').map((c) => c[1]),
    ['info', 'warn', 'error'],
  );
});
