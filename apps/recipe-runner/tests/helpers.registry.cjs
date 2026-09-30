// registry（编排纯函数）加载器：src/registry.ts 经 esbuild 现场编译。
// registry 只依赖 engine parse 与类型，无需 SDK alias。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const appDir = path.join(__dirname, '..');

const bundle = path.join(os.tmpdir(), `mini-recipe-registry-test-${process.pid}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(appDir, 'src', 'registry.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'silent',
});
process.on('exit', () => fs.rmSync(bundle, { force: true }));

module.exports = require(bundle);
