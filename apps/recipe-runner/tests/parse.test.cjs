// parse 层单测：YAML 语法 / schema 结构 / 语义检查（id 重复、控制流嵌套、
// 循环变量保留字、引用不存在 id 的警告）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const engine = require('./helpers.cjs');
const { parseRecipe } = engine;

const MINIMAL = `
id: demo
steps:
  - id: go
    action: test.echo
    args: { value: "x" }
`;

test('最小 recipe 解析通过，无警告', () => {
  const r = parseRecipe(MINIMAL);
  assert.equal(r.ok, true);
  assert.equal(r.recipe.id, 'demo');
  assert.equal(r.recipe.steps.length, 1);
  assert.deepEqual(r.warnings, []);
  // 缺省语义字段不强制回填：onRun/onerror 未声明即 undefined（引擎按缺省值处理）
  assert.equal(r.recipe.onRun, undefined);
  assert.equal(r.recipe.onerror, undefined);
});

test('design 示意全量形态解析通过（params/hotkey/onRun/onerror/for/out 改名/嵌套）', () => {
  const r = parseRecipe(`
id: rename-downloads
name: 下载目录批量重命名
hotkey: Ctrl+Alt+R
onRun: silent
params:
  dir: { label: 目录, type: string, default: "D:\\\\Downloads", required: true }
onerror: notify
steps:
  - id: list
    action: fs.list
    args: { dir: "{{params.dir}}", filter: "*.pdf" }
    out: files
  - id: confirm
    action: ui.confirm
    args: { title: "将重命名 {{steps.list.files.length}} 个文件" }
  - id: ren
    for: { each: f, in: "{{steps.list.files}}" }
    steps:
      - id: one
        action: files.move
        args: { from: "{{f.path}}" }
  - id: done
    action: notification.show
    args: { title: 完成, body: "{{steps.list.files.length}} 项" }
`);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.recipe.params.dir.type, 'string');
  assert.equal(r.recipe.steps[2].for.each, 'f');
  assert.deepEqual(r.warnings, []);
});

test('YAML 语法错误一次报出', () => {
  const r = parseRecipe('id: [unclosed\n  - :');
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /YAML 语法错误/);
});

test('schema 拦截：缺 id / 非法 id / 未知顶层字段 / 空 steps', () => {
  const cases = [
    ['steps:\n  - id: a\n    action: x', "(根)"],
    ['id: Demo\nsteps:\n  - id: a\n    action: x', '/id'],
    ['id: d\nbogus: 1\nsteps:\n  - id: a\n    action: x', '未知属性: bogus'],
    ['id: d\nsteps: []', '/steps'],
    ['id: d\nonRun: always\nsteps:\n  - id: a\n    action: x', '/onRun'],
  ];
  for (const [text, hint] of cases) {
    const r = parseRecipe(text);
    assert.equal(r.ok, false, `应被 schema 拒绝: ${hint}\n${text}`);
    assert.ok(r.errors.some((e) => e.includes(hint)), JSON.stringify(r.errors));
  }
});

test('schema 拦截：步骤必须 action 叶子或 for 容器二选一', () => {
  const neither = parseRecipe('id: d\nsteps:\n  - id: a\n    args: {}');
  assert.equal(neither.ok, false);
  const both = parseRecipe(`
id: d
steps:
  - id: a
    action: x
    for: { times: 2 }
    steps:
      - id: b
        action: y
`);
  assert.equal(both.ok, false);
});

test('schema 拦截：params 类型与 select 缺 options', () => {
  const badType = parseRecipe('id: d\nparams:\n  p: { type: color }\nsteps:\n  - id: a\n    action: x');
  assert.equal(badType.ok, false);
  const noOptions = parseRecipe('id: d\nparams:\n  p: { type: select }\nsteps:\n  - id: a\n    action: x');
  assert.equal(noOptions.ok, false);
  const withOptions = parseRecipe('id: d\nparams:\n  p: { type: select, options: [a, b] }\nsteps:\n  - id: a\n    action: x');
  assert.equal(withOptions.ok, true, JSON.stringify(withOptions.errors));
});

