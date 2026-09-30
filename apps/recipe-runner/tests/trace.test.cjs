// trace 单测：out 4KB 截断（记原始长度 + 前缀摘要）、runs 环形保留 10 次。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const engine = require('./helpers.cjs');
const { truncateOut, isTruncatedOut, pushRun, OUT_MAX_BYTES, MAX_KEPT_RUNS } = engine;

test('小值原样保留（引用相等，非拷贝）', () => {
  const v = { a: [1, 2, 3], s: 'x' };
  assert.equal(truncateOut(v), v);
  assert.equal(truncateOut('short'), 'short');
  assert.equal(truncateOut(42), 42);
  assert.equal(truncateOut(null), null);
  assert.equal(isTruncatedOut(truncateOut(v)), false);
});

test('超 4KB 字符串截断：记原始字节数与 200 字符前缀摘要', () => {
  const big = 'x'.repeat(OUT_MAX_BYTES + 100);
  const out = truncateOut(big);
  assert.equal(isTruncatedOut(out), true);
  assert.ok(out.byteLength > OUT_MAX_BYTES);
  assert.equal(out.preview.length, 200);
  // 序列化串含 JSON 引号定界；字符串值的前缀即 x 本身
  assert.ok(out.preview.startsWith('"x'));
});

test('超限对象/数组同样截断；中文按 UTF-8 字节计', () => {
  const arr = Array.from({ length: 1000 }, (_, i) => ({ i, pad: 'p'.repeat(20) }));
  const out = truncateOut(arr);
  assert.equal(isTruncatedOut(out), true);
  assert.match(out.preview, /^\[\{"i":0/);

  // 5000 个三字节汉字 = 15000 字节 > 4096
  const zh = '汉'.repeat(5000);
  const zhOut = truncateOut(zh);
  assert.equal(isTruncatedOut(zhOut), true);
  assert.ok(zhOut.byteLength >= 15000);
  // 4KB 以内（含边界附近的多字节串）不截断
  const zhOk = '汉'.repeat(1000); // 3000 字节
  assert.equal(truncateOut(zhOk), zhOk);
});

test('pushRun 环形保留：只留最近 N 次，顺序保持', () => {
  const mk = (i) => ({ runId: `r${i}`, recipeId: 'd', startedAt: i, dryRun: false, status: 'ok', steps: [], ms: 1 });
  let runs = [];
  for (let i = 0; i < 12; i++) runs = pushRun(runs, mk(i));
  assert.equal(runs.length, MAX_KEPT_RUNS);
  assert.equal(runs[0].runId, 'r2');
  assert.equal(runs.at(-1).runId, 'r11');

  const custom = pushRun([mk(1), mk(2)], mk(3), 2);
  assert.deepEqual(custom.map((r) => r.runId), ['r2', 'r3']);
});
