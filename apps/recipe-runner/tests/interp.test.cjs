// interp 单测：fake actions 注入全路径——成功链路 / 错误即停 / when 跳过 /
// for each·times / 迭代上限 / 步·ui·run 超时 / 协作取消 / dry-run 语义表 /
// 从第 N 步重跑。engine 纯函数核心，不触 host / electron。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const engine = require('./helpers.cjs');
const { parseRecipe, runRecipe } = engine;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(yamlText, opts = {}) {
  const parsed = parseRecipe(yamlText);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  return runRecipe(parsed.recipe, opts);
}

function recordingActions(extra = {}) {
  const calls = [];
  const actions = {
    't.echo': { category: 'reading', run: async (args) => args.value },
    't.rec': { category: 'reading', run: async (args) => { calls.push(args); return args.ret ?? 'rec'; } },
    't.fail': { category: 'reading', run: async () => { throw new Error('boom'); } },
    't.mut': { category: 'mutating', run: async (args) => { calls.push(['mut', args]); return 'did'; } },
    't.ask': { category: 'interactive', run: async (args) => { calls.push(['ask', args]); return args.ret ?? 'yes'; } },
    't.notify': { category: 'notify', run: async (args) => { calls.push(['notify', args]); return 'shown'; } },
    't.wait': {
      category: 'reading',
      run: (args) => new Promise((r) => setTimeout(() => r('waited'), args.ms ?? 50)),
    },
  };
  return { calls, actions: { ...actions, ...extra } };
}

test('成功链路：args 插值、单一表达式类型保真、out 改名与缺省落点', async () => {
  const { calls, actions } = recordingActions();
  const result = await run(`
id: t1
steps:
  - id: a
    action: t.echo
    args: { value: "{{params.x}}" }
    out: v
  - id: b
    action: t.rec
    args: { got: "{{steps.a.v}}!", list: "{{params.arr}}" }
  - id: c
    action: t.rec
    args: { got: "{{steps.b.out}}" }
`, { params: { x: 7, arr: [1, 2] }, actions });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.steps.map((s) => s.status), ['ok', 'ok', 'ok']);
  // b 的 args：混合文本插值为字符串，整值表达式保持数组
  assert.equal(calls[0].got, '7!');
  assert.deepEqual(calls[0].list, [1, 2]);
  // c 引用 b 的缺省落点 steps.b.out（t.rec 返回 'rec'）
  assert.equal(calls[1].got, 'rec');
  // 轨迹记录解析后 args 与（未超限的）out
  assert.equal(result.steps[0].args.value, 7);
  assert.equal(result.steps[0].out, 7);
});

test('错误即停：失败步 error、后续 skipped、run 定位失败步', async () => {
  const { actions } = recordingActions();
  const result = await run(`
id: t2
steps:
  - { id: a, action: t.echo, args: { value: 1 } }
  - { id: b, action: t.fail }
  - { id: c, action: t.echo, args: { value: 3 } }
`, { actions });
  assert.equal(result.status, 'error');
  assert.deepEqual(result.steps.map((s) => s.status), ['ok', 'error', 'skipped']);
  assert.equal(result.error.stepId, 'b');
  assert.equal(result.error.message, 'boom');
});

test('when 条件：假值跳过（skipReason: when）、真值执行、表达式抛错按失败处理', async () => {
  const { calls, actions } = recordingActions();
  const result = await run(`
id: t3
steps:
  - { id: skip, when: "{{params.go}}", action: t.rec }
  - { id: run, when: "{{!params.go}}", action: t.rec }
  - { id: boolTrue, when: true, action: t.rec }
  - { id: bad, when: "{{params.missing.deep}}", action: t.rec }
  - { id: tail, action: t.rec }
`, { params: { go: false }, actions });
  assert.equal(result.status, 'error');
  const byId = {};
  for (const s of result.steps) byId[s.id] = s;
  assert.equal(byId.skip.status, 'skipped');
  assert.equal(byId.skip.skipReason, 'when');
  assert.equal(byId.run.status, 'ok');
  assert.equal(byId.boolTrue.status, 'ok');
  assert.equal(byId.bad.status, 'error');
  assert.equal(byId.tail.status, 'skipped');
  assert.equal(calls.length, 2);
});

