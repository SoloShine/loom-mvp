// ui 动作单测：fake showForm 网关。覆盖 ask 字段规整与 required 兜底、
// confirm / menu 的「用户取消 = 错误即停」、interactive 分类。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const actions = require('./helpers.actions.cjs');

const { buildUiActions } = actions;

function gateway(result) {
  const payloads = [];
  const showForm = async (payload, signal) => {
    payloads.push({ payload, signal });
    if (result instanceof Error) throw result;
    if (typeof result === 'function') return result(payload);
    return result;
  };
  return { payloads, showForm };
}

const ctx = { dryRun: false };

test('ui.ask：fields 规整为协议字段数组，返回值即 out', async () => {
  const gw = gateway({ name: 'loom', count: 3 });
  const t = buildUiActions(gw.showForm);
  const out = await t['ui.ask'].run({
    title: '参数',
    fields: {
      name: { type: 'string', label: '名称', required: true },
      count: { type: 'number' },
      mode: { type: 'select', options: ['a', { value: 'b', label: 'B' }] },
    },
  }, ctx);
  assert.deepEqual(out, { name: 'loom', count: 3 });
  const sent = gw.payloads[0].payload;
  assert.equal(sent.kind, 'ask');
  assert.equal(sent.title, '参数');
  assert.deepEqual(sent.fields.map((f) => f.name), ['name', 'count', 'mode']);
  assert.equal(sent.fields[0].required, true);
  assert.deepEqual(sent.fields[2].options, ['a', { value: 'b', label: 'B' }]);
});

test('ui.ask：空 fields / 非法声明 / required 缺值兜底 → 报错', async () => {
  const gw = gateway({ n: '' });
  const t = buildUiActions(gw.showForm);
  await assert.rejects(t['ui.ask'].run({}, ctx), /fields/);
  await assert.rejects(t['ui.ask'].run({ fields: { x: { type: 'json' } } }, ctx), /type/);
  await assert.rejects(
    t['ui.ask'].run({ fields: { x: { type: 'string', required: true } } }, ctx),
    /必填字段缺失/,
  );
});

test('ui.confirm：确定 → true；取消（含网关拒绝）→ 错误即停', async () => {
  const ok = buildUiActions(gateway(true).showForm);
  assert.equal(await ok['ui.confirm'].run({ title: 'T', body: 'B' }, ctx), true);

  const cancelled = buildUiActions(gateway(false).showForm);
  await assert.rejects(cancelled['ui.confirm'].run({ title: 'T' }, ctx), /用户取消/);

  const aborted = buildUiActions(gateway(new Error('已取消')).showForm);
  await assert.rejects(aborted['ui.confirm'].run({ title: 'T' }, ctx), /已取消/);
});

test('ui.menu：选中值即 out；取消 → 错误即停；items 规整', async () => {
  const gw = gateway('b');
  const t = buildUiActions(gw.showForm);
  const out = await t['ui.menu'].run({ title: '选', items: ['a', { value: 'b', label: 'B 项' }] }, ctx);
  assert.equal(out, 'b');
  assert.deepEqual(gw.payloads[0].payload.items, [{ value: 'a' }, { value: 'b', label: 'B 项' }]);

  await assert.rejects(t['ui.menu'].run({ items: [] }, ctx), /items/);
  await assert.rejects(t['ui.menu'].run({ items: [42] }, ctx), /items/);
  const cancelGw = gateway(null);
  await assert.rejects(
    buildUiActions(cancelGw.showForm)['ui.menu'].run({ items: ['x'] }, ctx),
    /用户取消/,
  );
});

test('ui 动作全部 interactive 类（120s 档超时由 engine 缺省给）', () => {
  const t = buildUiActions(gateway(true).showForm);
  for (const [name, def] of Object.entries(t)) {
    assert.equal(def.category, 'interactive', `${name}`);
    assert.equal(def.timeoutMs, undefined);
  }
});

test('网关收到 signal 透传（表单等待可被 stop 中断）', async () => {
  const gw = gateway(true);
  const sig = new AbortController().signal;
  await buildUiActions(gw.showForm)['ui.confirm'].run({ title: 't' }, { dryRun: false, signal: sig });
  assert.equal(gw.payloads[0].signal, sig);
});
