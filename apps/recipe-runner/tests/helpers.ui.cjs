// ui-logic（UI 纯函数层）加载器：src/ui-logic.ts 经 esbuild 现场编译。
// 该模块无 react / DOM / SDK 运行时依赖（类型引用打包期擦除），可独立进 node:test。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const bundle = path.join(os.tmpdir(), `mini-recipe-ui-logic-test-${process.pid}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'ui-logic.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'silent',
});
process.on('exit', () => fs.rmSync(bundle, { force: true }));

module.exports = require(bundle);