test('for each：循环变量注入、迭代序号落迹、子步骤 out 为末次迭代值', async () => {
  const { calls, actions } = recordingActions();
  const result = await run(`
id: t4
steps:
  - id: src
    action: t.echo
    args: { value: "{{params.items}}" }
    out: items
  - id: loop
    for: { each: f, in: "{{steps.src.items}}" }
    steps:
      - id: body
        action: t.rec
        args: { name: "{{f.name}}", idx: "{{params.items.indexOf(f)}}" }
`, { params: { items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }, actions });
  assert.equal(result.status, 'ok');
  assert.deepEqual(calls.map((c) => c.name), ['a', 'b', 'c']);
  assert.deepEqual(calls.map((c) => c.idx), [0, 1, 2]);
  // 容器先落迹，子步骤带 iter
  assert.equal(result.steps[1].id, 'loop');
  assert.equal(result.steps[1].action, 'for');
  assert.equal(result.steps[1].args.each, 'f');
  assert.equal(result.steps[1].args.in.length, 3);
  const bodyEntries = result.steps.filter((s) => s.id === 'body');
  assert.deepEqual(bodyEntries.map((s) => s.iter), [0, 1, 2]);
  assert.ok(bodyEntries.every((s) => s.status === 'ok'));
});

test('for times：字面量与 {{ }} 表达式两种来源', async () => {
  const { calls, actions } = recordingActions();
  const result = await run(`
id: t5
steps:
  - id: loop
    for: { times: "{{params.n}}" }
    steps: [{ id: hit, action: t.rec }]
`, { params: { n: 4 }, actions });
  assert.equal(result.status, 'ok');
  assert.equal(result.steps[0].args.times, 4);
  assert.equal(calls.length, 4);
  assert.deepEqual(result.steps.filter((s) => s.id === 'hit').map((s) => s.iter), [0, 1, 2, 3]);
});

test('迭代上限：recipe limits 覆盖生效，超限即停且后续 skipped', async () => {
  const { calls, actions } = recordingActions();
  const result = await run(`
id: t6
limits: { maxIterations: 3 }
steps:
  - id: loop
    for: { each: f, in: "{{params.items}}" }
    steps: [{ id: hit, action: t.rec }]
  - { id: after, action: t.rec }
`, { params: { items: [1, 2, 3, 4, 5] }, actions });
  assert.equal(result.status, 'error');
  assert.equal(result.error.stepId, 'loop');
  assert.match(result.error.message, /超过上限 3/);
  assert.equal(calls.length, 0);
  assert.equal(result.steps.at(-1).status, 'skipped');
});

test('迭代上限：缺省 1000 生效', async () => {
  const { actions } = recordingActions();
  const items = Array.from({ length: 1001 }, (_, i) => i);
  const result = await run(`
id: t7
steps:
  - id: loop
    for: { each: f, in: "{{params.items}}" }
    steps: [{ id: hit, action: t.rec }]
`, { params: { items }, actions });
  assert.equal(result.status, 'error');
  assert.match(result.error.message, /超过上限 1000/);
});

test('单步超时：limits.stepTimeoutMs 覆盖，超时步 error、后续 skipped', async () => {
  const { actions } = recordingActions();
  const result = await run(`
id: t8
limits: { stepTimeoutMs: 40 }
steps:
  - { id: slow, action: t.wait, args: { ms: 300 } }
  - { id: after, action: t.rec }
`, { actions });
  assert.equal(result.status, 'error');
  assert.equal(result.error.stepId, 'slow');
  assert.match(result.error.message, /步骤超时/);
  assert.equal(result.steps[1].status, 'skipped');
});

