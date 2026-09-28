// 闲置回收生效规则的纯函数测试(host/src/main/idleStop.ts,无运行时依赖)。
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-idlestop-"));
const output = path.join(dir, "idleStop.cjs");
esbuild.buildSync({
  stdin: {
    contents: "export { effectiveIdleStop, describeIdleStop } from './host/src/main/idleStop.ts';",
    resolveDir: process.cwd(),
    loader: "ts",
  },
  outfile: output,
  bundle: true,
  platform: "node",
  format: "cjs",
});
const { effectiveIdleStop, describeIdleStop } = require(output);

function mkSettings({ enabled = false, defaultMinutes = 0, exempt = [] } = {}) {
  return { recycle: { enabled, defaultMinutes, exemptAppIds: exempt } };
}

test("idleStop: 总开关关闭时一律不回收(含清单声明)", () => {
  assert.equal(effectiveIdleStop("a", 30, mkSettings({ enabled: false })), null);
  assert.equal(effectiveIdleStop("a", undefined, mkSettings({ enabled: false, defaultMinutes: 60 })), null);
});

test("idleStop: 例外名单一票否决", () => {
  const s = mkSettings({ enabled: true, defaultMinutes: 60, exempt: ["lianliankan"] });
  assert.equal(effectiveIdleStop("lianliankan", 30, s), null);
  assert.deepEqual(effectiveIdleStop("other", 30, s), { minutes: 30, source: "manifest" });
});

test("idleStop: 清单声明优先于全局默认", () => {
  const s = mkSettings({ enabled: true, defaultMinutes: 60 });
  assert.deepEqual(effectiveIdleStop("a", 5, s), { minutes: 5, source: "manifest" });
  assert.deepEqual(effectiveIdleStop("a", undefined, s), { minutes: 60, source: "global" });
});

test("idleStop: 无清单声明且全局默认为 0 时不回收", () => {
  assert.equal(effectiveIdleStop("a", undefined, mkSettings({ enabled: true, defaultMinutes: 0 })), null);
});

test("idleStop: recycle 段缺失(旧状态文件)按关闭处理", () => {
  assert.equal(effectiveIdleStop("a", 30, {}), null);
});

test("idleStop: describeIdleStop 汇总清单值/例外/生效策略", () => {
  const s = mkSettings({ enabled: true, defaultMinutes: 45 });
  assert.deepEqual(
    describeIdleStop({ id: "a", manifest: { lifecycle: { idleStopMinutes: 10 } } }, s),
    { manifestMinutes: 10, exempt: false, effective: { minutes: 10, source: "manifest" } },
  );
  assert.deepEqual(
    describeIdleStop({ id: "b", manifest: {} }, s),
    { manifestMinutes: undefined, exempt: false, effective: { minutes: 45, source: "global" } },
  );
  // broken App(无 manifest)不抛错
  assert.deepEqual(
    describeIdleStop({ id: "c" }, mkSettings()),
    { manifestMinutes: undefined, exempt: false, effective: null },
  );
});
