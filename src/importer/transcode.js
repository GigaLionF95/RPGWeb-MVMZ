// Optional mobile-compat media: MV picks .m4a audio and .mp4 video on phones
// (Utils.isMobileDevice), and old iOS cannot play Ogg/WebM at all. Generate the
// missing counterparts with ffmpeg, keeping the game's encryption scheme.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { decrypt, encrypt } from './rpgcrypt.js';

export function findFfmpeg() {
  const bin = process.env.RPGM_FFMPEG || 'ffmpeg';
  try {
    const r = spawnSync(bin, ['-hide_banner', '-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 ? bin : null;
  } catch { return null; }
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    try { os.setPriority(p.pid, 10); } catch { /* best effort: players first */ }
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${err.trim().split('\n').pop()}`))));
  });
}

const AUDIO_SRC = { '.ogg': ['.m4a', false], '.rpgmvo': ['.rpgmvm', true], '.ogg_': ['.m4a_', true] };

/** Work items for missing m4a (MV only) and mp4 (both engines). */
export function planTranscodes(meta, files, { audio = true, video = true } = {}) {
  const set = new Set(files.map(([p]) => p.toLowerCase()));
  const jobs = [];
  for (const [p] of files) {
    const ext = path.extname(p).toLowerCase();
    const stem = p.slice(0, p.length - ext.length);
    if (audio && meta.engine === 'mv' && /^audio\//i.test(p) && AUDIO_SRC[ext]) {
      const [outExt, enc] = AUDIO_SRC[ext];
      if (!set.has((stem + outExt).toLowerCase())) jobs.push({ kind: 'audio', src: p, dst: stem + outExt, encrypted: enc });
    }
    if (video && /^movies\//i.test(p) && ext === '.webm' && !set.has((stem + '.mp4').toLowerCase())) {
      jobs.push({ kind: 'video', src: p, dst: stem + '.mp4', encrypted: false });
    }
  }
  return jobs;
}

export async function runTranscodes(root, jobs, meta, { ffmpeg, tmpDir, onProgress, log, concurrency } = {}) {
  const key = meta.encryption?.key;
  const n = concurrency || Math.max(1, Math.min(8, Math.floor(os.cpus().length / 2)));
  let next = 0, done = 0;
  const failed = [];
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const tag = crypto.randomBytes(6).toString('hex');
      const tin = path.join(tmpDir, `tc-${tag}-in`);
      const tout = path.join(tmpDir, `tc-${tag}-out` + (job.kind === 'audio' ? '.m4a' : '.mp4'));
      try {
        let input = path.join(root, job.src);
        if (job.encrypted) {
          await fsp.writeFile(tin, decrypt(await fsp.readFile(input), key));
          input = tin;
        }
        const args = job.kind === 'audio'
          ? ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-map_metadata', '0', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', tout]
          : ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', tout];
        await run(ffmpeg, args);
        const out = path.join(root, job.dst);
        if (job.encrypted) await fsp.writeFile(out, encrypt(await fsp.readFile(tout), key));
        else await fsp.rename(tout, out).catch(async () => { await fsp.copyFile(tout, out); });
      } catch (e) {
        failed.push({ ...job, error: e.message });
        log?.(`transcode failed: ${job.src}: ${e.message}`);
      } finally {
        await fsp.rm(tin, { force: true });
        await fsp.rm(tout, { force: true });
        onProgress?.(++done, jobs.length);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker));
  return { done: jobs.length - failed.length, failed };
}
