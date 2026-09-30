// ui-logic 单测：schema→form 字段值处理 / required 校验 / preset 操作 /
// 轨迹行分组与声明叠加 / 展示格式化（含 __truncated）。纯函数层，不触
// react / DOM / host——React 组件本身不测（无先例不引测试框架）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  seedFormValues, valueToInput, finalizeFormValues, validateFields,
  savePreset, deletePreset, listPresets,
  groupTraceSteps, linearizeSteps, pendingSteps, topLevelSteps,
  formatOutValue, formatMs, formatTime,
} = require('./helpers.ui.cjs');

// ---------------------------------------------------------------------------
// schema→form 字段值
// ---------------------------------------------------------------------------

test('seedFormValues：预填 > 字段默认 > 类型空位', () => {
  const fields = [
    { name: 'dir', type: 'string', default: 'D:\\Downloads', required: true },
    { name: 'n', type: 'number' },
    { name: 'flag', type: 'boolean' },
    { name: 'mode', type: 'select', options: ['work', 'personal'] },
  ];
  // 全空：回落默认值 / 类型空位（select 取首项；number 无值 = 不落 key）
  assert.deepEqual(seedFormValues(fields), {
    dir: 'D:\\Downloads', flag: false, mode: 'work',
  });
  // 预填覆盖（lastUsed/preset 在 main 侧已折进 prefill）
  assert.deepEqual(seedFormValues(fields, { dir: 'E:\\X', n: 3, flag: true, mode: 'personal' }), {
    dir: 'E:\\X', n: 3, flag: true, mode: 'personal',
  });
  // 部分预填：只覆盖给出的
  assert.equal(seedFormValues(fields, { n: 0 }).n, 0);
});

test('valueToInput：unknown → 输入框展示串', () => {
  assert.equal(valueToInput(undefined), '');
  assert.equal(valueToInput(null), '');
  assert.equal(valueToInput(7), '7');
  assert.equal(valueToInput('x'), 'x');
  assert.equal(valueToInput(''), '');
});

test('finalizeFormValues：number 编辑期原始串提交前定型', () => {
  const fields = [
    { name: 'n', type: 'number' },
    { name: 's', type: 'string' },
    { name: 'b', type: 'boolean' },
  ];
  assert.deepEqual(finalizeFormValues(fields, { n: '42', s: 'a', b: true }), { n: 42, s: 'a', b: true });
  assert.equal(finalizeFormValues(fields, { n: '' }).n, undefined);      // 空串 = 未填
  assert.equal(finalizeFormValues(fields, { n: 'abc' }).n, undefined);   // 非有限数 = 未填
  assert.equal(finalizeFormValues(fields, { n: ' 7 ' }).n, 7);           // 容忍空白
});

test('validateFields：required 缺失（含空数字输入），boolean false 是有效值', () => {
  const fields = [
    { name: 'dir', label: '目录', type: 'string', required: true },
    { name: 'n', type: 'number', required: true },
    { name: 'flag', type: 'boolean', required: true },
    { name: 'opt', type: 'string' },
  ];
  assert.deepEqual(validateFields(fields, { dir: '', n: '', flag: false }), ['目录', 'n']);
  assert.deepEqual(validateFields(fields, { dir: 'D:\\X', n: '5', flag: false }), []);
  assert.deepEqual(validateFields(fields, { dir: 'D:\\X', n: 'zz', flag: true }), ['n']);
});

// ---------------------------------------------------------------------------
// presets
// ---------------------------------------------------------------------------

test('savePreset：名字 trim、空名抛错、同名覆盖；deletePreset 删除；listPresets 排序', () => {
  const presets = savePreset({}, 'work', { dir: 'D:\\W' });
  assert.deepEqual(presets, { work: { dir: 'D:\\W' } });
  assert.deepEqual(savePreset(presets, '  personal  ', { dir: 'D:\\P' }), {
    work: { dir: 'D:\\W' }, personal: { dir: 'D:\\P' },
  });
  // 覆盖同名
  assert.deepEqual(savePreset(presets, 'work', { dir: 'D:\\W2' }).work, { dir: 'D:\\W2' });
  assert.throws(() => savePreset(presets, '   ', {}), /preset 名不能为空/);
  const two = savePreset(presets, 'personal', { dir: 'D:\\P' });
  assert.deepEqual(deletePreset(two, 'work'), { personal: { dir: 'D:\\P' } });
  assert.deepEqual(deletePreset(two, '不存在'), two); // 无此名 = 原样
  // listPresets 按名排序（确定性）
  assert.deepEqual(listPresets(two).map((p) => p.name), ['personal', 'work']);
});

