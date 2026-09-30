// 参数取值链单测：per-run override > preset > lastUsed > default，
// 以及 required 缺值的 missing 判定（触发「必填无值必弹表单」）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const engine = require('./helpers.cjs');
const { resolveParams } = engine;

const defs = {
  dir: { label: '目录', type: 'string', default: 'D:/Downloads', required: true },
  mode: { type: 'select', options: ['work', 'personal'], default: 'work' },
  verbose: { type: 'boolean', default: false },
  count: { type: 'number' },
  must: { type: 'string', required: true },
};

test('四层覆盖顺序：override > preset > lastUsed > default', () => {
  const all = resolveParams(defs, {
    override: { dir: 'O' }, preset: { dir: 'P', mode: 'P' }, lastUsed: { dir: 'L', mode: 'L', verbose: true },
  });
  assert.equal(all.values.dir, 'O');
  assert.equal(all.values.mode, 'P');
  assert.equal(all.values.verbose, true);
  assert.equal(all.values.count, undefined);
  assert.deepEqual(all.missing, ['must']);
});

test('逐层回退：preset / lastUsed / default 各自独立生效', () => {
  assert.equal(resolveParams(defs, { preset: { dir: 'P' } }).values.dir, 'P');
  assert.equal(resolveParams(defs, { lastUsed: { dir: 'L' } }).values.dir, 'L');
  const none = resolveParams(defs, {});
  assert.equal(none.values.dir, 'D:/Downloads');
  assert.equal(none.values.mode, 'work');
  assert.equal(none.values.verbose, false);
});

test('null 与 undefined 都视为无值（storage 读回的 null 不可用）', () => {
  const r = resolveParams(defs, { override: { dir: null }, lastUsed: { verbose: null } });
  assert.equal(r.values.dir, 'D:/Downloads');
  assert.equal(r.values.verbose, false);
});

test('missing：required 且四层皆无值才列出；有默认值的必填不算缺', () => {
  const r = resolveParams(defs, {});
  assert.deepEqual(r.missing, ['must']);
  const filled = resolveParams(defs, { override: { must: 'x' } });
  assert.deepEqual(filled.missing, []);
});

test('非必填且无默认：不写 key（表达式引用得到 undefined）', () => {
  const r = resolveParams(defs, {});
  assert.ok(!('count' in r.values));
});
