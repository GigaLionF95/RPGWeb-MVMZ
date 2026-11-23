import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Library } from '../src/library.js';
import { importGame } from '../src/importer/index.js';
import { startServer } from '../src/server/index.js';
import { tmpdir, makeGame, buildZip, readTree } from './helpers.js';
import fsp from 'node:fs/promises';

let server, base, lib, work;
const TOKEN = 'test-token-123';

before(async () => {
  work = await tmpdir();
  lib = new Library(path.join(work, 'data'));
  await importGame(lib, await makeGame(path.join(work, 'g'), 'mz', { title: 'Served Game' }), { id: 'served', transcode: 'off' });
  server = await startServer({ dataDir: lib.dataDir, port: 0, host: '127.0.0.1', adminToken: TOKEN, publicLibrary: true, maxUploadBytes: 50 * 1024 * 1024 }, lib);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('redirects to the revisioned URL and injects the runtime', async () => {
  const r = await fetch(`${base}/play/served/?mute=1`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'r1/?mute=1');
  const html = await (await fetch(`${base}/play/served/r1/`)).text();
  assert.match(html, /__RPGM_CONFIG=/);
  assert.match(html, /__rpgm\/runtime\.js/);
  assert.match(html, /width=device-width/);
});

test('serves files case-insensitively with immutable caching and hooks core scripts', async () => {
  const r = await fetch(`${base}/play/served/r1/DATA/system.JSON`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /immutable/);
  const core = await (await fetch(`${base}/play/served/r1/js/rmmz_core.js`)).text();
  assert.match(core, /__RPGM\.hook\("core"\)/);
  assert.equal((await fetch(`${base}/play/served/r1/nope.png`)).status, 404);
  assert.equal((await fetch(`${base}/play/served/r1/__rpgm/runtime.js`)).status, 200);
  const files = await (await fetch(`${base}/play/served/r1/__rpgm/files.json`)).json();
  assert.ok(files.some(([p]) => p === 'index.html'));
});

test('supports byte ranges', async () => {
  const r = await fetch(`${base}/play/served/r1/audio/bgm/Theme.ogg`, { headers: { Range: 'bytes=1-2' } });
  assert.equal(r.status, 206);
  assert.equal(await r.text(), 'gg');
});

test('admin API: auth, upload, rename, hide, delete', async () => {
  assert.equal((await fetch(`${base}/api/games`, { method: 'POST', body: 'x' })).status, 401);
  const games = await (await fetch(`${base}/api/games`)).json();
  assert.equal(games.games.length, 1);
  assert.equal(games.games[0].encryption.key, undefined, 'encryption key is not exposed');

  const src = await makeGame(path.join(work, 'up'), 'mv', { title: 'Uploaded' });
  const zip = buildZip(await readTree(src));
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const up = await fetch(`${base}/api/games?filename=up.zip&id=uploaded`, { method: 'POST', headers: auth, body: zip });
  assert.equal(up.status, 202);
  const { job } = await up.json();
  let j;
  for (let i = 0; i < 50; i++) {
    j = await (await fetch(`${base}/api/jobs/${job}`, { headers: auth })).json();
    if (j.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(j.status, 'done', j.error);
  assert.equal(j.game.id, 'uploaded');

  const patched = await (await fetch(`${base}/api/games/uploaded`, { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Renamed', hidden: true }) })).json();
  assert.equal(patched.title, 'Renamed');
  const publicList = await (await fetch(`${base}/api/games`)).json();
  assert.ok(!publicList.games.some((g) => g.id === 'uploaded'), 'hidden games are not listed publicly');

  assert.equal((await fetch(`${base}/api/games/uploaded`, { method: 'DELETE', headers: auth })).status, 200);
  assert.equal((await fetch(`${base}/play/uploaded/r1/`)).status, 404);
  await assert.rejects(fsp.access(path.join(lib.gamesDir, 'uploaded')));
});

test('embed page, frame policy and cover art', async () => {
  const { encrypt } = await import('../src/importer/rpgcrypt.js');
  const key = '00112233445566778899aabbccddeeff';
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('fake-png-body-0123456789')]);
  const dir = await makeGame(path.join(work, 'emb'), 'mz', {
    title: 'Embed Me',
    extra: {
      'data/System.json': JSON.stringify({ gameTitle: 'Embed Me', title1Name: 'Castle', hasEncryptedImages: true, encryptionKey: key, advanced: { gameId: 7, screenWidth: 1280, screenHeight: 720 } }),
      'img/titles1/Castle.png_': encrypt(png, key),
    },
  });
  await importGame(lib, dir, { id: 'emb', transcode: 'off' });

  const page = await fetch(`${base}/embed/emb/`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-frame-options'), null, 'embeds can be framed');
  const html = await page.text();
  assert.match(html, /"play":"\.\.\/\.\.\/play\/emb\/\?embed=1"/);
  assert.match(html, /"screen":\{"width":1280,"height":720\}/);
  assert.equal((await fetch(`${base}/`)).headers.get('x-frame-options'), 'SAMEORIGIN', 'admin UI cannot be framed');

  const cover = await fetch(`${base}/api/games/emb/cover`);
  assert.equal(cover.status, 200);
  assert.deepEqual(Buffer.from(await cover.arrayBuffer()), png, 'encrypted title art is decrypted');

  const auth = { Authorization: `Bearer ${TOKEN}` };
  assert.equal((await fetch(`${base}/api/games/emb/cover`, { method: 'PUT', body: png })).status, 401);
  const put = await fetch(`${base}/api/games/emb/cover`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'image/webp' }, body: Buffer.from('RIFFxxxxWEBP') });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).customCover, true);
  const custom = await fetch(`${base}/api/games/emb/cover`);
  assert.equal(custom.headers.get('content-type'), 'image/webp');
});

test('API-only mode hides the library but keeps games, embeds and the SDK', async () => {
  const api = await startServer({ dataDir: lib.dataDir, port: 0, host: '127.0.0.1', adminToken: TOKEN, publicLibrary: true, apiOnly: true, maxUploadBytes: 1024 }, lib);
  const b = `http://127.0.0.1:${api.address().port}`;
  try {
    assert.equal((await fetch(`${b}/`)).status, 404);
    assert.equal((await fetch(`${b}/assets/app.js`)).status, 404);
    assert.equal((await fetch(`${b}/api/games`)).status, 401);
    assert.equal((await fetch(`${b}/api/games`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
    assert.equal((await fetch(`${b}/play/served/r1/`)).status, 200);
    assert.equal((await fetch(`${b}/embed/served/`)).status, 200);
    const sdk = await fetch(`${b}/sdk/rpgm-embed.js`);
    assert.equal(sdk.status, 200);
    assert.equal(sdk.headers.get('access-control-allow-origin'), '*');
    assert.match(await sdk.text(), /RPGMWeb/);
    const info = await fetch(`${b}/api/games/served`);
    assert.equal(info.headers.get('access-control-allow-origin'), '*');
  } finally { api.close(); }
});

test('uploads are imported one at a time', async () => {
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const zips = await Promise.all(['q1', 'q2', 'q3'].map(async (n) => buildZip(await readTree(await makeGame(path.join(work, n), 'mz', { title: n })))));
  const ids = await Promise.all(zips.map(async (zip, i) => {
    const r = await fetch(`${base}/api/games?filename=q.zip&id=queue-${i}`, { method: 'POST', headers: auth, body: zip });
    return (await r.json()).job;
  }));
  let maxActive = 0;
  for (;;) {
    const js = await Promise.all(ids.map(async (id) => (await fetch(`${base}/api/jobs/${id}`, { headers: auth })).json()));
    maxActive = Math.max(maxActive, js.filter((j) => j.status === 'running' && j.phase !== 'queued').length);
    if (js.every((j) => j.status !== 'running')) { assert.ok(js.every((j) => j.status === 'done'), JSON.stringify(js.map((j) => j.error))); break; }
    await new Promise((r) => setTimeout(r, 1));
  }
  assert.equal(maxActive <= 1, true);
});
