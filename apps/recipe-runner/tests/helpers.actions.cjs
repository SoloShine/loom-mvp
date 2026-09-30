// actions 层加载器：src/actions/index.ts（含 engine 依赖）经 esbuild 现场
// 编译成 cjs 再 require，@mini/sdk alias 到仓库 SDK 源（纯 TS、无 electron
// 依赖，普通 node 进程可加载；不在 Host 内时 call() 才会拒绝）。
// 与 helpers.cjs（engine）同一条先例路径（testing-and-acceptance.md）。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const appDir = path.join(__dirname, '..');
const repoRoot = path.join(appDir, '..', '..');

const bundle = path.join(os.tmpdir(), `mini-recipe-actions-test-${process.pid}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(appDir, 'src', 'actions', 'index.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'silent',
  alias: { '@mini/sdk': path.join(repoRoot, 'sdk', 'src', 'index.ts') },
});
process.on('exit', () => fs.rmSync(bundle, { force: true }));

module.exports = require(bundle);
