// 引擎加载器：TypeScript 源经 esbuild 现场编译成 cjs 到临时目录再 require，
// 与根 tests/*.test.cjs 的 load 先例同一条路径（testing-and-acceptance.md）。
// node --test 每个测试文件独立进程，各自 build 一次（毫秒级，可接受）。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const bundle = path.join(os.tmpdir(), `mini-recipe-engine-test-${process.pid}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'engine', 'index.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'silent',
});
process.on('exit', () => fs.rmSync(bundle, { force: true }));

module.exports = require(bundle);
