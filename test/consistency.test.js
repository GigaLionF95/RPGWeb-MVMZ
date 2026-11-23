// The admin sees their own changes at once, whichever server or worker answers.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Library } from '../src/library.js';
import { importGame } from '../src/importer/index.js';
import { startServer } from '../src/server/index.js';
import { tmpdir, makeGame } from './helpers.js';

const TOKEN = 'cons-token';
const auth = { Authorization: `Bearer ${TOKEN}` };
const open = [];
after(() => { for (const s of open) s.close(); });
const cfg = (lib, extra) => ({ dataDir: lib.dataDir, port: 0, host: '127.0.0.1', adminToken: TOKEN, publicLibrary: true, maxUploadBytes: 1 << 20, syncIntervalMs: 3600e3, ...extra });
const addr = (s) => `http://127.0.0.1:${s.address().port}`;
const listed = async (base, headers = {}) => Object.fromEntries((await (await fetch(`${base}/api/games`, { headers })).json()).games.map((g) => [g.id, g]));

test('a change made through one server shows at once in the admin list of another', async () => {
  const work = await tmpdir();
  const plib = new Library(path.join(work, 'p'));
  const rlib = new Library(path.join(work, 'r'));
  await importGame(plib, await makeGame(path.join(work, 'g'), 'mv', { title: 'Old' }), { id: 'g1', transcode: 'off' });
  const P = await startServer(cfg(plib), plib); open.push(P);
  const R = await startServer(cfg(rlib, { upstream: addr(P) }), rlib); open.push(R);
  await R.replica.syncNow();
  // a second worker of the primary: same data folder, its own caches
  const P2lib = new Library(plib.dataDir);
  const P2 = await startServer(cfg(P2lib), P2lib); open.push(P2);
  assert.equal((await listed(addr(P2), auth)).g1.title, 'Old'); // warm its cache

  const r = await fetch(`${addr(R)}/api/games/g1`, { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ hidden: true, title: 'New' }) });
  assert.equal(r.status, 200);
  for (const s of [R, P, P2]) {
    const g = (await listed(addr(s), auth)).g1;
    assert.equal(g.hidden, true, `hidden via ${addr(s)}`);
    assert.equal(g.title, 'New', `title via ${addr(s)}`);
    assert.equal((await (await fetch(`${addr(s)}/api/games/g1`, { headers: auth })).json()).title, 'New');
  }
  // deleting: gone from every admin list right away
  assert.equal((await fetch(`${addr(R)}/api/games/g1`, { method: 'DELETE', headers: auth })).status, 200);
  for (const s of [R, P, P2]) assert.equal((await listed(addr(s), auth)).g1, undefined, `deleted via ${addr(s)}`);
});
