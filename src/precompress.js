// Precompression: brotli (max quality) and gzip copies of a game's text files,
// made once at import so the server can stream them without spending CPU per
// request. Layout, next to the game root:
//
//   games/<id>/precompressed/index.json        { version, files: { rel: entry } }
//   games/<id>/precompressed/<rel>.br | .gz
//
// An entry is { size, mtime, br?, gzip?, patch? }: the source file's size and
// mtime (the server ignores a copy whose source changed) and the compressed
// lengths. Engine scripts the server patches at serve time are stored patched;
// `patch` records the patch so a different runtime version falls back to
// on-the-fly compression instead of serving a stale copy.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { mimeOf, isCompressible } from './server/mime.js';
import { hookFor, patchScript } from './server/inject.js';

export const PRE_DIR = 'precompressed';
export const PRE_EXT = { br: '.br', gzip: '.gz' };
const MIN_SIZE = 1024;
const BIG = 8 * 1024 * 1024; // above this, brotli 11 gets slow for little gain

const brotliAsync = promisify(zlib.brotliCompress);
const gzipAsync = promisify(zlib.gzip);

/** Compress without blocking the event loop (runs on the libuv thread pool). */
export function compressAsync(buf, enc, quality) {
  if (enc === 'br') {
    return brotliAsync(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: quality ?? 5,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
      },
    });
  }
  return gzipAsync(buf, { level: quality ?? 6 });
}

/** Short fingerprint of the serve-time patch for a hooked script. */
const patchIds = new Map();
export function patchId(hook) {
  if (!hook) return null;
  let id = patchIds.get(hook);
  if (!id) {
    id = crypto.createHash('sha1').update(patchScript(Buffer.alloc(0), hook)).digest('hex').slice(0, 12);
    patchIds.set(hook, id);
  }
  return id;
}

export function shouldPrecompress(rel, size) {
  if (size <= MIN_SIZE) return false;
  if (/^index\.html?$/i.test(rel)) return false; // patched per request (runtime config)
  return isCompressible(mimeOf(rel));
}

async function pool(items, limit, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) { const item = items[i++]; await fn(item); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Build a precompressed tree for `root` into `outDir` (created; must not exist).
 * Returns { files, bytes, br, gzip } totals.
 */
export async function precompressTree(root, files, outDir, { onProgress, log, concurrency } = {}) {
  const jobs = files.filter(([rel, size]) => shouldPrecompress(rel, size));
  await fsp.mkdir(outDir, { recursive: true });
  const entries = {};
  const total = { files: 0, bytes: 0, br: 0, gzip: 0 };
  let done = 0;
  const limit = concurrency || Math.max(1, Math.min(4, os.availableParallelism?.() || os.cpus().length));
  onProgress?.(0, jobs.length);
  await pool(jobs, limit, async ([rel]) => {
    const src = path.join(root, rel);
    const st = await fsp.stat(src);
    let buf = await fsp.readFile(src);
    const hook = hookFor(rel);
    if (hook) buf = patchScript(buf, hook);
    const [br, gz] = await Promise.all([
      compressAsync(buf, 'br', buf.length > BIG ? 9 : 11),
      compressAsync(buf, 'gzip', 9),
    ]);
    const entry = { size: st.size, mtime: Math.floor(st.mtimeMs) };
    if (hook) entry.patch = patchId(hook);
    for (const [enc, out] of [['br', br], ['gzip', gz]]) {
      if (out.length >= buf.length * 0.95) continue; // not worth it (already dense)
      const dst = path.join(outDir, rel + PRE_EXT[enc]);
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.writeFile(dst, out);
      entry[enc] = out.length;
    }
    if (entry.br || entry.gzip) {
      entries[rel] = entry;
      total.files++;
      total.bytes += buf.length;
      total.br += entry.br || buf.length;
      total.gzip += entry.gzip || buf.length;
    }
    onProgress?.(++done, jobs.length);
  });
  await fsp.writeFile(path.join(outDir, 'index.json'), JSON.stringify({ version: 1, files: entries }));
  if (log && total.files) {
    const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
    log(`precompressed ${total.files} text files: ${mb(total.bytes)} → ${mb(total.br)} brotli, ${mb(total.gzip)} gzip`);
  }
  return total;
}

/** (Re)build games/<id>/precompressed for an installed game, swapping atomically. */
export async function precompressGame(lib, id, opts = {}) {
  const g = await lib.get(id);
  if (!g) throw new Error(`no game "${id}"`);
  const dir = path.join(lib.gameDir(id), PRE_DIR);
  const tmp = path.join(lib.tmpDir, `pre-${id}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    const total = await precompressTree(lib.rootDir(id), g.files, tmp, opts);
    await swapDir(tmp, dir, lib.tmpDir);
    return total;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

/** Move `src` to `dst`, replacing whatever was there. */
export async function swapDir(src, dst, tmpDir) {
  const old = path.join(tmpDir, `old-${crypto.randomBytes(4).toString('hex')}`);
  let hadOld = false;
  try { await fsp.rename(dst, old); hadOld = true; } catch { /* none yet */ }
  try {
    await fsp.rename(src, dst);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.cp(src, dst, { recursive: true });
  }
  if (hadOld) await fsp.rm(old, { recursive: true, force: true });
}

/** Remove a game's precompressed copies (e.g. before re-import). */
export async function dropPrecompressed(lib, id) {
  await fsp.rm(path.join(lib.gameDir(id), PRE_DIR), { recursive: true, force: true });
}
