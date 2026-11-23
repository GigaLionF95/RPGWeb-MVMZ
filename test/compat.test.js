// Compatibility details for plugins that work around the engine.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Library } from '../src/library.js';
import { importGame } from '../src/importer/index.js';
import { startServer } from '../src/server/index.js';
import { encrypt, decrypt } from '../src/importer/rpgcrypt.js';
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

// ---- lossless WebP --------------------------------------------------------
import zlib from 'node:zlib';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { findCwebp, pngBlocker } from '../src/importer/webp.js';

function crc(buf) { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return ~c >>> 0; }
function chunk(type, data) {
  const t = Buffer.from(type, 'latin1'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]);
}
/** An RGBA PNG stored without compression (big, like an unoptimized export). */
function makePng(w, h, { depth = 8, extra = [] } = {}) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = 6;
  const bpp = depth / 8 * 4;
  const raw = Buffer.alloc((w * bpp + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * bpp + 1) + 1 + x * bpp;
    raw[o] = x & 255; raw[o + bpp / 4] = y & 255; raw[o + bpp / 2] = (x ^ y) & 255; raw[o + bpp * 3 / 4] = x < 40 ? 0 : 255;
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), ...extra.map(([t, d]) => chunk(t, d)), chunk('IDAT', zlib.deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}
const rgba = (file) => spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 26 }).stdout;

test('pngBlocker keeps animated, 16-bit and colour-managed PNGs as they are', () => {
  assert.equal(pngBlocker(makePng(8, 8)), null);
  assert.equal(pngBlocker(makePng(8, 8, { depth: 16 })), '16-bit');
  assert.equal(pngBlocker(makePng(8, 8, { extra: [['acTL', Buffer.alloc(8)]] })), 'animated');
  assert.equal(pngBlocker(makePng(8, 8, { extra: [['gAMA', Buffer.alloc(4)]] })), 'colour profile');
  assert.equal(pngBlocker(Buffer.from('RIFF....WEBPVP8L')), 'not a PNG');
});

test('import turns large PNGs into lossless WebP with the same pixels', { skip: !findCwebp() && 'cwebp not installed' }, async () => {
  const work = await tmpdir();
  const lib = new Library(path.join(work, 'd'));
  const big = makePng(400, 300);
  const src = await makeGame(path.join(work, 'g'), 'mz', {
    extra: {
      'data/System.json': JSON.stringify({ gameTitle: 'Img', hasEncryptedImages: true, hasEncryptedAudio: false, encryptionKey: KEY, advanced: { gameId: 1, screenWidth: 816, screenHeight: 624 } }),
      'img/pictures/plain.png': big,
      'img/live2d/M/texture_00.png_': encrypt(big, KEY),
      'img/pictures/anim.png': makePng(400, 300, { extra: [['acTL', Buffer.alloc(8)]] }),
    },
  });
  const meta = await importGame(lib, src, { id: 'img', transcode: 'off' });
  assert.equal(meta.images.converted, 2);
  const plain = fs.readFileSync(path.join(lib.rootDir('img'), 'img/pictures/plain.png'));
  assert.equal(plain.toString('latin1', 8, 12), 'WEBP');
  assert.ok(plain.length < big.length / 2);
  const enc = decrypt(fs.readFileSync(path.join(lib.rootDir('img'), 'img/live2d/M/texture_00.png_')), KEY);
  assert.equal(enc.toString('latin1', 8, 12), 'WEBP', 'encrypted image converted and encrypted again');
  assert.ok(fs.readFileSync(path.join(lib.rootDir('img'), 'img/pictures/anim.png')).subarray(1, 4).toString() === 'PNG', 'animated PNG untouched');
  // files.json lists the new sizes
  const listed = Object.fromEntries((await lib.get('img')).files);
  assert.equal(listed['img/pictures/plain.png'], plain.length);
  if (spawnSync('ffmpeg', ['-version']).status === 0) {
    fs.writeFileSync(path.join(work, 'orig.png'), big);
    assert.ok(rgba(path.join(work, 'orig.png')).equals(rgba(path.join(lib.rootDir('img'), 'img/pictures/plain.png'))), 'identical pixels');
  }
});

test('Live2D preload: on by default for Live2D games, per-game switch, page revalidates', async () => {
  const work = await tmpdir();
  const lib = new Library(path.join(work, 'd'));
  const src = await makeGame(path.join(work, 'g'), 'mz', { extra: { 'img/live2d/Hero/hero.model3.json': '{}', 'img/live2d/Hero/hero.moc3': 'moc' } });
  const meta = await importGame(lib, src, { id: 'l2d', transcode: 'off' });
  assert.equal(meta.live2d, true);
  const s = await startServer({ dataDir: lib.dataDir, port: 0, host: '127.0.0.1', adminToken: 'tok', publicLibrary: true, maxUploadBytes: 1 << 20, preload: 'live2d' }, lib);
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    let r = await fetch(`${base}/play/l2d/r1/`);
    const etag1 = r.headers.get('etag');
    assert.match(await r.text(), /"preload":\["img\/live2d\/"\]/);
    const g = await (await fetch(`${base}/api/games/l2d`)).json();
    assert.equal(g.live2d, true); assert.equal(g.preloadOn, true); assert.equal(g.preloadDefault, true);
    r = await fetch(`${base}/api/games/l2d`, { method: 'PATCH', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: JSON.stringify({ preload: false }) });
    assert.equal((await r.json()).preloadOn, false);
    await new Promise((res) => setTimeout(res, 1100)); // the library re-reads meta.json after a second
    r = await fetch(`${base}/play/l2d/r1/`, { headers: { 'If-None-Match': etag1 } });
    assert.equal(r.status, 200, 'changed settings are a new page, not a 304');
    assert.match(await r.text(), /"preload":null/);
  } finally { s.close(); }
});
