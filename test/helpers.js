// Fixture builders: tiny synthetic MV/MZ games and archives, no binaries in git.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export async function tmpdir(prefix = 'rpgm-test-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Write a minimal game tree; returns root. */
export async function makeGame(dir, engine = 'mv', { title = 'Test Game', extra = {} } = {}) {
  const core = engine === 'mz' ? 'rmmz_core.js' : 'rpg_core.js';
  const files = {
    'index.html': `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="user-scalable=no"><title>${title}</title></head><body><script src="js/main.js"></script></body></html>`,
    [`js/${core}`]: `Utils.RPGMAKER_VERSION = "${engine === 'mz' ? '1.9.0' : '1.6.1'}";`,
    'js/main.js': '// main',
    'js/plugins.js': 'var $plugins = [];',
    'data/System.json': JSON.stringify({ gameTitle: title, hasEncryptedImages: false, hasEncryptedAudio: false, advanced: { gameId: 12345, screenWidth: 1280, screenHeight: 720 } }),
    'img/system/Window.png': 'png',
    'audio/bgm/Theme.ogg': 'ogg',
    'icon/icon.png': 'png',
    ...extra,
  };
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, body);
  }
  return dir;
}

// --- writers -------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** Build a zip (deflate) from { name: Buffer|string }. */
export function buildZip(entries, { prefix = Buffer.alloc(0) } = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, body] of Object.entries(entries)) {
    const data = Buffer.from(body);
    // Real archivers store empty files (method 0, no data).
    const method = data.length ? 8 : 0;
    const comp = method ? zlib.deflateRawSync(data) : Buffer.alloc(0);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8); eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([prefix, ...locals, cd, eocd]);
}

/** Build a ustar tar from { name: Buffer|string } (names may contain backslashes). */
export function buildTar(entries) {
  const out = [];
  for (const [name, body] of Object.entries(entries)) {
    const data = Buffer.from(body);
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    out.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  out.push(Buffer.alloc(1024));
  return Buffer.concat(out);
}

export async function readTree(dir) {
  const out = {};
  const walk = async (d, rel) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(d, e.name), r);
      else out[r] = fs.readFileSync(path.join(d, e.name), 'utf8');
    }
  };
  await walk(dir, '');
  return out;
}
