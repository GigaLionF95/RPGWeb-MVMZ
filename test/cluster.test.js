// A pool of three servers (primary + two replicas) in each placement mode,
// and the X-Accel-Redirect answers for nginx.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Library } from '../src/library.js';
import { importGame } from '../src/importer/index.js';
import { startServer } from '../src/server/index.js';
import { tmpdir, makeGame } from './helpers.js';

const TOKEN = 'pool-token';
const GB = 1024 ** 3;
const open = [];
after(() => { for (const s of open) s.close(); });

const cfg = (lib, extra) => ({ dataDir: lib.dataDir, port: 0, host: '127.0.0.1', adminToken: TOKEN, publicLibrary: true, maxUploadBytes: 1 << 24, syncIntervalMs: 3600e3, ...extra });
const addr = (s) => `http://127.0.0.1:${s.address().port}`;

async function pool(replicas, freeGB, unit = GB) {
  const work = await tmpdir();
  const libs = ['p', 'a', 'b'].map((n) => new Library(path.join(work, n)));
  const P = await startServer(cfg(libs[0], { replicas, nodeTimeoutMs: 3600e3 }), libs[0]);
  open.push(P);
  await P.cluster.tick();
  const reps = [];
  for (const lib of libs.slice(1)) {
    const s = await startServer(cfg(lib, { upstream: addr(P) }), lib);
    s.replica.advertise = addr(s);
    open.push(s);
    reps.push(s);
  }
  const nodes = [P, ...reps];
  nodes.forEach((s, i) => {
    const disk = async () => ({ free: freeGB[i] * unit, total: 100 * GB });
    if (s.cluster) s.cluster.diskSpace = disk; else s.replica.diskSpace = disk;
  });
  const converge = async (rounds = 4) => {
    for (let i = 0; i < rounds; i++) {
      for (const r of reps) if (r.listening) await r.replica.syncNow().catch(() => {});
      await P.cluster.tick();
    }
  };
  const holders = (id) => libs.map((l, i) => (fs.existsSync(l.rootDir(id)) ? 'pab'[i] : null)).filter(Boolean).join('');
  return { work, libs, P, reps, nodes, converge, holders };
}

async function addGame(lib, work, id, bytes) {
  const src = await makeGame(path.join(work, 'src-' + id), 'mv', { title: id, extra: { 'img/pictures/big.png': Buffer.alloc(bytes, 1) } });
  await importGame(lib, src, { id, transcode: 'off' });
}

