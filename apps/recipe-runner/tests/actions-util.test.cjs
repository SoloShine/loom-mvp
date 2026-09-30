// util 动作单测：fs.list（临时目录）、text/json 变换、delay（含取消）、
// http.request（不可达端口 / 挂起服务器的超时）、js.eval（scope 上下文与
// async）、glob 简化版。不依赖网络与 Host。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const actions = require('./helpers.actions.cjs');

const { buildUtilActions, globToRegExp } = actions;
const table = buildUtilActions();
const run = (name, args, ctx = {}) => table[name].run(args, ctx);
const ctxWithScope = (scope) => ({ dryRun: false, scope });

test('fs.list：顶层文件、filter glob、字段形状（正斜杠路径）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-fslist-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
    fs.writeFileSync(path.join(dir, 'b.PDF'), 'x');
    fs.writeFileSync(path.join(dir, 'c.md'), 'y');
    fs.mkdirSync(path.join(dir, 'subdir'));

    const all = await run('fs.list', { dir });
    assert.deepEqual(all.map((f) => f.name), ['a.txt', 'b.PDF', 'c.md']); // 子目录不算
    assert.equal(all[0].stem, 'a');
    assert.equal(all[0].ext, '.txt');
    assert.equal(all[0].size, 5);
    assert.equal(typeof all[0].mtimeMs, 'number');
    assert.ok(!all[0].path.includes('\\'), `路径须为正斜杠形式: ${all[0].path}`);
    assert.ok(all[0].path.endsWith('/a.txt'));

    const pdf = await run('fs.list', { dir, filter: '*.pdf' });
    assert.deepEqual(pdf.map((f) => f.name), ['b.PDF']); // 大小写不敏感（Windows）

    const single = await run('fs.list', { dir, filter: '?.txt' });
    assert.deepEqual(single.map((f) => f.name), ['a.txt']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fs.list：目录不存在 → 报错（错误即停）', async () => {
  await assert.rejects(run('fs.list', { dir: path.join(os.tmpdir(), `nope-${Date.now()}`) }), /ENOENT|不存在/);
});

test('globToRegExp：字面量转义 + 通配', () => {
  assert.ok(globToRegExp('*.pdf').test('x.PDF'));
  assert.ok(!globToRegExp('*.pdf').test('x.pdf.bak'));
  assert.ok(globToRegExp('a(b).txt').test('a(b).txt'));
  assert.ok(!globToRegExp('a(b).txt').test('ab.txt'));
});

test('text.match：首匹配 / all / 无匹配为 null', async () => {
  assert.equal(await run('text.match', { text: 'a 12 b 34', pattern: '\\d+' }), '12');
  assert.deepEqual(await run('text.match', { text: 'a 12 b 34', pattern: '\\d+', all: true }), ['12', '34']);
  assert.equal(await run('text.match', { text: 'abc', pattern: '\\d+' }), null);
  await assert.rejects(run('text.match', { text: 'x', pattern: '(' }), /正则|Invalid/);
});

test('text.replace：缺省全局替换 + $1 反向引用 + flags 透传', async () => {
  assert.equal(await run('text.replace', { text: 'a-b-c', pattern: '-', replacement: '+' }), 'a+b+c');
  assert.equal(await run('text.replace', { text: 'k=v', pattern: '(\\w)=(\\w)', replacement: '$2=$1' }), 'v=k');
  assert.equal(await run('text.replace', { text: 'aA', pattern: 'a', replacement: 'X', flags: '' }), 'XA');
});

test('json.parse：合法 / 非法报错', async () => {
  assert.deepEqual(await run('json.parse', { text: '{"a":[1,2]}' }), { a: [1, 2] });
  await assert.rejects(run('json.parse', { text: '{oops' }));
});

test('delay：按时长完成；signal 中断即刻拒绝', async () => {
  const t0 = Date.now();
  await run('delay', { ms: 60 });
  assert.ok(Date.now() - t0 >= 55);

  const ac = new AbortController();
  const p = run('delay', { ms: 10_000 }, { dryRun: false, signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  const t1 = Date.now();
  await assert.rejects(p, /已取消/);
  assert.ok(Date.now() - t1 < 2_000, '取消应立即生效');
  await assert.rejects(run('delay', { ms: -1 }), /ms/);
});

test('delay：timeoutMs 声明为极大值（上限交由剩余 run 预算，design FAQ）', () => {
  assert.ok(table.delay.timeoutMs >= Number.MAX_SAFE_INTEGER - 1);
});

test('http.request：连接被拒（不可达端口）走错误路径', async () => {
  // 端口 1（tcpmux）本机几乎必然无监听
  await assert.rejects(
    run('http.request', { url: 'http://127.0.0.1:1/', timeoutMs: 1500 }),
    (e) => /ECONNREFUSED|fetch failed|aborted/i.test(e.message),
  );
});

test('http.request：对挂起服务器按 timeoutMs 超时', async () => {
  const server = http.createServer(() => { /* 永不响应 */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const t0 = Date.now();
    await assert.rejects(
      run('http.request', { url: `http://127.0.0.1:${port}/hang`, timeoutMs: 250 }),
      (e) => /aborted|Timeout|timeout|时间/i.test(e.message),
    );
    assert.ok(Date.now() - t0 < 3_000, '应在 timeoutMs 附近失败');
  } finally {
    server.close();
  }
});

test('http.request：GET 正常路径（本地 echo）', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ got: req.url, method: req.method }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const out = await run('http.request', { url: `http://127.0.0.1:${port}/x?y=1` });
    assert.equal(out.status, 200);
    assert.equal(out.ok, true);
    assert.deepEqual(JSON.parse(out.body), { got: '/x?y=1', method: 'GET' });
    assert.equal(out.headers['content-type'], 'application/json');
  } finally {
    server.close();
  }
});

test('js.eval：上下文同表达式（params/steps/env/循环变量），async 与 Promise.all 可用', async () => {
  const scope = {
    params: { x: 2 },
    steps: { s: { out: [1, 2, 3] } },
    env: { now: 42 },
    vars: { item: 'z' },
  };
  assert.equal(await run('js.eval', { code: 'params.x * 3' }, ctxWithScope(scope)), 6);
  assert.equal(await run('js.eval', { code: 'item + env.now' }, ctxWithScope(scope)), 'z42');
  assert.deepEqual(
    await run('js.eval', { code: 'steps.s.out.map(v => v * params.x)' }, ctxWithScope(scope)),
    [2, 4, 6],
  );
  // 并发只允许存在于单个动作内部（design FAQ）：Promise.all 在 js.eval 里成立
  assert.deepEqual(
    await run('js.eval', { code: 'Promise.all([1,2].map(async v => v * 10))' }, ctxWithScope(scope)),
    [10, 20],
  );
  // async 包装允许表达式位的 await
  assert.equal(await run('js.eval', { code: '(await Promise.resolve(7)) + 1' }, ctxWithScope(scope)), 8);
});

test('js.eval：缺 scope 报错；运行错误透传', async () => {
  await assert.rejects(run('js.eval', { code: '1' }), /上下文/);
  await assert.rejects(run('js.eval', { code: 'nope.xyz' }, ctxWithScope({ params: {}, steps: {}, env: { now: 0 }, vars: {} })), /nope/);
});

test('util 动作 dry-run 分类全部 reading（照真执行）', () => {
  for (const [name, def] of Object.entries(table)) {
    assert.equal(def.category, 'reading', `${name} 应为 reading`);
  }
});
