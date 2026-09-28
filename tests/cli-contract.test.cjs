const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

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
    assert.match(missingUi.stderr, /缺少 dist\/ui.js/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