// ---------------------------------------------------------------------------
// 轨迹行：分组 / 线性化 / pending 叠加 / 重跑入口
// ---------------------------------------------------------------------------

const traceOf = (rows) => rows.map(([id, action, iter]) => ({
  id, action, args: {}, status: 'ok', ms: 1, ...(iter === undefined ? {} : { iter }),
}));

test('groupTraceSteps：for 容器行收录其后带 iter 的子步骤，遇顶层步骤结束分组', () => {
  const steps = traceOf([
    ['a', 'fs.list'],
    ['loop', 'for'],
    ['one', 'files.move', 0],
    ['one', 'files.move', 1],
    ['done', 'notification.show'],
  ]);
  const rows = groupTraceSteps(steps);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].kind, 'step');
  assert.equal(rows[1].kind, 'container');
  assert.deepEqual(rows[1].children.map((c) => c.iter), [0, 1]);
  assert.equal(rows[2].kind, 'step');
  assert.equal(rows[2].step.id, 'done');
});

test('groupTraceSteps：不带 iter 的占位行（markRemaining）作顶层行，不入容器', () => {
  const steps = traceOf([
    ['loop', 'for'],
    ['one', 'files.move', 0],
    ['after', 'delay'],            // 顶层步骤关闭分组
    ['skipped-child', 'files.move'], // 无 iter 的跳过占位
  ]);
  const rows = groupTraceSteps(steps);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].children.length, 1);
  assert.equal(rows[2].step.id, 'skipped-child');
});

test('linearizeSteps / pendingSteps / topLevelSteps', () => {
  const declared = [
    { id: 'a', action: 'fs.list' },
    { id: 'loop', for: { times: 2 }, steps: [{ id: 'one', action: 'files.move' }] },
    { id: 'done', action: 'notification.show' },
  ];
  assert.deepEqual(linearizeSteps(declared).map((s) => s.id), ['a', 'loop', 'one', 'done']);
  // 在途：只跑了 a 与 loop 容器（含首个迭代）→ one 已出现，done 待运行
  const trace = [...traceOf([['a', 'fs.list'], ['loop', 'for'], ['one', 'files.move', 0]])];
  assert.deepEqual(pendingSteps(declared, trace).map((s) => s.id), ['done']);
  // 重跑入口：仅顶层，for 容器显示为 "for"
  assert.deepEqual(topLevelSteps(declared), [
    { id: 'a', action: 'fs.list' }, { id: 'loop', action: 'for' }, { id: 'done', action: 'notification.show' },
  ]);
});

// ---------------------------------------------------------------------------
// 展示格式化
// ---------------------------------------------------------------------------

test('formatOutValue：__truncated 显示 byteLength+preview，正常值限长', () => {
  const truncated = { __truncated: true, byteLength: 99999, preview: '{"img":"data:image/png;base64,AAA' };
  assert.equal(formatOutValue(truncated), '(截断 99999B) {"img":"data:image/png;base64,AAA…');
  assert.equal(formatOutValue('plain'), 'plain');
  assert.equal(formatOutValue({ a: 1 }), '{"a":1}');
  assert.equal(formatOutValue(undefined), '');
  const long = 'x'.repeat(600);
  assert.equal(formatOutValue(long).length, 501); // 500 + 省略号
  assert.equal(formatOutValue(long, 10).length, 11); // 自定义上限
});

test('formatMs / formatTime', () => {
  assert.equal(formatMs(0), '0ms');
  assert.equal(formatMs(940), '940ms');
  assert.equal(formatMs(1250), '1.3s');
  assert.equal(formatMs(90_500), '1m31s');
  assert.match(formatTime(new Date(2026, 0, 2, 3, 4, 5).getTime()), /^03:04:05$/);
});
