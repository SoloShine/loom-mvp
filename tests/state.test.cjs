const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');
const bundle = path.join(os.tmpdir(), `mini-state-test-${process.pid}.cjs`);
esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'host', 'src', 'main', 'state.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
process.on('exit', () => fs.rmSync(bundle, { force: true }));
function scenario(legacy, code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-state-'));
  try {
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    if (legacy !== undefined) fs.writeFileSync(path.join(dir, 'registry.json'), legacy);
    const result = spawnSync(process.execPath, ['-e', `const s=require(${JSON.stringify(bundle)}); ${code}`], {
      env: { ...process.env, MINI_DATA_DIR: dir }, encoding: 'utf8',
    });
    return { result, dir };
  } finally { /* caller examines state */ }
}
test('real legacy disabled format migrates once and preserves user updates', () => {
  const { result, dir } = scenario('{"disabled":["sample"]}', 's.initState(); if(s.meta("sample").enabled!==false) process.exit(2); s.setMeta("sample",{favorite:true});');
  try {
    assert.equal(result.status, 0, result.stderr);
    const backups = fs.readdirSync(dir).filter((n) => n.endsWith('.bak'));
    assert.equal(backups.length, 1);
    const again = spawnSync(process.execPath, ['-e', `const s=require(${JSON.stringify(bundle)}); s.initState(); if(s.meta('sample').enabled!==false || !s.meta('sample').favorite) process.exit(3);`], { env: { ...process.env, MINI_DATA_DIR: dir }, encoding: 'utf8' });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.bak')).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('invalid legacy root does not disable unrelated app', () => {
  const { result, dir } = scenario('[]', 's.initState(); if(s.meta("sample")) process.exit(2);');
  try { assert.equal(result.status, 0, result.stderr); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('missing legacy registry starts with default settings and no disabled apps', () => {
  const { result, dir } = scenario(undefined, 's.initState(); if(s.meta("sample") || s.settings().launcherHotkey!=="Ctrl+Shift+M") process.exit(2);');
  try { assert.equal(result.status, 0, result.stderr); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('atomic write failure leaves old file intact', () => {
  const { result, dir } = scenario(undefined, 's.initState(); const fs=require("fs"); const f=require("path").join(process.env.MINI_DATA_DIR,"host-state.json"); const before=fs.readFileSync(f,"utf8"); try{s.atomicWrite(f+"/missing","new")}catch{} if(fs.readFileSync(f,"utf8")!==before) process.exit(2);');
  try { assert.equal(result.status, 0, result.stderr); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
