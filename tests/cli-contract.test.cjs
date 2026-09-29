const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const esbuild = require('esbuild');

const cli = path.join(__dirname, '..', 'cli', 'dist', 'mini.js');
function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', part => { stdout += part; });
    child.stderr.on('data', part => { stderr += part; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

// 现场编译 TS 源为 cjs(host-contract 的 load 模式)。产物放 node_modules/.cache
// 下,external 的 require('esbuild') 才能向上解析到仓库 node_modules(tmpdir 解析不到)。
const srcBuildDir = path.join(__dirname, '..', 'node_modules', '.cache', 'mini-cli-test-src');
fs.rmSync(srcBuildDir, { recursive: true, force: true });
fs.mkdirSync(srcBuildDir, { recursive: true });
process.on('exit', () => fs.rmSync(srcBuildDir, { recursive: true, force: true }));
let loadSeq = 0;
function loadTs(absSource) {
  const outfile = path.join(srcBuildDir, `m${++loadSeq}.cjs`);
  esbuild.buildSync({
    entryPoints: [absSource],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'esbuild'],
    logLevel: 'silent',
  });
  return require(outfile);
}

test('CLI list/status display broken and disabled DTOs; API error code exits nonzero', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-cli-contract-'));
  const token = 'test-token';
  const server = http.createServer((req, res) => {
    const apps = [
      { id: 'clipboard-tool', name: 'Clipboard Tool', status: 'stopped', enabled: false, commands: [{ id: 'clean', title: 'Clean' }] },
      { id: 'bad-app', name: 'bad-app', status: 'broken', enabled: false, error: 'invalid YAML', commands: [] },
    ];
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/ping') return res.end(JSON.stringify({ ok: true }));
    if (req.url === '/apps') return res.end(JSON.stringify({ ok: true, apps }));
    res.statusCode = 409;
    res.end(JSON.stringify({ ok: false, code: 'APP_DISABLED', error: 'App clipboard-tool 已禁用' }));
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(path.join(data, 'runtime.json'), JSON.stringify({ port: server.address().port, token, pid: process.pid }));
    const env = { MINI_DATA_DIR: data };
    const list = await run(['list'], env);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /clipboard-tool.*disabled/);
    assert.match(list.stdout, /commands: clean/);
    assert.match(list.stdout, /bad-app.*broken/);
    assert.match(list.stdout, /invalid YAML/);
    const status = await run(['status'], env);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /clipboard-tool.*disabled.*commands: clean/);
    assert.match(status.stdout, /bad-app.*broken.*invalid YAML/);
    const command = await run(['invoke', 'clipboard-tool', 'clean'], env);
    assert.equal(command.code, 1);
    assert.match(command.stderr, /APP_DISABLED: App clipboard-tool/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('CLI validate warns on undeclared capability but rejects missing build artifact', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-cli-validate-'));
  const dir = path.join(root, 'sample');
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'dist'));
    fs.writeFileSync(path.join(dir, 'app.yaml'), 'id: sample\nname: Sample\nversion: 0.1.0\nentry: src/main.ts\nui:\n  type: none\n');
    fs.writeFileSync(path.join(dir, 'src', 'main.ts'), 'await host.clipboard.readText();');
    fs.writeFileSync(path.join(dir, 'dist', 'main.js'), '');
    const env = { MINI_APPS_DIR: root };
    const good = await run(['validate', 'sample'], env);
    assert.equal(good.code, 0, good.stderr);
    assert.match(good.stderr, /能力声明提示.*clipboard/);
    fs.rmSync(path.join(dir, 'dist', 'main.js'));
    const bad = await run(['validate', 'sample'], env);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /缺少 dist\/main.js/);
    fs.writeFileSync(path.join(dir, 'dist', 'main.js'), '');
    fs.writeFileSync(path.join(dir, 'app.yaml'), 'id: sample\nname: Sample\nversion: 0.1.0\nentry: src/main.ts\nui:\n  type: window\n');
    fs.writeFileSync(path.join(dir, 'src', 'ui.ts'), '');
    const missingUi = await run(['validate', 'sample'], env);
    assert.equal(missingUi.code, 1);
    assert.match(missingUi.stderr, /缺少 dist\/ui\.js/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mini create default template keeps the minimal scaffold byte-identical', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-create-min-'));
  try {
    const env = { MINI_APPS_DIR: root };
    const none = await run(['create', 'demo-min'], env);
    assert.equal(none.code, 0, none.stderr);
    const dir = path.join(root, 'demo-min');
    for (const f of ['app.yaml', 'package.json', 'tsconfig.json', 'src/main.ts', 'README.md']) {
      assert.ok(fs.existsSync(path.join(dir, ...f.split('/'))), `missing ${f}`);
    }
    assert.ok(!fs.existsSync(path.join(dir, 'src', 'ui.ts')), 'ui:none 不该有 src/ui.ts');
    // app.yaml 逐字节锁定(缺省输出与现状一致)
    assert.equal(
      fs.readFileSync(path.join(dir, 'app.yaml'), 'utf8'),
      'id: demo-min\nname: demo-min\nversion: 0.1.0\n\nentry: src/main.ts\n\nui:\n  type: none\n\ncommands:\n  - id: ping\n    title: Ping\n  - id: selftest\n    title: 服务自检\n',
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.deepEqual(pkg.dependencies, { '@mini/sdk': '*' });
    assert.ok(!fs.existsSync(path.join(dir, 'vite.config.ts')));
    const main = fs.readFileSync(path.join(dir, 'src', 'main.ts'), 'utf8');
    assert.match(main, /host\.ui\.onMessage/);
    assert.match(main, /case "selftest"/);

    const win = await run(['create', 'demo-win', '--ui', 'window'], env);
    assert.equal(win.code, 0, win.stderr);
    const winYaml = fs.readFileSync(path.join(root, 'demo-win', 'app.yaml'), 'utf8');
    assert.match(winYaml, /type: window/);
    assert.match(winYaml, /width: 360/);
    assert.match(winYaml, /height: 240/);
    const ui = fs.readFileSync(path.join(root, 'demo-win', 'src', 'ui.ts'), 'utf8');
    assert.match(ui, /host\.app\.send\(\{ type: "ping" \}\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mini create --template react scaffolds react app (dry-run, no npm install)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-create-react-'));
  const { createApp } = loadTs(path.join(__dirname, '..', 'cli', 'src', 'create.ts'));
  const { parseManifest } = loadTs(path.join(__dirname, '..', 'host', 'src', 'main', 'manifest.ts'));
  try {
    process.env.MINI_APPS_DIR = root;
    const dir = createApp('demo-react', 'window', 'react', { install: false });
    for (const f of ['app.yaml', 'package.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'src/main.ts', 'src/ui.tsx', 'README.md']) {
      assert.ok(fs.existsSync(path.join(dir, ...f.split('/'))), `missing ${f}`);
    }
    assert.ok(!fs.existsSync(path.join(dir, 'src', 'ui.ts')), 'react 模板不产 ui.ts');
    const yaml = fs.readFileSync(path.join(dir, 'app.yaml'), 'utf8');
    assert.match(yaml, /devUrl: http:\/\/localhost:5174/);
    assert.match(yaml, /# dev server 起来后重开窗口自动切热更/);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.private, true);
    assert.equal(pkg.dependencies.react, '^19.2.0');
    assert.equal(pkg.dependencies['react-dom'], '^19.2.0');
    // @mini/sdk 不进 dependencies:包不存在于 registry,npm install 会 404
    assert.ok(!('@mini/sdk' in pkg.dependencies));
    assert.equal(pkg.devDependencies.vite, '^7.1.0');
    assert.equal(pkg.devDependencies['@vitejs/plugin-react'], '^5.1.0');
    assert.equal(pkg.scripts.dev, 'vite --port 5174 --strictPort');
    const ts = JSON.parse(fs.readFileSync(path.join(dir, 'tsconfig.json'), 'utf8'));
    assert.equal(ts.compilerOptions.jsx, 'react-jsx');
    // manifest 唯一事实在 host:生成物要能被 parseManifest 原样接受
    const parsed = parseManifest(yaml, 'demo-react');
    assert.equal(parsed.ok, true, parsed.errors && parsed.errors.join('; '));
    assert.equal(parsed.manifest.ui.devUrl, 'http://localhost:5174');
    assert.equal(parsed.manifest.ui.type, 'window');
    const ui = fs.readFileSync(path.join(dir, 'src', 'ui.tsx'), 'utf8');
    assert.match(ui, /createRoot/);
    assert.match(ui, /host\.app\.onMessage/);
    assert.match(ui, /host\.app\.send\(\{ type: "ping" \}\)/);
    assert.doesNotMatch(ui, /import\s+["'][^"']*\.css["']/, '不许 import css(esbuild 会拆出壳不加载的 ui.css)');
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.match(html, /<div id="root"><\/div>/);
    assert.match(html, /\/src\/ui\.tsx/);
    const viteCfg = fs.readFileSync(path.join(dir, 'vite.config.ts'), 'utf8');
    assert.match(viteCfg, /react\(\)/);
    assert.match(viteCfg, /mini build/);
    assert.match(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), /npm run dev/);
    // main.ts 与 minimal 模板同内容
    const main = fs.readFileSync(path.join(dir, 'src', 'main.ts'), 'utf8');
    assert.match(main, /host\.ui\.onMessage/);
    assert.match(main, /case "selftest"/);
  } finally {
    delete process.env.MINI_APPS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mini create --template: unknown name dies, default stays minimal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-create-tpl-'));
  const { createApp } = loadTs(path.join(__dirname, '..', 'cli', 'src', 'create.ts'));
  try {
    const env = { MINI_APPS_DIR: root };
    const bad = await run(['create', 'demo-tpl', '--template', 'vue'], env);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /未知模板/);
    assert.ok(!fs.existsSync(path.join(root, 'demo-tpl')), 'die 前不应建目录');
    // createApp 兜底同样拒绝未知模板(编程错误直接 throw)
    assert.throws(() => createApp('demo-guard', 'none', 'vue', { install: false }), /未知模板/);
    const def = await run(['create', 'demo-tpl'], env);
    assert.equal(def.code, 0, def.stderr);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'demo-tpl', 'package.json'), 'utf8'));
    assert.ok(!pkg.dependencies.react, '缺省模板不引 react');
    assert.ok(!fs.existsSync(path.join(root, 'demo-tpl', 'vite.config.ts')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildApp compiles src/ui.tsx via jsx automatic; ui.ts wins when both exist', async () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-tsx-build-'));
  const { buildApp } = loadTs(path.join(__dirname, '..', 'cli', 'src', 'build.ts'));
  try {
    fs.mkdirSync(path.join(app, 'src'));
    fs.writeFileSync(path.join(app, 'src', 'main.ts'), 'export async function onStart(): Promise<void> {}\n');
    // react 桩:jsx automatic 会 import react/jsx-runtime,干编译给它一个可解析实现
    fs.mkdirSync(path.join(app, 'node_modules', 'react'), { recursive: true });
    fs.writeFileSync(path.join(app, 'node_modules', 'react', 'package.json'), JSON.stringify({ name: 'react', version: '19.2.0' }));
    fs.writeFileSync(
      path.join(app, 'node_modules', 'react', 'jsx-runtime.js'),
      'exports.Fragment = "Fragment";\nexports.jsx = (type, props) => ({ type, props });\nexports.jsxs = (type, props) => ({ type, props });\n',
    );
    fs.writeFileSync(
      path.join(app, 'src', 'ui.tsx'),
      'export function App() {\n  return (\n    <div className="wrap">\n      <span>hi</span>\n    </div>\n  );\n}\nvoid App;\n',
    );
    const res = await buildApp(app);
    assert.equal(res.uiBuilt, true);
    const ui = fs.readFileSync(path.join(app, 'dist', 'ui.js'), 'utf8');
    assert.ok(ui.includes('hi'), 'jsx 应转译进产物');
    assert.doesNotMatch(ui, /<(div|span)/, '不允许残留 JSX 语法');

    // ui.ts 优先:两份并存时以 ui.ts 为 ui 入口
    fs.writeFileSync(path.join(app, 'src', 'ui.ts'), 'export const marker = "from-ui-ts";\nvoid marker;\n');
    await buildApp(app);
    const ui2 = fs.readFileSync(path.join(app, 'dist', 'ui.js'), 'utf8');
    assert.ok(ui2.includes('from-ui-ts'));
    assert.ok(!ui2.includes('hi'), 'ui.ts 优先时不应打包 ui.tsx 内容');
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});
