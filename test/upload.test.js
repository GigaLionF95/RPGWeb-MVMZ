// Chunked uploads: archives in pieces (CDNs cap request bodies), resumable.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Library } from '../src/library.js';
import { startServer } from '../src/server/index.js';
import { tmpdir, makeGame, buildZip, readTree } from './helpers.js';

const TOKEN = 'up-token';
const auth = { Authorization: `Bearer ${TOKEN}` };
const open = [];
after(() => { for (const s of open) s.close(); });
const cfg = (lib, extra) => ({ dataDir: lib.dataDir, port: 0, host: '127.0.0.1', adminToken: TOKEN, publicLibrary: true, maxUploadBytes: 1 << 24, syncIntervalMs: 3600e3, ...extra });
const addr = (s) => `http://127.0.0.1:${s.address().port}`;

async function waitJob(base, job) {
  for (;;) {
    const j = await (await fetch(`${base}/api/jobs/${job}`, { headers: auth })).json();
    if (j.status === 'error') assert.fail(j.error);
    if (j.status === 'done') return j;
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function pieces(base, zip, size = 1000) {
  const s = await fetch(`${base}/api/uploads?filename=game.zip&size=${zip.length}`, { method: 'POST', headers: auth });
  assert.equal(s.status, 201);
  const { upload } = await s.json();
  for (let o = 0; o < zip.length; o += size) {
    const r = await fetch(`${base}/api/uploads/${upload}?offset=${o}`, { method: 'PUT', headers: auth, body: zip.subarray(o, o + size) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).received, Math.min(zip.length, o + size));
  }
  return upload;
}

test('an archive sent in pieces is imported; mismatches and limits are reported', async () => {
  const work = await tmpdir();
  const lib = new Library(path.join(work, 'd'));
  const s = await startServer(cfg(lib), lib);
  open.push(s);
  const base = addr(s);
  const zip = buildZip(await readTree(await makeGame(path.join(work, 'g'), 'mv', { title: 'In Pieces', extra: { 'img/pictures/noise.png': (await import('node:crypto')).randomBytes(5000) } })));
  assert.ok(zip.length > 2000);

  // needs the token, and a size within the limit
  assert.equal((await fetch(`${base}/api/uploads?filename=a.zip&size=10`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/api/uploads?filename=a.zip&size=${(1 << 24) + 1}`, { method: 'POST', headers: auth })).status, 413);

  const { upload } = await (await fetch(`${base}/api/uploads?filename=game.zip&size=${zip.length}`, { method: 'POST', headers: auth })).json();
  const put = (o, b) => fetch(`${base}/api/uploads/${upload}?offset=${o}`, { method: 'PUT', headers: auth, body: b });
  assert.equal((await put(0, zip.subarray(0, 1000))).status, 200);
  // a resent piece (lost reply): the server says where it is
  const again = await put(0, zip.subarray(0, 1000));
  assert.equal(again.status, 409);
  assert.equal((await again.json()).received, 1000);
  // finishing early is refused
  assert.equal((await fetch(`${base}/api/uploads/${upload}/finish`, { method: 'POST', headers: auth })).status, 409);
  // more than the declared size is refused, and leaves nothing behind
  assert.equal((await put(1000, Buffer.concat([zip.subarray(1000), Buffer.alloc(10)]))).status, 413);
  assert.equal((await (await fetch(`${base}/api/uploads/${upload}`, { headers: auth })).json()).received, 1000);
  assert.equal((await put(1000, zip.subarray(1000))).status, 200);
  const fin = await fetch(`${base}/api/uploads/${upload}/finish?id=pieces`, { method: 'POST', headers: auth });
  assert.equal(fin.status, 202);
  const j = await waitJob(base, (await fin.json()).job);
  assert.equal(j.game.id, 'pieces');
  assert.equal((await fetch(`${base}/play/pieces/r1/js/rpg_core.js`)).status, 200);
  // the upload is gone once finished
  assert.equal((await fetch(`${base}/api/uploads/${upload}`, { headers: auth })).status, 404);
});

test('pieces sent to a replica end up on the primary and come back', async () => {
  const work = await tmpdir();
  const plib = new Library(path.join(work, 'p'));
  const rlib = new Library(path.join(work, 'r'));
  const P = await startServer(cfg(plib), plib);
  open.push(P);
  const R = await startServer(cfg(rlib, { upstream: addr(P) }), rlib);
  open.push(R);
  const zip = buildZip(await readTree(await makeGame(path.join(work, 'g'), 'mz', { title: 'Via Replica' })));
  const upload = await pieces(addr(R), zip, 700);
  const fin = await fetch(`${addr(R)}/api/uploads/${upload}/finish?id=via-rep`, { method: 'POST', headers: auth });
  assert.equal(fin.status, 202);
  await waitJob(addr(R), (await fin.json()).job);
  assert.ok(await plib.get('via-rep'), 'imported on the primary');
  assert.ok(await rlib.get('via-rep'), 'and on the replica when the job says done');
});
