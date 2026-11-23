// Compatibility details for plugins that work around the engine.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Library } from '../src/library.js';
import { importGame } from '../src/importer/index.js';
import { startServer } from '../src/server/index.js';
import { encrypt } from '../src/importer/rpgcrypt.js';
import { tmpdir, makeGame } from './helpers.js';

const KEY = '0123456789abcdef0123456789abcdef';
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(64, 7)]);
let server;
after(() => server?.close());

test('a plain-name request for an encrypted image gets it decrypted; game scripts load in CORS mode', async () => {
  const work = await tmpdir();
  const lib = new Library(path.join(work, 'd'));
  const src = await makeGame(path.join(work, 'g'), 'mz', {
    extra: {
      'data/System.json': JSON.stringify({ gameTitle: 'Enc', hasEncryptedImages: true, hasEncryptedAudio: false, encryptionKey: KEY, advanced: { gameId: 1, screenWidth: 816, screenHeight: 624 } }),
      'img/live2d/M/texture_00.png_': encrypt(PNG, KEY),
    },
  });
  await importGame(lib, src, { id: 'enc', transcode: 'off' });
  server = await startServer({ dataDir: lib.dataDir, port: 0, host: '127.0.0.1', adminToken: 't', publicLibrary: true, maxUploadBytes: 1 << 20 }, lib);
  const base = `http://127.0.0.1:${server.address().port}/play/enc/r1/`;

  const plain = await fetch(base + 'img/live2d/M/texture_00.png');
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get('content-type'), 'image/png');
  assert.equal(plain.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(Buffer.from(await plain.arrayBuffer()), PNG);
  const raw = Buffer.from(await (await fetch(base + 'img/live2d/M/texture_00.png_')).arrayBuffer());
  assert.equal(raw.length, PNG.length + 16, 'the encrypted file itself is unchanged');
  assert.equal((await fetch(base + 'img/live2d/M/missing.png')).status, 404);

  const html = await (await fetch(base)).text();
  assert.match(html, /<script crossorigin="anonymous" data-cfasync="false" src="js\/main\.js">/);
  assert.match(html, /crossorigin="anonymous" src="__rpgm\/runtime\.js/);
});
