const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const bundle = path.join(os.tmpdir(), `mini-file-organizer-test-${process.pid}.cjs`);
esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'apps', 'file-organizer', 'src', 'rules.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs' });
process.on('exit', () => fs.rmSync(bundle, { force: true }));
const rules = require(bundle);

test('extension classification: known, case-insensitive, fallback, dotfiles', () => {
  assert.equal(rules.classifyByExtension('a.txt', 'Other'), 'Documents');
  assert.equal(rules.classifyByExtension('photo.JPG', 'Other'), 'Images');
  assert.equal(rules.classifyByExtension('archive.7z', 'Other'), 'Archives');
  assert.equal(rules.classifyByExtension('c.unknown', 'Other'), 'Other');
  assert.equal(rules.classifyByExtension('.hidden', 'Other'), 'Other');
  assert.equal(rules.classifyByExtension('noext', 'MyStuff'), 'MyStuff');
});

test('date classification buckets by local year-month', () => {
  assert.equal(rules.classifyByDate(new Date(2026, 8, 27, 12).getTime()), '2026-09');
  assert.equal(rules.classifyByDate(new Date(2026, 8, 1, 0, 5).getTime()), '2026-09');
  assert.equal(rules.classifyByDate(new Date(2026, 7, 31, 23, 30).getTime()), '2026-08');
});

test('top-level scan keeps plain files only: directories and symlinks never planned', () => {
  const names = rules.topLevelFiles([
    { name: 'a.txt', isFile: () => true, isSymbolicLink: () => false },
    { name: 'Sub', isFile: () => false, isSymbolicLink: () => false },
    { name: 'link.txt', isFile: () => false, isSymbolicLink: () => true },
    { name: 'b.png', isFile: () => true, isSymbolicLink: () => false },
  ]);
  assert.deepEqual(names, ['a.txt', 'b.png']);
});

test('drive roots are refused, normal directories accepted', () => {
  assert.equal(rules.isSafeDirectory('C:\\'), false);
  assert.equal(rules.isSafeDirectory('C:\\Users\\someone\\Downloads'), true);
  assert.equal(rules.isSafeDirectory(path.resolve('.')), true);
});

test('plan flags conflicts against existing destinations and counts correctly', () => {
  const dir = path.join('D:', 'testdir');
  const existing = new Set([path.join(dir, 'Documents', 'a.txt')]);
  const plan = rules.buildPlan({
    directory: dir,
    files: [{ name: 'a.txt', mtimeMs: 0 }, { name: 'b.png', mtimeMs: 0 }],
    mode: 'extension',
    fallback: 'Other',
    destinationExists: (p) => existing.has(p),
  });
  assert.equal(plan.counts.total, 2);
  assert.equal(plan.counts.move, 1);
  assert.equal(plan.counts.conflict, 1);
  const a = plan.items.find((i) => i.fileName === 'a.txt');
  const b = plan.items.find((i) => i.fileName === 'b.png');
  assert.equal(a.conflict, true);
  assert.equal(a.destination, path.join(dir, 'Documents', 'a.txt'));
  assert.equal(b.conflict, false);
  assert.equal(b.destination, path.join(dir, 'Images', 'b.png'));
});

test('applyPlan skips conflicts, stale destinations, cross-volume and missing sources; never overwrites', async () => {
  const plan = rules.buildPlan({
    directory: 'D:\\d',
    files: [
      { name: 'ok.txt', mtimeMs: 0 },
      { name: 'conflict.txt', mtimeMs: 0 },
      { name: 'late.txt', mtimeMs: 0 },
      { name: 'gone.txt', mtimeMs: 0 },
      { name: 'foreign.txt', mtimeMs: 0 },
      { name: 'boom.txt', mtimeMs: 0 },
    ],
    mode: 'extension',
    fallback: 'Other',
    destinationExists: () => false,
  });
  const movedFrom = [];
  const result = await rules.applyPlan(plan, async (from, to) => {
    if (from.endsWith('boom.txt')) throw new Error('EPERM: operation not permitted');
    movedFrom.push([from, to]);
  }, {
    destinationExists: (p) => p.endsWith('conflict.txt') || p.endsWith('late.txt'),
    isFile: (p) => !p.endsWith('gone.txt'),
    sameVolume: (a, b) => !a.endsWith('foreign.txt'),
  });
  assert.deepEqual(movedFrom.map(([f]) => path.basename(f)).sort(), ['ok.txt']);
  assert.equal(result.moved, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].fileName, 'boom.txt');
  const skipped = Object.fromEntries(result.skipped.map((s) => [s.fileName, s.reason]));
  assert.equal(skipped['conflict.txt'], 'destination exists');
  assert.equal(skipped['late.txt'], 'destination exists');
  assert.equal(skipped['gone.txt'], 'source missing or not a regular file');
  assert.equal(skipped['foreign.txt'], 'cross-volume move refused');
  assert.ok(result.durationMs >= 0);
});

test('real-fs run: moves land in category folders, conflicts stay intact, directories untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-organizer-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'new a');
    fs.writeFileSync(path.join(dir, 'b.png'), 'png');
    fs.writeFileSync(path.join(dir, 'c.unknown'), 'unk');
    fs.writeFileSync(path.join(dir, 'd.txt'), 'd');
    fs.mkdirSync(path.join(dir, 'Documents'));
    fs.writeFileSync(path.join(dir, 'Documents', 'a.txt'), 'PRE-EXISTING');
    fs.mkdirSync(path.join(dir, 'Sub'));
    fs.writeFileSync(path.join(dir, 'Sub', 'inner.txt'), 'inner');

    const dirents = fs.readdirSync(dir, { withFileTypes: true });
    const files = rules.topLevelFiles(dirents).map((name) => ({
      name,
      mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs,
    }));
    const plan = rules.buildPlan({
      directory: dir,
      files,
      mode: 'extension',
      fallback: 'Other',
      destinationExists: (p) => fs.existsSync(p),
    });
    assert.deepEqual(plan.counts, { total: 4, move: 3, conflict: 1 });

    const result = await rules.applyPlan(plan, (from, to) => {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      return Promise.resolve();
    }, {
      destinationExists: (p) => fs.existsSync(p),
      isFile: (p) => fs.statSync(p).isFile(),
      sameVolume: (a, b) => path.parse(a).root.toLowerCase() === path.parse(b).root.toLowerCase(),
    });
    assert.equal(result.moved, 3);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].fileName, 'a.txt');
    assert.deepEqual(result.failed, []);

    assert.equal(fs.readFileSync(path.join(dir, 'Documents', 'a.txt'), 'utf8'), 'PRE-EXISTING', 'conflict destination must never be overwritten');
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'new a', 'conflicted source must stay in place');
    assert.equal(fs.readFileSync(path.join(dir, 'Images', 'b.png'), 'utf8'), 'png');
    assert.equal(fs.readFileSync(path.join(dir, 'Other', 'c.unknown'), 'utf8'), 'unk');
    assert.equal(fs.readFileSync(path.join(dir, 'Documents', 'd.txt'), 'utf8'), 'd');
    assert.equal(fs.readFileSync(path.join(dir, 'Sub', 'inner.txt'), 'utf8'), 'inner', 'subdirectories must never be touched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
