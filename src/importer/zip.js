// Minimal streaming ZIP reader: stored/deflate, ZIP64, archives appended to
// other files (NW.js exes with package.nw glued on the end). No dependencies.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { decodeName } from './names.js';
import { MAX_META_BYTES } from './limits.js';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const { bytesRead } = await fh.read(buf, off, len - off, pos + off);
    if (!bytesRead) break;
    off += bytesRead;
  }
  return off === len ? buf : buf.subarray(0, off);
}

/** Find the end-of-central-directory record; returns null if not a zip. */
async function findEocd(fh, size) {
  const maxBack = Math.min(size, 0xffff + 22);
  const tail = await readAt(fh, size - maxBack, maxBack);
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD) {
      const commentLen = tail.readUInt16LE(i + 20);
      if (i + 22 + commentLen <= tail.length) return { pos: size - maxBack + i, buf: tail.subarray(i) };
    }
  }
  return null;
}

export class ZipArchive {
  constructor(file) {
    this.file = file;
    this.entries = [];
  }

  static async open(file) {
    const z = new ZipArchive(file);
    z.fh = await fsp.open(file, 'r');
    try {
      await z._readDirectory();
    } catch (e) {
      await z.close();
      throw e;
    }
    return z;
  }

  static async isZip(file) {
    let fh;
    try {
      fh = await fsp.open(file, 'r');
      const { size } = await fh.stat();
      if (size < 22) return false;
      return !!(await findEocd(fh, size));
    } catch {
      return false;
    } finally {
      await fh?.close();
    }
  }

  async close() {
    await this.fh?.close();
    this.fh = null;
  }

  async _readDirectory() {
    const { size } = await this.fh.stat();
    const eocd = await findEocd(this.fh, size);
    if (!eocd) throw new Error('not a zip archive');
    let total = eocd.buf.readUInt16LE(10);
    let cdSize = eocd.buf.readUInt32LE(12);
    let cdOffset = eocd.buf.readUInt32LE(16);
    let cdEnd = eocd.pos;

    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = await readAt(this.fh, eocd.pos - 20, 20);
      if (loc.readUInt32LE(0) === SIG_EOCD64_LOC) {
        const e64pos = Number(loc.readBigUInt64LE(8));
        let e64 = await readAt(this.fh, e64pos, 56);
        let realPos = e64pos;
        if (e64.readUInt32LE(0) !== SIG_EOCD64) {
          // Archive is prefixed by something (exe): search backwards for the record.
          realPos = eocd.pos - 20 - 56;
          e64 = await readAt(this.fh, realPos, 56);
          if (e64.readUInt32LE(0) !== SIG_EOCD64) throw new Error('broken zip64 directory');
        }
        total = Number(e64.readBigUInt64LE(32));
        cdSize = Number(e64.readBigUInt64LE(40));
        cdOffset = Number(e64.readBigUInt64LE(48));
        cdEnd = realPos;
      }
    }

    // When the zip is appended to another file, stored offsets are relative to
    // the start of the zip, not of the file.
    this.bias = cdEnd - cdSize - cdOffset;
    if (this.bias < 0) this.bias = 0;
    const cd = await readAt(this.fh, cdOffset + this.bias, cdSize);
    let p = 0;
    for (let i = 0; i < total && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== SIG_CEN) throw new Error('broken zip central directory');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const extAttr = cd.readUInt32LE(p + 38);
      let lho = cd.readUInt32LE(p + 42);
      const rawName = cd.subarray(p + 46, p + 46 + nameLen);
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      // ZIP64 extended info
      for (let q = 0; q + 4 <= extra.length; ) {
        const id = extra.readUInt16LE(q);
        const len = extra.readUInt16LE(q + 2);
        if (id === 0x0001) {
          let r = q + 4;
          if (usize === 0xffffffff) { usize = Number(extra.readBigUInt64LE(r)); r += 8; }
          if (csize === 0xffffffff) { csize = Number(extra.readBigUInt64LE(r)); r += 8; }
          if (lho === 0xffffffff) { lho = Number(extra.readBigUInt64LE(r)); r += 8; }
        }
        q += 4 + len;
      }
      const name = decodeName(rawName, (flags & 0x800) !== 0).replace(/\\/g, '/');
      const isDir = name.endsWith('/') || (extAttr & 0x10) !== 0;
      this.entries.push({ name, method, flags, csize, usize, lho, isDir, encrypted: (flags & 1) !== 0 });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  async _dataOffset(entry) {
    const h = await readAt(this.fh, entry.lho + this.bias, 30);
    if (h.readUInt32LE(0) !== SIG_LOC) throw new Error(`broken local header for ${entry.name}`);
    return entry.lho + this.bias + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  }

  /** Readable stream of the decompressed entry. */
  async stream(entry) {
    if (entry.encrypted) throw new Error(`password-protected zip entries are not supported (${entry.name})`);
    // Empty entries (0-byte files) have no data to read.
    if (entry.csize === 0) return (await import('node:stream')).Readable.from([]);
    const start = await this._dataOffset(entry);
    const raw = fs.createReadStream(null, { fd: this.fh.fd, start, end: start + entry.csize - 1, autoClose: false });
    if (entry.method === 0) return raw;
    if (entry.method === 8) return raw.pipe(zlib.createInflateRaw());
    throw new Error(`unsupported zip compression method ${entry.method} (${entry.name})`);
  }

  /** Whole entry in memory; only for small metadata files. */
  async read(entry, maxBytes = MAX_META_BYTES) {
    const chunks = [];
    let n = 0;
    for await (const c of await this.stream(entry)) {
      n += c.length;
      if (n > maxBytes || n > entry.usize) throw new Error(`zip entry ${entry.name} is larger than declared`);
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  /**
   * Extract every entry into dest. onProgress(doneBytes, totalBytes).
   * `budget` (UnpackBudget) caps total bytes/files; an entry that inflates past
   * its declared size is rejected, so a lying header cannot bypass the cap.
   */
  async extractAll(dest, { filter, onProgress, budget } = {}) {
    const files = this.entries.filter((e) => !e.isDir);
    const total = files.reduce((s, e) => s + e.usize, 0);
    budget?.check(total, files.length);
    let done = 0;
    for (const e of this.entries) {
      const rel = safeRelative(e.name);
      if (!rel || (filter && !filter(rel, e))) continue;
      const out = path.join(dest, rel);
      if (e.isDir) { await fsp.mkdir(out, { recursive: true }); continue; }
      budget?.file();
      await fsp.mkdir(path.dirname(out), { recursive: true });
      let n = 0;
      const guard = new Transform({
        transform(chunk, _enc, cb) {
          n += chunk.length;
          if (n > e.usize) return cb(new Error(`zip entry ${e.name} inflates past its declared size`));
          try { budget?.add(chunk.length); } catch (err) { return cb(err); }
          cb(null, chunk);
        },
      });
      await pipeline(await this.stream(e), guard, fs.createWriteStream(out));
      done += e.usize;
      onProgress?.(done, total);
    }
  }
}

/** Normalise an archive member name; returns null for unsafe/empty names. */
export function safeRelative(name) {
  const parts = [];
  for (const seg of name.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') return null;
    if (/^[a-zA-Z]:$/.test(seg) && parts.length === 0) continue;
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}
