// Lossless WebP for large images: the same pixels in about half the bytes.
// Files keep their names (and the game's encryption), so nothing in the game
// changes; browsers recognise the image format from the bytes themselves.
// Skipped, to keep every pixel identical: animated PNGs, 16-bit PNGs, and
// PNGs with colour-management chunks (gAMA, iCCP, cHRM), which browsers apply.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { decrypt, encrypt } from './rpgcrypt.js';

const PNG_SIG = Buffer.from('89504e470d0a1a0a', 'hex');
const IMAGE_EXT = { '.png': false, '.png_': true, '.rpgmvp': true };
export const WEBP_MIN_BYTES = 128 * 1024;

export function findCwebp() {
  const bin = process.env.RPGM_CWEBP || 'cwebp';
  try {
    const r = spawnSync(bin, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 ? bin : null;
  } catch { return null; }
}

/** Large PNGs (plain or encrypted) worth converting. */
export function planWebp(files, { minBytes = WEBP_MIN_BYTES } = {}) {
  const jobs = [];
  for (const [p, size] of files) {
    const enc = IMAGE_EXT[path.extname(p).toLowerCase()];
    if (enc === undefined || size < minBytes || !/^img\//i.test(p)) continue;
    jobs.push({ src: p, encrypted: enc, size });
  }
  return jobs;
}

/** Why a PNG can't be converted without changing what is shown, or null. */
export function pngBlocker(buf) {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) return 'not a PNG';
  if (buf[24] > 8) return '16-bit';
  for (let o = 8; o + 8 <= buf.length;) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    if (type === 'IDAT' || type === 'IEND') return null;
    if (type === 'acTL') return 'animated';
    if (type === 'gAMA' || type === 'iCCP' || type === 'cHRM') return 'colour profile';
    o += 12 + len;
  }
  return null;
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    try { os.setPriority(p.pid, 10); } catch { /* best effort: players first */ }
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`cwebp failed (${code}): ${err.trim().split('\n').pop()}`))));
  });
}

/**
 * Convert in place. Keeps a WebP only when it is at least 10% smaller.
 * @returns {{ converted: number, before: number, after: number, skipped: number }}
 */
export async function runWebp(root, jobs, meta, { cwebp, tmpDir, onProgress, log, concurrency } = {}) {
  const key = meta.encryption?.key;
  const n = concurrency || Math.max(1, Math.min(4, os.cpus().length - 1));
  let next = 0, done = 0;
  const stats = { converted: 0, before: 0, after: 0, skipped: 0 };
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const tag = crypto.randomBytes(6).toString('hex');
      const tin = path.join(tmpDir, `webp-${tag}.png`);
      const tout = path.join(tmpDir, `webp-${tag}.webp`);
      try {
        const file = path.join(root, job.src);
        let png = await fsp.readFile(file);
        if (job.encrypted) {
          if (!key) { stats.skipped++; continue; }
          png = decrypt(png, key);
        }
        if (pngBlocker(png)) { stats.skipped++; continue; }
        await fsp.writeFile(tin, png);
        await run(cwebp, ['-quiet', '-lossless', '-exact', '-z', '3', '-metadata', 'none', tin, '-o', tout]);
        const webp = await fsp.readFile(tout);
        if (webp.length > png.length * 0.9) { stats.skipped++; continue; }
        // Replace with one rename: the file may be served while we work (refresh).
        await fsp.writeFile(tin, job.encrypted ? encrypt(webp, key) : webp);
        await fsp.rename(tin, file);
        stats.converted++;
        stats.before += png.length;
        stats.after += webp.length;
      } catch (e) {
        stats.skipped++;
        log?.(`webp: ${job.src}: ${e.message}`);
      } finally {
        await fsp.rm(tin, { force: true });
        await fsp.rm(tout, { force: true });
        onProgress?.(++done, jobs.length);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker));
  return stats;
}

/** Plan + run with a log line; shared by import and refresh. */
export async function optimizeImages(root, files, meta, { tmpDir, log, onProgress, concurrency } = {}) {
  const jobs = planWebp(files);
  if (!jobs.length) return null;
  const cwebp = findCwebp();
  if (!cwebp) {
    log?.(`cwebp not found: ${jobs.length} large images left as PNG (install the "webp" package to make them ~half the size)`);
    return { skipped: true, reason: 'cwebp not found' };
  }
  const s = await runWebp(root, jobs, meta, { cwebp, tmpDir, onProgress, log, concurrency });
  if (s.converted) {
    log?.(`images: ${s.converted} large PNGs → lossless WebP, ${(s.before / 1048576).toFixed(1)} MB → ${(s.after / 1048576).toFixed(1)} MB (same pixels)`);
  }
  return { converted: s.converted, savedBytes: s.before - s.after };
}
