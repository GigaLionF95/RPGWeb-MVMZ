import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { ZipArchive, safeRelative } from '../src/importer/zip.js';
import { extractTar } from '../src/importer/tar.js';
import { importGame } from '../src/importer/index.js';
import { Library } from '../src/library.js';
import { encrypt, decrypt } from '../src/importer/rpgcrypt.js';
import { tmpdir, makeGame, buildZip, buildTar, readTree } from './helpers.js';

test('safeRelative strips traversal, drive letters and backslashes', () => {
  assert.equal(safeRelative('\\data\\Actors.json'), 'data/Actors.json');
  assert.equal(safeRelative('C:/game/www/index.html'), 'game/www/index.html');
  assert.equal(safeRelative('a/../../etc/passwd'), null);
  assert.equal(safeRelative('./'), null);
});

test('zip reader extracts deflated entries, including a zip glued to an exe', async () => {
  const dir = await tmpdir();
  const exe = buildZip({ 'www/index.html': 'hi', 'www/js/main.js': 'x'.repeat(5000) }, { prefix: Buffer.alloc(4096, 0x4d) });
  const file = path.join(dir, 'Game.exe');
  await fsp.writeFile(file, exe);
  assert.equal(await ZipArchive.isZip(file), true);
  const z = await ZipArchive.open(file);
  await z.extractAll(path.join(dir, 'out'));
  await z.close();
  const tree = await readTree(path.join(dir, 'out'));
  assert.equal(tree['www/index.html'], 'hi');
  assert.equal(tree['www/js/main.js'].length, 5000);
});

test('tar extractor handles Windows-style names and padding', async () => {
  const dir = await tmpdir();
  const tar = buildTar({ '\\data\\Actors.json': '[1]', '\\js\\plugins\\A.js': 'a'.repeat(700), 'img/x.png': '' });
  await extractTar(Readable.from([tar.subarray(0, 300), tar.subarray(300, 1500), tar.subarray(1500)]), dir);
  const tree = await readTree(dir);
  assert.deepEqual(Object.keys(tree).sort(), ['data/Actors.json', 'img/x.png', 'js/plugins/A.js']);
  assert.equal(tree['js/plugins/A.js'].length, 700);
});

test('RPG Maker asset encryption round-trips', () => {
  const key = '00112233445566778899aabbccddeeff';
  const data = Buffer.from('OggS-this-is-audio-data-longer-than-16-bytes');
  const enc = encrypt(data, key);
  assert.equal(enc.length, data.length + 16);
  assert.deepEqual(decrypt(enc, key), data);
});

test('imports an MV desktop folder (www/) from a zip', async () => {
  const work = await tmpdir();
  const src = path.join(work, 'src');
  await makeGame(path.join(src, 'My Game', 'www'), 'mv', { title: 'Zip Quest' });
  await fsp.writeFile(path.join(src, 'My Game', 'Game.exe'), 'MZ');
  const entries = {};
  for (const [rel, body] of Object.entries(await readTree(src))) entries[rel] = body;
  const zipFile = path.join(work, 'game.zip');
  await fsp.writeFile(zipFile, buildZip(entries));

  const lib = new Library(path.join(work, 'data'));
  const meta = await importGame(lib, zipFile, { transcode: 'off' });
  assert.equal(meta.id, 'zip-quest');
  assert.equal(meta.engine, 'mv');
  assert.equal(meta.engineVersion, '1.6.1');
  assert.equal(meta.packaging, 'folder');
  const g = await lib.get('zip-quest');
  assert.ok(g.fileSet.has('index.html'));
  assert.ok(!g.fileSet.has('Game.exe'), 'desktop wrapper files are not copied');
  assert.equal(g.lower.get('data/system.json'), 'data/System.json');

  // re-import bumps the revision and keeps the id
  const again = await importGame(lib, zipFile, { id: 'zip-quest', transcode: 'off' });
  assert.equal(again.rev, 2);
});