test('ui 类单步超时走 uiStepTimeoutMs（与普通步超时独立）', async () => {
  const { actions } = recordingActions({
    't.askSlow': {
      category: 'interactive',
      run: () => new Promise((r) => setTimeout(() => r('late'), 300)),
    },
  });
  const result = await run(`
id: t9
limits: { stepTimeoutMs: 5000, uiStepTimeoutMs: 40 }
steps:
  - { id: ask, action: t.askSlow }
`, { actions });
  assert.equal(result.status, 'error');
  assert.match(result.error.message, /步骤超时/);
});

test('run 总超时：在途动作被剩余预算截断，报总超时而非步超时', async () => {
  const { actions } = recordingActions({
    't.hang': {
      category: 'reading',
      timeoutMs: 10000,
      run: () => new Promise((r) => setTimeout(() => r('hung'), 5000)),
    },
  });
  const result = await run(`
id: t10
limits: { runTimeoutMs: 60 }
steps:
  - { id: hang, action: t.hang }
`, { actions });
  assert.equal(result.status, 'error');
  assert.match(result.error.message, /总超时/);
  assert.ok(result.ms < 1000, `应在预算附近停止，实际 ${result.ms}ms`);
});

test('协作取消（步间检查点）：在途步骤完成后生效，其余标 cancelled', async () => {
  const ac = new AbortController();
  const { calls, actions } = recordingActions({
    't.abortWait': {
      category: 'reading',
      run: async () => { ac.abort(); await sleep(30); return 'b-done'; },
    },
  });
  const result = await run(`
id: t11
steps:
  - { id: a, action: t.wait, args: { ms: 10 } }
  - { id: b, action: t.abortWait }
  - { id: c, action: t.rec }
  - { id: d, action: t.rec }
`, { actions, signal: ac.signal });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.steps.map((s) => s.status), ['ok', 'ok', 'cancelled', 'cancelled']);
  // 取消后的动作从未被调用
  assert.equal(calls.length, 0);
});

test('预先取消：全部步骤标 cancelled', async () => {
  const ac = new AbortController();
  ac.abort();
  const { actions } = recordingActions();
  const result = await run(`
id: t12
steps:
  - { id: a, action: t.rec }
  - { id: b, action: t.rec }
`, { actions, signal: ac.signal });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.steps.map((s) => s.status), ['cancelled', 'cancelled']);
});

test('动作观察 signal 主动抛出：归为 cancelled 而非 error', async () => {
  const ac = new AbortController();
  const { actions } = recordingActions({
    't.abortThrow': {
      category: 'reading',
      run: async () => { ac.abort(); throw new Error('The operation was aborted'); },
    },
  });
  const result = await run(`
id: t13
steps:
  - { id: a, action: t.abortThrow }
  - { id: b, action: t.rec }
`, { actions, signal: ac.signal });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.steps[0].status, 'cancelled');
  assert.equal(result.steps[1].status, 'cancelled');
});

test('dry-run 语义表：mutating 跳过并记录「将做什么」，reading/interactive 照真，notify 前缀标记', async () => {
  const { calls, actions } = recordingActions();
  const result = await run(`
id: t14
steps:
  - { id: mut, action: t.mut, args: { path: 'a.txt', to: 'b.txt' } }
  - { id: read, action: t.rec, args: { ret: 'r' } }
  - { id: ask, action: t.ask, args: { ret: 'y' } }
  - { id: note, action: t.notify, args: { title: '完成', body: '正文' } }
`, { actions, dryRun: true });
  assert.equal(result.status, 'ok');
  const mut = result.steps.find((s) => s.id === 'mut');
  assert.equal(mut.status, 'skipped');
  assert.equal(mut.skipReason, 'dry-run');
  assert.match(mut.note, /t\.mut/);
  assert.match(mut.note, /a\.txt/);
  // reading / interactive / notify 真执行
  assert.equal(result.steps.find((s) => s.id === 'read').status, 'ok');
  assert.equal(result.steps.find((s) => s.id === 'read').out, 'r');
  const ask = result.steps.find((s) => s.id === 'ask');
  assert.equal(ask.status, 'ok');
  assert.equal(typeof ask.waitedMs, 'number');
  assert.equal(result.steps.find((s) => s.id === 'read').waitedMs, undefined);
  const notifyCall = calls.find((c) => Array.isArray(c) && c[0] === 'notify');
  assert.equal(notifyCall[1].title, '[dry-run] 完成');
  assert.equal(notifyCall[1].body, '正文');
  // mutating 从未被真正调用
  assert.equal(calls.some((c) => Array.isArray(c) && c[0] === 'mut'), false);
});