test('RPGM_REPLICAS=1: each game lives on one server, every server serves all games', async () => {
  // Free disk (KB): primary 100, a 500, b 300.
  const c = await pool(1, [100, 500, 300], 1000);
  await addGame(c.libs[0], c.work, 'large', 300_000);
  await addGame(c.libs[0], c.work, 'small', 100_000);
  await c.converge();
  // Largest game first onto the emptiest server (a, 200 KB left after it),
  // the next one onto b, which now has the most room.
  assert.equal(c.holders('large'), 'a');
  assert.equal(c.holders('small'), 'b');
  // Every server lists every game and plays it (from the server that has it).
  const want = await (await fetch(`${addr(c.reps[0])}/play/large/r1/img/pictures/big.png`)).arrayBuffer();
  for (const s of c.nodes) {
    const list = await (await fetch(`${addr(s)}/api/games`)).json();
    assert.deepEqual(list.games.map((g) => g.id).sort(), ['large', 'small']);
    for (const id of ['large', 'small']) {
      const r = await fetch(`${addr(s)}/play/${id}/r1/img/pictures/big.png`);
      assert.equal(r.status, 200, `${id} via ${addr(s)}`);
      if (id === 'large') assert.equal(Buffer.compare(Buffer.from(await r.arrayBuffer()), Buffer.from(want)), 0);
    }
    assert.equal((await fetch(`${addr(s)}/play/small/r1/`)).status, 200);
    assert.equal((await fetch(`${addr(s)}/play/small/r1/js/rpg_core.js`)).status, 200, 'patched scripts too');
  }
  // A forwarded request never bounces on.
  const r = await fetch(`${addr(c.P)}/play/large/r1/js/main.js`, { headers: { 'X-Rpgm-Forwarded': '1' } });
  assert.equal(r.status, 404);

  // A new game goes to the server with the most room left, and the primary
  // drops its import copy once that server has it.
  c.reps[1].replica.diskSpace = async () => ({ free: 900_000, total: 100 * GB });
  await addGame(c.libs[0], c.work, 'newest', 50_000);
  await c.converge();
  assert.equal(c.holders('newest'), 'b');
  const sum = await (await fetch(`${addr(c.P)}/api/cluster`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  assert.equal(sum.mode, 1);
  assert.deepEqual(sum.placement.newest.length, 1);
});

test('RPGM_REPLICAS=2: two copies, and a dead server\'s games are copied elsewhere', async () => {
  const c = await pool(2, [40, 50, 30]);
  await addGame(c.libs[0], c.work, 'one', 200_000);
  await addGame(c.libs[0], c.work, 'two', 100_000);
  await c.converge();
  assert.equal(c.holders('one').length, 2);
  assert.equal(c.holders('two').length, 2);
  // Server a goes away for good.
  const dead = c.reps[0];
  await new Promise((res) => dead.close(res));
  c.P.cluster.timeoutMs = 50;
  await new Promise((res) => setTimeout(res, 80));
  await c.converge();
  for (const id of ['one', 'two']) {
    const h = c.holders(id).replace('a', '');
    assert.equal(h, 'pb', `${id} on the two live servers`);
  }
  for (const s of [c.P, c.reps[1]]) assert.equal((await fetch(`${addr(s)}/play/one/r1/img/pictures/big.png`)).status, 200);
});

test('RPGM_REPLICAS=all: every server has every file', async () => {
  const c = await pool('all', [10, 10, 10]);
  await addGame(c.libs[0], c.work, 'everywhere', 10_000);
  await c.converge(2);
  assert.equal(c.holders('everywhere'), 'pab');
});

test('nginx offload: X-Accel-Redirect for plain files, the server itself for the rest', async () => {
  const work = await tmpdir();
  const lib = new Library(path.join(work, 'd'));
  const src = await makeGame(path.join(work, 'g'), 'mz', { extra: { 'data/Big.json': JSON.stringify({ x: 'y'.repeat(5000) }), 'img/pictures/日本 語.png': 'png' } });
  await importGame(lib, src, { id: 'acc', transcode: 'off' });
  const s = await startServer(cfg(lib), lib);
  open.push(s);
  const get = (p, h = {}) => fetch(`${addr(s)}/play/acc/r1/${p}`, { headers: { 'X-Rpgm-Accel': '1', ...h } });
  const accel = (r) => { const v = r.headers.get('x-accel-redirect'); return v && Buffer.from(v, 'latin1').toString('utf8'); };

  let r = await get('data/Big.json', { 'Accept-Encoding': 'br' });
  assert.equal(accel(r), '/__rpgm_files_br/acc/precompressed/data/Big.json.br');
  assert.match(r.headers.get('content-type'), /json/);
  assert.match(r.headers.get('cache-control'), /immutable/);
  assert.equal(accel(await get('data/Big.json', { 'Accept-Encoding': 'gzip' })), '/__rpgm_files_gz/acc/precompressed/data/Big.json.gz');
  assert.equal(accel(await get('data/Big.json', { 'Accept-Encoding': 'identity' })), '/__rpgm_files/acc/game/data/Big.json');
  assert.equal(accel(await get('img/pictures/%E6%97%A5%E6%9C%AC%20%E8%AA%9E.png')), '/__rpgm_files/acc/game/img/pictures/日本 語.png');
  // Patched scripts and the game page are built by the server.
  r = await get('js/rmmz_core.js');
  assert.equal(r.headers.get('x-accel-redirect'), null);
  assert.match(await r.text(), /__RPGM/);
  assert.equal((await get('')).headers.get('x-accel-redirect'), null);
  // Without the header (no nginx in front) the server sends the file.
  r = await fetch(`${addr(s)}/play/acc/r1/data/Big.json`);
  assert.equal(r.headers.get('x-accel-redirect'), null);
  assert.equal(r.status, 200);
  assert.ok((await r.text()).includes('yyyy'));
});

test('nginx-snippet prints internal locations with the game headers', async () => {
  const { nginxSnippet } = await import('../src/nginx.js');
  const out = nginxSnippet({ gameSandbox: true, frameAncestors: 'https://forum.example' }, { root: '/srv/data/games' });
  assert.match(out, /location \/__rpgm_files\/ \{\n {4}internal;\n {4}alias \/srv\/data\/games\/;/);
  assert.match(out, /Content-Security-Policy "sandbox allow-scripts[^"]*; frame-ancestors 'self' https:\/\/forum\.example"/);
  assert.match(out, /__rpgm_files_br\/[\s\S]*Content-Encoding br/);
  assert.match(out, /proxy_pass http:\/\/\$rpgm_node\$request_uri;/);
});

test('copied files keep the exact millisecond mtime', async () => {
  const { copyGame, createSyncSource, localSource } = await import('../src/sync.js');
  const work = await tmpdir();
  const a = new Library(path.join(work, 'a'));
  const b = new Library(path.join(work, 'b'));
  await addGame(a, work, 'ms', 1000);
  // Times that floating-point seconds can't hold exactly.
  let i = 0;
  for (const [p] of (await a.get('ms')).files) {
    const t = (1763870000000 + 89 + (i++ % 7) * 101) / 1000 + 0.000867;
    await fs.promises.utimes(path.join(a.rootDir('ms'), p), t, t);
  }
  const src = createSyncSource(a);
  await fs.promises.mkdir(b.gameDir('ms'), { recursive: true });
  const fake = { name: 'a', list: (id, part) => localSource(a, src).list(id, part), fetch: (id, rel, dst) => fs.promises.copyFile(path.join(a.gameDir(id), rel), dst) };
  await copyGame(b, 'ms', { catalogFrom: fake, dataFrom: fake });
  for (const [p] of (await a.get('ms')).files) {
    const x = Math.floor(fs.statSync(path.join(a.rootDir('ms'), p)).mtimeMs);
    const y = Math.floor(fs.statSync(path.join(b.rootDir('ms'), p)).mtimeMs);
    assert.equal(y, x, p);
  }
});