test('schema 拦截：for 形态互斥（each+in / times）与非法数值', () => {
  const eachNoIn = parseRecipe(`
id: d
steps:
  - id: loop
    for: { each: f }
    steps: [{ id: b, action: x }]
`);
  assert.equal(eachNoIn.ok, false);
  const timesWithEach = parseRecipe(`
id: d
steps:
  - id: loop
    for: { times: 2, each: f, in: "{{params.x}}" }
    steps: [{ id: b, action: x }]
`);
  assert.equal(timesWithEach.ok, false);
  const negTimes = parseRecipe(`
id: d
steps:
  - id: loop
    for: { times: -1 }
    steps: [{ id: b, action: x }]
`);
  assert.equal(negTimes.ok, false);
});

test('schema 拦截：when 必须是单一 {{ }} 表达式或布尔', () => {
  const bare = parseRecipe('id: d\nsteps:\n  - id: a\n    action: x\n    when: params.flag');
  assert.equal(bare.ok, false);
  const okForm = parseRecipe('id: d\nsteps:\n  - id: a\n    action: x\n    when: "{{params.flag}}"');
  assert.equal(okForm.ok, true, JSON.stringify(okForm.errors));
  const boolForm = parseRecipe('id: d\nsteps:\n  - id: a\n    action: x\n    when: true');
  assert.equal(boolForm.ok, true, JSON.stringify(boolForm.errors));
});

test('语义检查：步骤 id 重复（顶层重复 / 嵌套与顶层撞名）报错', () => {
  const dupTop = parseRecipe(`
id: d
steps:
  - { id: a, action: x }
  - { id: a, action: y }
`);
  assert.equal(dupTop.ok, false);
  assert.ok(dupTop.errors.some((e) => e.includes('重复')), JSON.stringify(dupTop.errors));

  const dupNested = parseRecipe(`
id: d
steps:
  - { id: a, action: x }
  - id: loop
    for: { times: 1 }
    steps:
      - { id: a, action: y }
`);
  assert.equal(dupNested.ok, false);
  assert.ok(dupNested.errors.some((e) => e.includes('重复')));
});

test('语义检查：控制流不套控制流（嵌套超限报错）', () => {
  const r = parseRecipe(`
id: d
steps:
  - id: outer
    for: { times: 2 }
    steps:
      - id: inner
        for: { each: x, in: "{{params.xs}}" }
        steps:
          - { id: leaf, action: x }
`);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('控制流不能嵌套')), JSON.stringify(r.errors));
});

test('语义检查：for.each 保留字（params/steps/env 由 schema 拦、其余 JS 保留字由 parse 拦）', () => {
  const schemaLayer = parseRecipe(`
id: d
steps:
  - id: loop
    for: { each: steps, in: "{{params.xs}}" }
    steps: [{ id: b, action: x }]
`);
  assert.equal(schemaLayer.ok, false);

  const parseLayer = parseRecipe(`
id: d
steps:
  - id: loop
    for: { each: class, in: "{{params.xs}}" }
    steps: [{ id: b, action: x }]
`);
  assert.equal(parseLayer.ok, false);
  assert.ok(parseLayer.errors.some((e) => e.includes('非法循环变量名')), JSON.stringify(parseLayer.errors));
});

test('引用不存在的步骤 id：警告不拒（args 与 for.in 都扫到）', () => {
  const r = parseRecipe(`
id: d
steps:
  - { id: a, action: x }
  - id: b
    action: y
    args: { v: "{{steps.nope.out}}" }
  - id: loop
    for: { each: f, in: "{{steps.alsoNope}}" }
    steps: [{ id: c, action: z }]
`);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.includes('nope')), JSON.stringify(r.warnings));
  assert.ok(r.warnings.some((w) => w.includes('alsoNope')));
});

test('引用存在的步骤 id 不产生警告（含 steps["x"] 写法）', () => {
  const r = parseRecipe(`
id: d
steps:
  - { id: a, action: x }
  - id: b
    action: y
    args: { v: "{{steps.a.out}} {{steps[\\"a\\"].out}}" }
`);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.warnings, []);
});
