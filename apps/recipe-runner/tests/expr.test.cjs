// 表达式求值单测：插值 / 单一表达式类型保真 / 循环变量 / env / 深度 args
// 解析 / 引用静态扫描。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const engine = require('./helpers.cjs');
const { evalTemplate, evalExpression, resolveArgs, scanStepRefs, isValidVarName } = engine;

function mkScope(over = {}) {
  return {
    params: over.params ?? {},
    steps: over.steps ?? {},
    env: { now: over.now ?? 1759276800000 },
    vars: over.vars ?? {},
  };
}

test('字符串插值：{{ }} 逐段替换', () => {
  const scope = mkScope({ params: { x: 7 }, steps: { a: { out: 'A' } } });
  assert.equal(evalTemplate('a{{params.x}}b', scope), 'a7b');
  assert.equal(evalTemplate('{{steps.a.out}}+{{params.x}}', scope), 'A+7');
});

test('整值恰为单一 {{ }}：返回原始类型不字符串化', () => {
  const scope = mkScope({
    params: { n: 42, flag: false, arr: [1, 2, 3] },
    steps: { s: { files: [{ path: 'a' }, { path: 'b' }] } },
  });
  assert.equal(evalTemplate('{{params.n}}', scope), 42);
  assert.equal(evalTemplate('{{params.flag}}', scope), false);
  assert.deepEqual(evalTemplate('{{params.arr}}', scope), [1, 2, 3]);
  assert.deepEqual(evalTemplate('{{steps.s.files}}', scope), [{ path: 'a' }, { path: 'b' }]);
  // 前后空白不破坏「单一表达式」判定
  assert.equal(evalTemplate('  {{params.n}}  ', scope), 42);
});

test('两个表达式拼接（值非单一表达式）按字符串处理', () => {
  const scope = mkScope({ params: { a: 1, b: 2 } });
  assert.equal(evalTemplate('{{params.a}}{{params.b}}', scope), '12');
});

test('插值序列化约定：空值→空串、对象→JSON、数字/布尔→String', () => {
  const scope = mkScope({
    params: { u: undefined, n: null, o: { k: 1 }, b: true, d: 3.5 },
    steps: {},
  });
  assert.equal(evalTemplate('[{{params.u}}]', scope), '[]');
  assert.equal(evalTemplate('[{{params.n}}]', scope), '[]');
  assert.equal(evalTemplate('v={{params.o}}', mkScope({ params: { o: { k: 1 } } })), 'v={"k":1}');
  // 整值单一表达式仍返回原始对象（不字符串化）
  assert.deepEqual(evalTemplate('{{params.o}}', mkScope({ params: { o: { k: 1 } } })), { k: 1 });
  assert.equal(evalTemplate('{{params.b}}-{{params.d}}', scope), 'true-3.5');
});

test('循环变量与 env.now 可见', () => {
  const scope = mkScope({ vars: { f: { path: 'x' } }, now: 12345 });
  assert.equal(evalTemplate('{{f.path}}', scope), 'x');
  assert.equal(evalTemplate('{{env.now}}', scope), 12345);
  assert.equal(evalTemplate('{{params.q}}', mkScope()), undefined);
});

test('求值失败原样抛出（= 该步失败，错误即停）', () => {
  const scope = mkScope();
  assert.throws(() => evalTemplate('{{nope.deep}}', scope), ReferenceError);
  assert.throws(() => evalTemplate('{{1 +}}', scope), SyntaxError);
  assert.throws(() => evalExpression('throw new Error("x")', scope), /x/);
});

test('resolveArgs 深度解析：字符串过模板，结构递归，标量原样', () => {
  const scope = mkScope({ params: { n: 5 }, steps: { s: { list: ['a', 'b'] } }, vars: { f: 'item' } });
  const out = resolveArgs({
    plain: 'text',
    tpl: 'n={{params.n}}',
    whole: '{{steps.s.list}}',
    nested: { inner: '{{f}}', arr: ['{{f}}', 1, true, null] },
    num: 9,
  }, scope);
  assert.equal(out.plain, 'text');
  assert.equal(out.tpl, 'n=5');
  assert.deepEqual(out.whole, ['a', 'b']);
  assert.deepEqual(out.nested, { inner: 'item', arr: ['item', 1, true, null] });
  assert.equal(out.num, 9);
});

test('scanStepRefs 识别点取与下标取两种写法', () => {
  assert.deepEqual(scanStepRefs('{{steps.list.files.length}}'), ['list']);
  assert.deepEqual(scanStepRefs('{{steps["a b"].out}}'), ['a b']);
  assert.deepEqual(scanStepRefs('{{steps.a.out + steps.b.out}}'), ['a', 'b']);
  assert.deepEqual(scanStepRefs('{{params.notSteps}}'), []);
});

test('isValidVarName：标识符、保留字、上下文名', () => {
  assert.equal(isValidVarName('f'), true);
  assert.equal(isValidVarName('_x1'), true);
  assert.equal(isValidVarName('1x'), false);
  assert.equal(isValidVarName('class'), false);
  assert.equal(isValidVarName('in'), false);
  assert.equal(isValidVarName('steps'), false);
  assert.equal(isValidVarName('params'), false);
  assert.equal(isValidVarName('env'), false);
});
