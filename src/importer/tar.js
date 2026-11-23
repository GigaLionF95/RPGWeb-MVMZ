// Streaming tar extractor (ustar + pax + GNU long names) that accepts any
// readable stream, e.g. a Brotli/gzip decompressor. No dependencies.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { safeRelative } from './zip.js';
import { MAX_META_BYTES } from './limits.js';

function parseOctal(buf) {
  if (buf[0] & 0x80) { // GNU base-256 for large sizes
    let n = 0;
    for (let i = 1; i < buf.length; i++) n = n * 256 + buf[i];
    return n;
  }
  const s = buf.toString('latin1').replace(/\0.*$/s, '').trim();
  return s ? parseInt(s, 8) : 0;
}

function cstr(buf) {
  const i = buf.indexOf(0);
  return (i < 0 ? buf : buf.subarray(0, i)).toString('utf8');
}

function parsePax(buf) {
  const out = {};
  let p = 0;
  while (p < buf.length) {
    const sp = buf.indexOf(0x20, p);
    if (sp < 0) break;
    const len = parseInt(buf.toString('latin1', p, sp), 10);
    if (!len) break;
    const rec = buf.toString('utf8', sp + 1, p + len - 1);
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    p += len;
  }
  return out;
}

const write = (ws, chunk) => new Promise((res, rej) => {
  if (ws.write(chunk)) return res();
  const onDrain = () => { ws.off('error', onErr); res(); };
  const onErr = (e) => { ws.off('drain', onDrain); rej(e); };
  ws.once('drain', onDrain).once('error', onErr);
});
const finish = (ws) => new Promise((res, rej) => { ws.once('error', rej); ws.end(res); });

/**
 * Extract a tar stream into dest. Member names are normalised (backslashes,
 * drive letters, "..") so archives produced on Windows extract correctly.
 * Returns the list of extracted relative file paths.
 */
export async function extractTar(stream, dest, { onFile, budget } = {}) {
  let buf = Buffer.alloc(0);
  let pax = {};
  let longName = null;
  // current entry
  let dataLeft = 0;   // payload bytes still to consume
  let padLeft = 0;    // padding bytes after payload
  let sink = null;    // { kind: 'file'|'meta'|'skip', ws?, rel?, size?, chunks?, type? }
  const files = [];

  const begin = async (hdr) => {
    const type = String.fromCharCode(hdr[156] || 0x30);
    const size = parseOctal(hdr.subarray(124, 136));
    let name = cstr(hdr.subarray(0, 100));
    const prefix = cstr(hdr.subarray(345, 500));
    if (hdr.subarray(257, 262).toString('latin1') === 'ustar' && prefix) name = prefix + '/' + name;
    if (type !== 'x' && type !== 'g' && type !== 'L') {
      if (pax.path) name = pax.path;
      if (longName) name = longName;
    }
    const realSize = type !== 'x' && type !== 'g' && type !== 'L' && pax.size ? parseInt(pax.size, 10) : size;
    if (type !== 'x' && type !== 'g' && type !== 'L') { pax = {}; longName = null; }

    dataLeft = realSize;
    padLeft = (512 - (realSize % 512)) % 512;

    if (type === 'x' || type === 'g' || type === 'L') {
      if (realSize > MAX_META_BYTES) throw new Error('tar header record is too large');
      sink = { kind: 'meta', type, chunks: [] };
      return;
    }
    const rel = safeRelative(name);
    if (type === '5') {
      if (rel) await fsp.mkdir(path.join(dest, rel), { recursive: true });
      sink = { kind: 'skip' };
      return;
    }
    if ((type === '0' || type === '\0' || type === '7') && rel) {
      budget?.file();
      const out = path.join(dest, rel);
      await fsp.mkdir(path.dirname(out), { recursive: true });
      sink = { kind: 'file', rel, size: realSize, ws: fs.createWriteStream(out) };
      files.push(rel);
      return;
    }
    sink = { kind: 'skip' }; // links, devices, fifos
  };

  const end = async () => {
    if (sink?.kind === 'meta') {
      const data = Buffer.concat(sink.chunks);
      if (sink.type === 'x') pax = parsePax(data);
      else if (sink.type === 'L') longName = cstr(data);
    } else if (sink?.kind === 'file') {
      await finish(sink.ws);
      onFile?.(sink.rel, sink.size);
    }
    sink = null;
  };

  const process = async () => {
    for (;;) {
      if (sink) {
        if (dataLeft > 0) {
          if (!buf.length) return;
          const take = Math.min(dataLeft, buf.length);
          const part = buf.subarray(0, take);
          buf = buf.subarray(take);
          dataLeft -= take;
          if (sink.kind === 'file') { budget?.add(take); await write(sink.ws, part); }
          else if (sink.kind === 'meta') sink.chunks.push(Buffer.from(part));
          if (dataLeft > 0) return;
        }
        if (padLeft > 0) {
          const take = Math.min(padLeft, buf.length);
          buf = buf.subarray(take);
          padLeft -= take;
          if (padLeft > 0) return;
        }
        await end();
      }
      if (buf.length < 512) return;
      const hdr = buf.subarray(0, 512);
      buf = buf.subarray(512);
      if (hdr.every((b) => b === 0)) continue;
      await begin(hdr);
    }
  };

  for await (const chunk of stream) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    await process();
  }
  await process();
  if (sink) await end();
  return files;
}
