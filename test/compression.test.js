import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import fsp from 'node:fs/promises';
import { Library } from '../src/library.js';
import { importGame, refreshGame } from '../src/importer/index.js';
import { startServer } from '../src/server/index.js';
import { patchScript } from '../src/server/inject.js';
import { tmpdir, makeGame } from './helpers.js';

let server, base, lib, work;
const BIG_JSON = JSON.stringify(Array.from({ length: 4000 }, (_, i) => ({ id: i, name: `Item ${i}`, note: 'potion '.repeat(5) })));
const CORE = '// core\n' + 'function f(){return 1}\n'.repeat(500);

/** Raw GET (no automatic decompression), so the test sees what went over the wire. */
function raw(urlPath, enc) {
  return new Promise((resolve, reject) => {
    http.get(base + urlPath, { headers: enc ? { 'Accept-Encoding': enc } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
const decode = (r) => {
  const e = r.headers['content-encoding'];
  return e === 'br' ? zlib.brotliDecompressSync(r.body) : e === 'gzip' ? zlib.gunzipSync(r.body) : r.body;
};

before(async () => {
  work = await tmpdir();
  lib = new Library(path.join(work, 'data'));
  const src = await makeGame(path.join(work, 'g'), 'mz', {
    title: 'Packed',
    extra: { 'data/Items.json': BIG_JSON, 'js/rmmz_core.js': CORE },
  });
  await importGame(lib, src, { id: 'packed', transcode: 'off' });
  server = await startServer({ dataDir: lib.dataDir, port: 0, host: '127.0.0.1', adminToken: 'x', publicLibrary: true, maxUploadBytes: 1 << 20 }, lib);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('import writes brotli and gzip copies of text files', async () => {
  const dir = path.join(lib.gameDir('packed'), 'precompressed');
  const index = JSON.parse(await fsp.readFile(path.join(dir, 'index.json'), 'utf8'));
  const e = index.files['data/Items.json'];
  assert.ok(e && e.br && e.gzip, 'Items.json precompressed');
  assert.ok(e.br < BIG_JSON.length / 5);
  assert.ok(index.files['js/rmmz_core.js'].patch, 'hooked script stored patched');
  assert.equal(index.files['index.html'], undefined, 'index.html is patched per request');
  const br = await fsp.readFile(path.join(dir, 'data/Items.json.br'));
  assert.equal(zlib.brotliDecompressSync(br).toString(), BIG_JSON);
});

test('serves the precompressed copy byte for byte', async () => {
  const onDisk = await fsp.readFile(path.join(lib.gameDir('packed'), 'precompressed', 'data/Items.json.br'));
  const r = await raw('/play/packed/r1/data/Items.json', 'br, gzip');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-encoding'], 'br');
  assert.equal(Number(r.headers['content-length']), onDisk.length);
  assert.deepEqual(r.body, onDisk);
  const g = await raw('/play/packed/r1/data/Items.json', 'gzip');
  assert.equal(g.headers['content-encoding'], 'gzip');
  assert.equal(decode(g).toString(), BIG_JSON);
  const plain = await raw('/play/packed/r1/data/Items.json');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.body.toString(), BIG_JSON);
});

test('hooked engine scripts come out patched either way', async () => {
  const want = patchScript(Buffer.from(CORE), 'core').toString();
  assert.equal(decode(await raw('/play/packed/r1/js/rmmz_core.js', 'br')).toString(), want);
  assert.equal((await raw('/play/packed/r1/js/rmmz_core.js')).body.toString(), want);
});

test('a changed source file falls back to on-the-fly compression', async () => {
  const file = path.join(lib.rootDir('packed'), 'data/Items.json');
  const changed = BIG_JSON.replace('Item 1"', 'Item one"');
  await fsp.writeFile(file, changed);
  // Many parallel requests: compressed once, all get the new content.
  const rs = await Promise.all(Array.from({ length: 8 }, () => raw('/play/packed/r1/data/Items.json', 'br')));
  for (const r of rs) assert.equal(decode(r).toString(), changed);
  // refresh rebuilds the copies for the new content
  await refreshGame(lib, 'packed', {});
  const br = await fsp.readFile(path.join(lib.gameDir('packed'), 'precompressed', 'data/Items.json.br'));
  assert.equal(zlib.brotliDecompressSync(br).toString(), changed);
  const r = await raw('/play/packed/r1/data/Items.json', 'br');
  assert.deepEqual(r.body, br);
});

test('files.json and web assets compress asynchronously', async () => {
  const f = await raw('/play/packed/r1/__rpgm/files.json', 'br');
  assert.equal(f.headers['content-encoding'], 'br');
  assert.ok(JSON.parse(decode(f)).some(([p]) => p === 'data/Items.json'));
  const rt = await raw('/play/packed/r1/__rpgm/runtime.js', 'gzip');
  assert.equal(rt.headers['content-encoding'], 'gzip');
  assert.match(decode(rt).toString(), /__RPGM/);
});