test('从第 N 步重跑：前序标 replayed、其 out 进初始上下文、动作不重放', async () => {
  const { calls, actions } = recordingActions();
  const result = await run(`
id: t15
steps:
  - { id: a, action: t.echo, args: { value: 'old' } }
  - id: b
    action: t.rec
    args: { got: "{{steps.a.out}}" }
  - { id: c, action: t.echo, args: { value: 'tail' } }
`, { actions, replay: { fromStep: 'b', outs: { a: 'A0' } } });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.steps.map((s) => s.status), ['replayed', 'ok', 'ok']);
  assert.equal(result.steps[0].out, 'A0');
  assert.equal(calls[0].got, 'A0');
  // replayed 步骤的动作从未执行（calls 里只有 b 的 t.rec）
  assert.equal(calls.length, 1);
});

test('重跑入口约束：fromStep 必须是存在的顶层步骤 id', async () => {
  const { actions } = recordingActions();
  const parsed = parseRecipe(`
id: t16
steps:
  - id: loop
    for: { times: 2 }
    steps: [{ id: hit, action: t.rec }]
`);
  assert.equal(parsed.ok, true);
  await assert.rejects(
    () => runRecipe(parsed.recipe, { actions, replay: { fromStep: 'hit', outs: {} } }),
    /顶层/,
  );
  await assert.rejects(
    () => runRecipe(parsed.recipe, { actions, replay: { fromStep: 'nope', outs: {} } }),
    /不存在/,
  );
});

test('未知动作：错误即停', async () => {
  const { actions } = recordingActions();
  const result = await run(`
id: t17
steps:
  - { id: a, action: no.such.thing }
  - { id: b, action: t.rec }
`, { actions });
  assert.equal(result.status, 'error');
  assert.match(result.error.message, /未知动作: no\.such\.thing/);
  assert.equal(result.steps[1].status, 'skipped');
});

test('when 假值作用于循环容器：容器与子树一并 skipped，不执行', async () => {
  const { calls, actions } = recordingActions();
  const result = await run(`
id: t18
steps:
  - id: loop
    when: "{{params.go}}"
    for: { times: 2 }
    steps: [{ id: hit, action: t.rec }]
`, { params: { go: false }, actions });
  assert.equal(result.status, 'ok');
  const loop = result.steps.find((s) => s.id === 'loop');
  assert.equal(loop.status, 'skipped');
  assert.equal(loop.skipReason, 'when');
  assert.equal(result.steps.find((s) => s.id === 'hit').status, 'skipped');
  assert.equal(calls.length, 0);
});

test('for.in 求值结果非数组：容器报错即停', async () => {
  const { actions } = recordingActions();
  const result = await run(`
id: t19
steps:
  - id: loop
    for: { each: f, in: "{{params.notList}}" }
    steps: [{ id: hit, action: t.rec }]
`, { params: { notList: 'abc' }, actions });
  assert.equal(result.status, 'error');
  assert.match(result.error.message, /必须是数组/);
});

test('args 表达式求值失败：该步 error、后续 skipped（引用不存在的步骤路径）', async () => {
  const { actions } = recordingActions();
  const result = await run(`
id: t20
steps:
  - { id: a, action: t.echo, args: { value: 1 } }
  - id: b
    action: t.rec
    args: { x: "{{steps.ghost.out}}" }
  - { id: c, action: t.rec }
`, { actions });
  assert.equal(result.status, 'error');
  assert.equal(result.error.stepId, 'b');
  assert.equal(result.steps[2].status, 'skipped');
});

