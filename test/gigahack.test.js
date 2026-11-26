// GigaHack mod menu: switched on per game, added to plugins.js at serve time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { Library } from '../src/library.js';
import { importGame } from '../src/importer/index.js';
import { startServer } from '../src/server/index.js';
import { gigahack } from '../src/gigahack.js';
import { tmpdir, makeGame } from './helpers.js';

const PLUGINS = 'var $plugins = [{"name":"Mine","status":true,"description":"","parameters":{}},{"name":"GigaHack_Core","status":false,"description":"","parameters":{}}];\n';

/** The $plugins list a browser would end up with after running plugins.js. */
function runPlugins(src) {
  const ctx = { window: {} };
  vm.runInNewContext(src + '\n;this.__list = JSON.stringify($plugins.map(function (p) { return [p.name, p.status]; }));', ctx);
  return JSON.parse(ctx.__list);
}

test('GigaHack: off by default, an admin switches it on per game, modules appended last', async () => {
  const gh = gigahack();
  assert.ok(gh && gh.modules.length > 10, 'vendored copy present');
  const work = await tmpdir();
  const lib = new Library(path.join(work, 'd'));
  await importGame(lib, await makeGame(path.join(work, 'g'), 'mz', { extra: { 'js/plugins.js': PLUGINS } }), { id: 'gh', transcode: 'off' });
  const s = await startServer({ dataDir: lib.dataDir, port: 0, host: '127.0.0.1', adminToken: 'tok', publicLibrary: true, maxUploadBytes: 1 << 20 }, lib);
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    const game = `${base}/play/gh/r1/`;
    let info = await (await fetch(`${base}/api/games/gh`)).json();
    assert.equal(info.gigahack, false);
    assert.equal(info.gigahackAvailable, true);
    let r = await fetch(game + 'js/plugins.js');
    const etagOff = r.headers.get('etag');
    assert.deepEqual(runPlugins(await r.text()).map((p) => p[0]), ['Mine', 'GigaHack_Core']);
    assert.equal((await fetch(game + 'js/plugins/GigaHack_Boot.js')).status, 404, 'no modules while off');

    r = await fetch(`${base}/api/games/gh`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gigahack: true }) });
    assert.equal(r.status, 401, 'admin only');
    r = await fetch(`${base}/api/games/gh`, { method: 'PATCH', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: JSON.stringify({ gigahack: true }) });
    assert.equal((await r.json()).gigahack, true);
    await new Promise((res) => setTimeout(res, 1100)); // the library re-reads meta.json after a second

    r = await fetch(game + 'js/plugins.js', { headers: { 'If-None-Match': etagOff } });
    assert.equal(r.status, 200, 'switching it on is a new plugins.js, not a 304');
    const list = runPlugins(await r.text());
    // The game's own GigaHack_Core entry (off) stays as it is; the rest follow in manifest order.
    assert.deepEqual(list[0], ['Mine', true]);
    assert.deepEqual(list[1], ['GigaHack_Core', false]);
    assert.deepEqual(list.slice(2).map((p) => p[0]), gh.modules.filter((n) => n !== 'GigaHack_Core'));
    assert.ok(list.slice(2).every((p) => p[1] === true));
    r = await fetch(game + 'js/plugins/GigaHack_Boot.js');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /javascript/);
    assert.ok((await r.text()).length > 1000);
    assert.equal((await fetch(game + 'js/plugins/GigaHack_Nope.js')).status, 404);
    assert.match((await (await fetch(game + 'js/plugins.js')).text()), /__RPGM\.hook\("plugins"\)/, 'runtime hook still last');

    r = await fetch(`${base}/api/games/gh`, { method: 'PATCH', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: JSON.stringify({ gigahack: false }) });
    assert.equal((await r.json()).gigahack, false);
    await new Promise((res) => setTimeout(res, 1100));
    assert.equal(runPlugins(await (await fetch(game + 'js/plugins.js')).text()).length, 2);
    assert.equal((await fetch(game + 'js/plugins/GigaHack_Boot.js')).status, 404);
  } finally { s.close(); }
});
