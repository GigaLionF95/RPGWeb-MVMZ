// Import a game release (zip / tar / 7z / rar / folder / exe) into the library.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { ZipArchive } from './zip.js';
import { extractTar } from './tar.js';
import { locateGame } from './locate.js';
import { analyzeGame, listFiles } from './analyze.js';
import { findFfmpeg, planTranscodes, runTranscodes } from './transcode.js';
import { ID_RE } from '../library.js';

const JUNK = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);

function hasBsdtar() {
  for (const bin of ['bsdtar', 'tar']) {
    try {
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
      if (r.status === 0 && /bsdtar|libarchive/.test(r.stdout)) return bin;
    } catch { /* not installed */ }
  }
  return null;
}

function runTool(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`${bin} failed: ${err.trim()}`))));
  });
}

async function extractArchive(file, dest, progress, log) {
  const lower = file.toLowerCase();
  if (await ZipArchive.isZip(file)) {
    const z = await ZipArchive.open(file);
    try {
      await z.extractAll(dest, { onProgress: (d, t) => progress('extract', d, t) });
    } finally { await z.close(); }
    return;
  }
  const tarDecomp = lower.endsWith('.tar') ? null
    : /\.(tgz|tar\.gz)$/.test(lower) ? zlib.createGunzip()
    : /\.(tar\.br|halva2)$/.test(lower) ? zlib.createBrotliDecompress()
    : undefined;
  if (tarDecomp !== undefined) {
    const src = fs.createReadStream(file);
    await extractTar(tarDecomp ? src.pipe(tarDecomp) : src, dest);
    return;
  }
  const bsdtar = hasBsdtar();
  if (bsdtar) {
    log?.('extracting with bsdtar');
    await runTool(bsdtar, ['-xf', file, '-C', dest]);
    return;
  }
  throw new Error('Unsupported archive format. Use .zip or .tar(.gz), or install bsdtar (libarchive) for 7z/rar.');
}

async function removeJunk(root) {
  const walk = async (dir) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (JUNK.has(e.name.toLowerCase())) await fsp.rm(p, { force: true });
    }
  };
  await walk(root);
}

/** Re-run detection on an installed game (after upgrades of the analyzer). */
export async function refreshGame(lib, id) {
  const g = await lib.get(id);
  if (!g) throw new Error(`no game "${id}"`);
  const files = await listFiles(lib.rootDir(id));
  const info = await analyzeGame(lib.rootDir(id), files);
  const keep = ['id', 'title', 'packaging', 'source', 'importedAt', 'rev', 'transcode', 'hidden', 'coverRev', 'customCover'];
  const meta = { ...info };
  for (const k of keep) if (g.meta[k] !== undefined) meta[k] = g.meta[k];
  await fsp.writeFile(path.join(lib.gameDir(id), 'files.json'), JSON.stringify(files));
  await lib.writeMeta(id, meta);
  return meta;
}

/**
 * @param {import('../library.js').Library} lib
 * @param {string} source  path to an archive or folder
 * @param {{id?:string,title?:string,transcode?:'auto'|'off'|'audio'|'video'|'all',
 *          onProgress?:Function, log?:Function, keepSource?:boolean}} opts
 */
export async function importGame(lib, source, opts = {}) {
  const log = opts.log || (() => {});
  const progress = (phase, done, total, message) => opts.onProgress?.({ phase, done, total, message });
  const st = await fsp.stat(source);
  const work = path.join(lib.tmpDir, 'import-' + crypto.randomBytes(6).toString('hex'));
  await fsp.mkdir(work, { recursive: true });
  try {
    let base = source;
    if (st.isFile()) {
      base = path.join(work, 'src');
      await fsp.mkdir(base);
      progress('extract', 0, 1, 'Extracting archive');
      log(`extracting ${path.basename(source)}`);
      await extractArchive(source, base, progress, log);
    }
    progress('locate', 0, 1, 'Looking for the game');
    const scratch = path.join(work, 'unwrap');
    await fsp.mkdir(scratch);
    const { root, packaging } = await locateGame(base, scratch, { log });
    log(`game root: ${path.relative(base, root) || '.'} (${packaging})`);

    // Stage a private copy we can modify (move when we own it).
    const staged = path.join(work, 'game');
    if (root.startsWith(work + path.sep)) await fsp.rename(root, staged);
    else await fsp.cp(root, staged, { recursive: true });
    await removeJunk(staged);

    let files = await listFiles(staged);
    const info = await analyzeGame(staged, files);
    log(`detected RPG Maker ${info.engine.toUpperCase()} ${info.engineVersion || ''} — "${info.title}", ${files.length} files`);

    // Mobile media
    const mode = opts.transcode || 'auto';
    let transcode = { skipped: true };
    if (mode !== 'off') {
      const jobs = planTranscodes(info, files, {
        audio: mode !== 'video',
        video: mode !== 'audio',
      });
      if (jobs.length) {
        const ffmpeg = findFfmpeg();
        if (!ffmpeg) {
          log(`ffmpeg not found: skipping ${jobs.length} mobile media conversions (game still works on desktop browsers)`);
          transcode = { skipped: true, reason: 'ffmpeg not found', pending: jobs.length };
        } else {
          log(`converting ${jobs.length} media files for mobile browsers (ffmpeg)`);
          const r = await runTranscodes(staged, jobs, info, {
            ffmpeg, tmpDir: work, log,
            onProgress: (d, t) => progress('transcode', d, t, 'Converting media for mobile'),
          });
          transcode = { skipped: false, converted: r.done, failed: r.failed.length };
          files = await listFiles(staged);
        }
      }
    }

    let id = opts.id;
    if (id && !ID_RE.test(id)) throw new Error('id must match ' + ID_RE);
    if (!id) id = await lib.uniqueId(opts.title || info.title);
    const prev = await lib.get(id);
    const meta = {
      id,
      ...info,
      title: opts.title || prev?.meta?.title || info.title,
      packaging,
      source: path.basename(source),
      importedAt: new Date().toISOString(),
      rev: (prev?.meta?.rev || 0) + 1,
      transcode,
      hidden: prev?.meta?.hidden || false,
    };
    progress('install', 0, 1, 'Installing');
    await lib.install(id, staged, files, meta);
    log(`installed as "${id}" (rev ${meta.rev})`);
    progress('done', 1, 1, 'Done');
    return meta;
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}