test('步骤超时触发动作级 AbortSignal：在途动作收到 abort（清理钩子），错误文案归「步骤超时」', async () => {
  let aborted = false;
  let settled = false;
  const actions = {
    't.hang': {
      category: 'reading',
      run: (args, ctx) => new Promise((_resolve, reject) => {
        ctx.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('已取消')); }, { once: true });
      }),
    },
    't.after': { category: 'reading', run: async () => { settled = true; return 'x'; } },
  };
  const result = await run(`
id: t21
limits: { stepTimeoutMs: 50 }
steps:
  - { id: hang, action: t.hang }
  - { id: after, action: t.after }
`, { actions });
  assert.equal(result.status, 'error');
  assert.match(result.error.message, /步骤超时: t\.hang/);
  assert.equal(aborted, true, '动作应观察到 abort 以清理在途资源');
  assert.equal(settled, false, '后续步骤 skipped 不执行');
});

test('步骤超时 abort 的是步骤级信号而非 run 级：归因是 error 不是 cancelled', async () => {
  let sawAborted = false;
  const actions = {
    't.hang': {
      category: 'reading',
      run: (_args, ctx) => new Promise((_resolve, reject) => {
        ctx.signal?.addEventListener('abort', () => { sawAborted = true; }, { once: true });
        // 不 reject：验证引擎超时文案不被动作的沉默影响
      }),
    },
  };
  const parsed = parseRecipe(`
id: t22
limits: { stepTimeoutMs: 50 }
steps:
  - { id: hang, action: t.hang }
`);
  assert.equal(parsed.ok, true);
  const result = await runRecipe(parsed.recipe, { actions });
  assert.equal(result.status, 'error');
  assert.match(result.error.message, /步骤超时/);
  assert.equal(sawAborted, true);
});

test('ActionRunContext.scope 透传：动作可拿到求值上下文（js.eval 落地口径）', async () => {
  let got;
  const actions = {
    't.echo': { category: 'reading', run: async (args) => args.value },
    't.spy': {
      category: 'reading',
      run: async (_args, ctx) => { got = ctx.scope; return 'spied'; },
    },
  };
  const result = await run(`
id: t23
steps:
  - id: prev
    action: t.echo
    args: { value: 5 }
    out: v
  - { id: spy, action: t.spy }
`, { params: { p: 1 }, actions });
  assert.equal(result.status, 'ok');
  assert.deepEqual(got.params, { p: 1 });
  assert.equal(got.steps.prev.v, 5, 'scope.steps 是运行期全量上下文（未截断）');
  assert.equal(typeof got.env.now, 'number');
  assert.deepEqual(got.vars, {});
});

test('onStep 直播轨迹：每步落迹触发通知，末次快照与最终轨迹一致（容器终态已回填）', async () => {
  const { actions } = recordingActions();
  const snapshots = [];
  const result = await run(`
id: t-live
steps:
  - { id: a, action: t.echo, args: { value: 1 } }
  - id: loop
    for: { times: 2 }
    steps:
      - { id: inner, action: t.echo, args: { value: 2 } }
  - { id: b, action: t.echo, args: { value: 3 } }
`, {
    actions,
    onStep: (steps) => snapshots.push(steps.map((s) => ({ ...s }))),
  });
  assert.equal(result.status, 'ok');
  // a + 容器 + inner×2 + b = 5 行
  assert.deepEqual(result.steps.map((s) => s.id), ['a', 'loop', 'inner', 'inner', 'b']);
  // 通知次数：5 次落迹 + 容器字段回填后补发 1 次 = 6
  assert.equal(snapshots.length, 6);
  const last = snapshots[snapshots.length - 1];
  assert.deepEqual(last.map((s) => s.id), ['a', 'loop', 'inner', 'inner', 'b']);
  assert.deepEqual(last.map((s) => s.status), ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.deepEqual(last.map((s) => s.iter), [undefined, undefined, 0, 1, undefined]);
  // 早期快照是部分轨迹（直播语义：UI 逐步看到推进）
  assert.equal(snapshots[1].length, 2);
});
