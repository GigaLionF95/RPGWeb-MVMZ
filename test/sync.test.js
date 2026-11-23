import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { Library } from '../src/library.js';
import { importGame } from '../src/importer/index.js';
import { startServer } from '../src/server/index.js';
import { tmpdir, makeGame, buildZip, readTree } from './helpers.js';

const TOKEN = 'cluster-token';
const auth = { Authorization: `Bearer ${TOKEN}` };
let work, plib, rlib, primary, replica, P, R;
const cfg = (lib, extra) => ({ dataDir: lib.dataDir, port: 0, host: '127.0.0.1', adminToken: TOKEN, publicLibrary: true, maxUploadBytes: 1 << 24, ...extra });

before(async () => {
  work = await tmpdir();
  plib = new Library(path.join(work, 'primary'));
  rlib = new Library(path.join(work, 'replica'));
  const src = await makeGame(path.join(work, 'g'), 'mz', { title: 'Synced', extra: { 'data/Big.json': JSON.stringify({ x: 'y'.repeat(5000) }) } });
  await importGame(plib, src, { id: 'synced', transcode: 'off' });
  primary = await startServer(cfg(plib), plib);
  P = `http://127.0.0.1:${primary.address().port}`;
  replica = await startServer(cfg(rlib, { upstream: P, syncIntervalMs: 3600e3 }), rlib);
  R = `http://127.0.0.1:${replica.address().port}`;
  await replica.replica.syncNow();
});
after(() => { replica.close(); primary.close(); });

test('sync endpoints need the admin token and stay inside the game', async () => {
  assert.equal((await fetch(`${P}/api/sync`)).status, 401);
  const list = await (await fetch(`${P}/api/sync`, { headers: auth })).json();
  assert.deepEqual(list.games.map((g) => g.id), ['synced']);
  assert.equal((await fetch(`${P}/api/sync/synced/file?path=../../config.json`, { headers: auth })).status, 404);
  const h = await (await fetch(`${R}/healthz`)).json();
  assert.equal(h.role, 'replica');
  assert.equal(h.sync.games, 1);
});

test('the replica serves the same files with the same ETags', async () => {
  for (const f of ['js/rmmz_core.js', 'data/Big.json', 'data/System.json']) {
    const [a, b] = await Promise.all([fetch(`${P}/play/synced/r1/${f}`), fetch(`${R}/play/synced/r1/${f}`)]);
    assert.equal(b.status, 200, f);
    assert.equal(a.headers.get('etag'), b.headers.get('etag'), f);
    assert.equal(await a.text(), await b.text(), f);
  }
  // precompressed copies came along and are valid on the replica
  assert.ok(await fsp.stat(path.join(rlib.gameDir('synced'), 'precompressed', 'data/Big.json.br')));
});

test('admin writes on the replica go to the primary and come back', async () => {
  const big = path.join(rlib.rootDir('synced'), 'data/Big.json');
  const inoBefore = (await fsp.stat(big)).ino;
  const r = await fetch(`${R}/api/games/synced`, { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Renamed' }) });
  assert.equal(r.status, 200);
  assert.equal((await plib.get('synced')).meta.title, 'Renamed');
  await replica.replica.syncNow();
  assert.equal((await rlib.get('synced')).meta.title, 'Renamed');
  assert.equal((await fsp.stat(big)).ino, inoBefore, 'unchanged files are reused, not downloaded again');
});

test('an upload through the replica is on the replica when the job says done', async () => {
  const src = await makeGame(path.join(work, 'up'), 'mv', { title: 'Uploaded via replica' });
  const up = await fetch(`${R}/api/games?filename=x.zip&id=via-replica`, { method: 'POST', headers: auth, body: buildZip(await readTree(src)) });
  assert.equal(up.status, 202);
  const { job } = await up.json();
  for (;;) {
    const j = await (await fetch(`${R}/api/jobs/${job}`, { headers: auth })).json();
    if (j.status === 'error') assert.fail(j.error);
    if (j.status === 'done') break;
    await new Promise((res) => setTimeout(res, 20));
  }
  assert.ok(await rlib.get('via-replica'), 'synced before the job reported done');
  assert.equal((await fetch(`${R}/play/via-replica/r1/js/rpg_core.js`)).status, 200);
});

test('deleting on the primary removes the game from the replica', async () => {
  assert.equal((await fetch(`${R}/api/games/via-replica`, { method: 'DELETE', headers: auth })).status, 200);
  await replica.replica.syncNow();
  assert.equal(await rlib.get('via-replica'), null);
  assert.equal((await fetch(`${R}/play/via-replica/`)).status, 404);
});
