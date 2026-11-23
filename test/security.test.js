import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { importGame } from '../src/importer/index.js';
import { Library } from '../src/library.js';
import { tmpdir, makeGame, buildZip, buildTar, readTree } from './helpers.js';

const BIG = 'x'.repeat(200000); // compresses to almost nothing

async function setup(extra = {}) {
  const work = await tmpdir();
  const src = await makeGame(path.join(work, 'src'), 'mz', { title: 'Hostile', extra });
  return { work, src, tree: await readTree(src), lib: new Library(path.join(work, 'data')) };
}

test('Halva package paths cannot leave the release folder', async () => {
  const { work, tree, lib } = await setup();
  const release = path.join(work, 'release');
  await fsp.mkdir(release, { recursive: true });
  // A perfectly valid package, but outside the release: must not be read.
  await fsp.writeFile(path.join(work, 'outside.halva2'), zlib.brotliCompressSync(buildTar(tree)));
  const cfg = { config: {}, packageList: { baseContent: [{ packageId: 'x', packageLocation: '../outside.halva2' }] } };
  await fsp.writeFile(path.join(release, 'GameConfig.sbcf'), zlib.brotliCompressSync(Buffer.from(JSON.stringify(cfg))));
  await assert.rejects(importGame(lib, release, { transcode: 'off' }), /invalid location/);
  assert.deepEqual(await lib.list(), []);
});

test('zip: total unpacked size and file count are capped', async () => {
  const { work, tree, lib } = await setup({ 'data/Big.json': BIG });
  const zip = path.join(work, 'g.zip');
  await fsp.writeFile(zip, buildZip(tree));
  await assert.rejects(importGame(lib, zip, { transcode: 'off', limits: { maxBytes: 100000 } }), /unpacks to more than/);
  await assert.rejects(importGame(lib, zip, { transcode: 'off', limits: { maxFiles: 3 } }), /more than 3 files/);
  const ok = await importGame(lib, zip, { transcode: 'off', precompress: false });
  assert.equal(ok.title, 'Hostile');
});

test('zip: an entry that inflates past its declared size is rejected', async () => {
  const { work, tree, lib } = await setup({ 'data/Big.json': BIG });
  const buf = buildZip(tree);
  // Lie in the central directory: claim Big.json is 10 bytes.
  for (let p = buf.length - 22; p >= 0; p--) {
    if (buf.readUInt32LE(p) !== 0x02014b50) continue;
    const name = buf.toString('utf8', p + 46, p + 46 + buf.readUInt16LE(p + 28));
    if (name === 'data/Big.json') buf.writeUInt32LE(10, p + 24);
  }
  const zip = path.join(work, 'liar.zip');
  await fsp.writeFile(zip, buf);
  await assert.rejects(importGame(lib, zip, { transcode: 'off' }), /inflates past its declared size/);
});

test('tar.gz bombs stop at the limit', async () => {
  const { work, tree, lib } = await setup({ 'data/Big.json': BIG });
  const tgz = path.join(work, 'g.tar.gz');
  await fsp.writeFile(tgz, zlib.gzipSync(buildTar(tree)));
  await assert.rejects(importGame(lib, tgz, { transcode: 'off', limits: { maxBytes: 100000 } }), /unpacks to more than/);
});

const bsdtar = ['bsdtar', 'tar'].find((b) => /bsdtar|libarchive/.test(spawnSync(b, ['--version'], { encoding: 'utf8' }).stdout || ''));

test('7z/xz via bsdtar: our extractor writes the files, links are dropped', { skip: !bsdtar && 'bsdtar not installed' }, async () => {
  const { work, src, lib } = await setup({ 'data/Big.json': BIG });
  await fsp.symlink('/etc/passwd', path.join(src, 'img', 'evil'));
  await fsp.symlink('../../..', path.join(src, 'img', 'up'));
  const archive = path.join(work, 'g.tar.xz');
  assert.equal(spawnSync(bsdtar, ['-cJf', archive, '-C', src, '.']).status, 0);
  const meta = await importGame(lib, archive, { transcode: 'off', precompress: false });
  const g = await lib.get(meta.id);
  assert.ok(g.fileSet.has('js/rmmz_core.js'));
  assert.ok(!g.fileSet.has('img/evil') && !g.fileSet.has('img/up'));
  await assert.rejects(fsp.lstat(path.join(lib.rootDir(meta.id), 'img', 'evil')));
  await assert.rejects(importGame(lib, archive, { transcode: 'off', limits: { maxBytes: 100000 } }), /unpacks to more than/);

  const seven = path.join(work, 'g.7z');
  if (spawnSync(bsdtar, ['--format', '7zip', '-cf', seven, '-C', src, '.']).status === 0) {
    const m7 = await importGame(lib, seven, { transcode: 'off', precompress: false, id: 'seven' });
    assert.equal(m7.engine, 'mz');
  }
});
