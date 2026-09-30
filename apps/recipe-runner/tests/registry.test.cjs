// registry（编排纯函数）单测：扫描解析（invalid 不阻塞 / id 与文件名一致 /
// 排序确定性）、热键计划（先到先得 + 冲突）、热键增量 diff、params 表单
// 字段构建（取值链预填）、outsFromRun、nextRunId。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const registry = require('./helpers.registry.cjs');

const {
  scanRecipes, planHotkeys, diffHotkeys, buildParamFields, outsFromRun, nextRunId,
} = registry;

const okYaml = (id, extra = '') => `
id: ${id}
steps:
  - id: a
    action: delay
    args: { ms: 1 }
${extra}`;

test('scanRecipes：有效条目解析出 recipe；按 id 排序保证热键确定性', () => {
  const entries = scanRecipes([
    { file: 'zeta.yaml', text: okYaml('zeta') },
    { file: 'alpha.yaml', text: okYaml('alpha') },
  ]);
  assert.deepEqual(entries.map((e) => e.id), ['alpha', 'zeta']);
  assert.ok(entries[0].ok);
  assert.equal(entries[0].recipe.id, 'alpha');
  assert.equal(entries[0].hotkeyState, 'none');
});

test('scanRecipes：YAML/schema 错误记入该条目，不阻塞其它', () => {
  const entries = scanRecipes([
    { file: 'bad.yaml', text: 'id: [unclosed' },
    { file: 'noschema.yaml', text: 'id: x\nsteps: []' },
    { file: 'good.yaml', text: okYaml('good') },
  ]);
  const bad = entries.find((e) => e.id === 'bad');
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length > 0);
  assert.equal(entries.find((e) => e.id === 'noschema').ok, false);
  assert.equal(entries.find((e) => e.id === 'good').ok, true);
});

test('scanRecipes：id 与文件名不一致 → invalid（寻址键 = 文件名 stem）', () => {
  const entries = scanRecipes([{ file: 'named.yaml', text: okYaml('other') }]);
  assert.equal(entries[0].id, 'named');
  assert.equal(entries[0].ok, false);
  assert.match(entries[0].errors[0], /other.*named|named.*other/);
});

test('planHotkeys：先到先得，同 combo 后到者（排序后）标冲突不抢占', () => {
  const entries = scanRecipes([
    { file: 'a.yaml', text: okYaml('a', 'hotkey: Ctrl+Alt+R') },
    { file: 'b.yaml', text: okYaml('b', 'hotkey: Ctrl+Alt+R') },
    { file: 'c.yaml', text: okYaml('c', 'hotkey: Ctrl+Alt+S') },
    { file: 'd.yaml', text: 'id: [broken' },
  ]);
  const { desired, conflicts } = planHotkeys(entries);
  assert.equal(desired.get('Ctrl+Alt+R'), 'a');
  assert.equal(desired.get('Ctrl+Alt+S'), 'c');
  assert.equal(desired.size, 2);
  assert.match(conflicts.b, /Ctrl\+Alt\+R 与 a 冲突/);
  assert.equal(conflicts.d, undefined, 'invalid 条目不参与热键');
});

test('diffHotkeys：owner 变更 / 移除 / 新增 / 不变', () => {
  const registered = new Map([
    ['Ctrl+Alt+R', 'a'],
    ['Ctrl+Alt+X', 'gone'],
    ['Ctrl+Alt+K', 'keep'],
  ]);
  const desired = new Map([
    ['Ctrl+Alt+R', 'b'],   // owner 变更：注销 + 重注册
    ['Ctrl+Alt+K', 'keep'], // 不动
    ['Ctrl+Alt+N', 'new'], // 新注册
  ]);
  const diff = diffHotkeys(registered, desired);
  assert.deepEqual(diff.unregister.sort(), ['Ctrl+Alt+R', 'Ctrl+Alt+X']);
  assert.deepEqual(diff.register, [
    { combo: 'Ctrl+Alt+R', recipeId: 'b' },
    { combo: 'Ctrl+Alt+N', recipeId: 'new' },
  ]);
});

test('buildParamFields：声明顺序、取值链当前值优先于 default、required/options 透传', () => {
  const defs = {
    dir: { type: 'string', label: '目录', required: true, default: 'D:/Downloads' },
    n: { type: 'number' },
    fast: { type: 'boolean' },
    mode: { type: 'select', options: ['work', { value: 'home', label: '家' }] },
  };
  const fields = buildParamFields(defs, { dir: 'D:/Docs', mode: 'home' });
  assert.deepEqual(fields.map((f) => f.name), ['dir', 'n', 'fast', 'mode']);
  assert.equal(fields[0].default, 'D:/Docs');  // 取值链当前值预填
  assert.equal(fields[0].required, true);
  assert.equal(fields[1].default, undefined);  // 无值不写 key
  assert.equal(fields[2].default, undefined);
  assert.deepEqual(fields[3].options, ['work', { value: 'home', label: '家' }]);
  // 全空时按声明 default 预填
  const empty = buildParamFields(defs, {});
  assert.equal(empty[0].default, 'D:/Downloads');
});

test('outsFromRun：ok/replayed 且有 out 的步骤；循环子步骤末次迭代胜出；skipped/error 不取', () => {
  const record = {
    runId: 'r', recipeId: 'r', startedAt: 0, dryRun: false,
    status: 'ok', ms: 1,
    steps: [
      { id: 'list', action: 'fs.list', args: {}, status: 'ok', ms: 1, out: [{ name: 'a' }] },
      { id: 'skip', action: 'delay', args: {}, status: 'skipped', ms: 0 },
      { id: 'err', action: 'x', args: {}, status: 'error', ms: 0, error: 'e' },
      { id: 'one', action: 'files.move', args: {}, status: 'ok', ms: 1, iter: 0, out: 'first' },
      { id: 'one', action: 'files.move', args: {}, status: 'ok', ms: 1, iter: 1, out: 'last' },
      { id: 'rep', action: 'y', args: {}, status: 'replayed', ms: 0, out: 7 },
    ],
  };
  assert.deepEqual(outsFromRun(record), { list: [{ name: 'a' }], one: 'last', rep: 7 });
  assert.deepEqual(outsFromRun(null), {});
});

test('nextRunId：recipeId 前缀 + 时间戳可排序 + 随机段', () => {
  const a = nextRunId('demo', 1000);
  const b = nextRunId('demo', 2000);
  assert.ok(a.startsWith('demo-'));
  assert.ok(a < b, '时间戳递增 → 字典序可排序');
  assert.notEqual(a, nextRunId('demo', 1000), '同毫秒也有随机段');
});