test('imports a Dragonhouse/Halva packaged game', async () => {
  const work = await tmpdir();
  const rel = await makeGame(path.join(work, 'plain'), 'mv', { title: 'Halva Game' });
  const tree = await readTree(rel);
  const winNames = Object.fromEntries(Object.entries(tree).map(([k, v]) => ['\\' + k.replace(/\//g, '\\'), v]));
  const rel2 = path.join(work, 'release');
  await fsp.mkdir(path.join(rel2, 'GamePackages', 'Common'), { recursive: true });
  await fsp.writeFile(path.join(rel2, 'GamePackages', 'Common', 'All.halva2'), zlib.brotliCompressSync(buildTar(winNames)));
  const cfg = { config: { halvaPassword: '' }, packageList: { baseContent: [{ packageId: 'All', packageLocation: 'GamePackages/Common/All.halva2' }] } };
  await fsp.writeFile(path.join(rel2, 'GameConfig.sbcf'), zlib.brotliCompressSync(Buffer.from(JSON.stringify(cfg))));

  const lib = new Library(path.join(work, 'data'));
  const meta = await importGame(lib, rel2, { transcode: 'off' });
  assert.equal(meta.packaging, 'halva');
  assert.equal(meta.title, 'Halva Game');
  assert.ok((await lib.get(meta.id)).fileSet.has('js/rpg_core.js'));
});

test('rejects folders without an RPG Maker game', async () => {
  const work = await tmpdir();
  await fsp.mkdir(path.join(work, 'empty', 'stuff'), { recursive: true });
  const lib = new Library(path.join(work, 'data'));
  await assert.rejects(importGame(lib, path.join(work, 'empty')), /No RPG Maker MV\/MZ game found/);
});

test('imports Windows, Linux, macOS and Android builds; drops the NW.js runtime', async () => {
  const work = await tmpdir();
  const tree = await readTree(await makeGame(path.join(work, 'src'), 'mz', { title: 'Every Platform', extra: { 'data/empty.txt': '' } }));
  const under = (prefix, extra = {}) => Object.fromEntries([...Object.entries(tree).map(([k, v]) => [prefix + k, v]), ...Object.entries(extra)]);
  const pe = Buffer.alloc(128); pe.write('MZ', 0, 'latin1'); pe.writeUInt32LE(64, 0x3c); pe.write('PE\0\0', 64, 'latin1');
  const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
  const macho = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]);
  const builds = {
    'windows.zip': under('game-windows/', {
      'game-windows/Game.exe': pe, 'game-windows/nw.dll': pe, 'game-windows/resources.pak': 'x', 'game-windows/icudtl.dat': 'x',
      'game-windows/locales/en-US.pak': 'x', 'game-windows/credits.html': '<h1>Chromium credits</h1>',
      'game-windows/notes.txt': 'MZ is where it starts', // not a binary: must stay
    }),
    'linux.zip': under('game-linux/', { 'game-linux/Game': elf, 'game-linux/lib/libnw.so': elf, 'game-linux/swiftshader/libEGL.so': elf }),
    'macos.zip': under('game-macos/Game.app/Contents/Resources/app.nw/', { 'game-macos/Game.app/Contents/MacOS/nwjs': macho, 'game-macos/Game.app/Contents/Info.plist': '<plist/>' }),
    'android.apk': under('assets/www/', { 'AndroidManifest.xml': 'x', 'classes.dex': 'dex\n035', 'META-INF/MANIFEST.MF': 'x' }),
  };
  const lib = new Library(path.join(work, 'data'));
  for (const [name, entries] of Object.entries(builds)) {
    const file = path.join(work, name);
    await fsp.writeFile(file, buildZip(entries));
    const meta = await importGame(lib, file, { transcode: 'off', precompress: false, id: name.replace(/\W/g, '-') });
    const g = await lib.get(meta.id);
    assert.equal(meta.engine, 'mz', name);
    assert.ok(g.fileSet.has('js/rmmz_core.js') && g.fileSet.has('index.html'), name);
    assert.ok(g.fileSet.has('data/empty.txt'), `${name}: empty files survive`);
    for (const runtime of ['Game.exe', 'nw.dll', 'resources.pak', 'icudtl.dat', 'locales/en-US.pak', 'credits.html', 'Game', 'lib/libnw.so', 'swiftshader/libEGL.so', 'classes.dex', 'AndroidManifest.xml']) {
      assert.ok(!g.fileSet.has(runtime), `${name}: ${runtime} removed`);
    }
    if (name === 'windows.zip') assert.ok(g.fileSet.has('notes.txt'), 'text that merely starts with MZ stays');
  }
});
