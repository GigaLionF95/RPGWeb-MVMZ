// Import a game release (zip / tar / 7z / rar / folder / exe) into the library.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { ZipArchive } from './zip.js';
import { extractTar } from './tar.js';
import { locateGame } from './locate.js';
import { analyzeGame, listFiles } from './analyze.js';
import { findFfmpeg, planTranscodes, runTranscodes } from './transcode.js';
import { ID_RE } from '../library.js';
import { precompressTree, precompressGame } from '../precompress.js';
import { UnpackBudget } from './limits.js';

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

async function extractArchive(file, dest, progress, log, budget) {
  const lower = file.toLowerCase();
  if (await ZipArchive.isZip(file)) {
    const z = await ZipArchive.open(file);
    try {
      await z.extractAll(dest, { budget, onProgress: (d, t) => progress('extract', d, t) });
    } finally { await z.close(); }
    return;
  }
  const tarDecomp = lower.endsWith('.tar') ? null
    : /\.(tgz|tar\.gz)$/.test(lower) ? zlib.createGunzip()
    : /\.(tar\.br|halva2)$/.test(lower) ? zlib.createBrotliDecompress()
    : undefined;
  if (tarDecomp !== undefined) {
    const src = fs.createReadStream(file);
    await extractTar(tarDecomp ? src.pipe(tarDecomp) : src, dest, { budget });
    return;
  }
  const bsdtar = hasBsdtar();
  if (bsdtar) {
    log?.('extracting with bsdtar');
    await bsdtarToTar(bsdtar, file, dest, budget);
    return;
  }
  throw new Error('Unsupported archive format. Use .zip or .tar(.gz), or install bsdtar (libarchive) for 7z/rar.');
}

/**
 * 7z/rar/etc. through libarchive, without letting it write to disk: bsdtar
 * re-packs the archive as a tar stream (`@archive`), and our own extractor
 * writes the files, with the same path checks and size limits as zip/tar.
 * Links and device entries are dropped on the way.
 */
async function bsdtarToTar(bin, file, dest, budget) {
  const child = spawn(bin, ['-c', '-f', '-', '--format', 'pax', '@' + path.resolve(file)], { stdio: ['ignore', 'pipe', 'pipe'] });
  try { os.setPriority(child.pid, 10); } catch { /* best effort */ }
  let err = '';
  child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  try {
    await extractTar(child.stdout, dest, { budget });
  } catch (e) {
    child.kill('SIGKILL');
    await exited.catch(() => {});
    throw e;
  }
  const code = await exited;
  if (code !== 0) throw new Error(`${bin} could not read the archive: ${err.trim() || 'exit ' + code}`);
}

/**
 * Desktop builds ship the NW.js runtime next to index.html (Windows: nw.dll,
 * Game.exe...; Linux: lib/libnw.so, Game...). A browser never loads it:
 * drop it so it does not take space on the server. Only the game's top
 * folder is touched, and only things that are certainly the runtime.
 */
async function stripNwRuntime(root, log) {
  const isNative = async (p) => {
    let fh;
    try {
      fh = await fsp.open(p, 'r');
      const b = Buffer.alloc(64);
      const { bytesRead } = await fh.read(b, 0, 64, 0);
      if (bytesRead < 4) return false;
      const m = b.readUInt32BE(0);
      if (m === 0x7f454c46) return true; // ELF
      if (m === 0xfeedface || m === 0xfeedfacf || m === 0xcefaedfe || m === 0xcffaedfe || m === 0xcafebabe) return true; // Mach-O
      if (b[0] !== 0x4d || b[1] !== 0x5a || bytesRead < 64) return false; // PE starts with "MZ"...
      const pe = Buffer.alloc(4);
      await fh.read(pe, 0, 4, b.readUInt32LE(0x3c));
      return pe.toString('latin1') === 'PE\0\0'; // ...and has a PE header
    } catch { return false; } finally { await fh?.close(); }
  };
  let freed = 0;
  const drop = async (p) => {
    const st = await fsp.stat(p);
    if (st.isDirectory()) { for (const f of await listFiles(p)) freed += f[1]; } else freed += st.size;
    await fsp.rm(p, { recursive: true, force: true });
  };
  for (const e of await fsp.readdir(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    const n = e.name.toLowerCase();
    if (e.isFile()) {
      if (/\.(pak|dll|so|dylib)$/.test(n) || /^(icudtl\.dat|v8_context_snapshot\.bin|snapshot_blob\.bin|natives_blob\.bin|vk_swiftshader_icd\.json)$/.test(n) || (/^[^.]+$|\.(exe|node|bin|out)$/.test(n) && await isNative(p))) {
        await drop(p);
      } else if (n === 'credits.html') {
        // NW.js ships Chromium's license list under this name
        const head = (await fsp.readFile(p)).subarray(0, 65536).toString('utf8');
        if (/chromium/i.test(head) && !/rpg ?maker/i.test(head)) await drop(p);
      }
    } else if (e.isDirectory()) {
      if (n === 'swiftshader') await drop(p);
      else if (n === 'lib' && (await fsp.readdir(p)).some((f) => /^lib(nw|node)\.so$/.test(f))) await drop(p);
      else if (n === 'locales') {
        const items = await fsp.readdir(p);
        if (items.length && items.every((f) => /\.(pak|pak\.info)$/i.test(f))) await drop(p);
      }
    }
  }
  if (freed) log?.(`removed the desktop runtime (NW.js): ${(freed / 1048576).toFixed(0)} MB not needed in a browser`);
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
export async function refreshGame(lib, id, opts = {}) {
  const g = await lib.get(id);
  if (!g) throw new Error(`no game "${id}"`);
  const files = await listFiles(lib.rootDir(id));
  const info = await analyzeGame(lib.rootDir(id), files);
  const keep = ['id', 'title', 'packaging', 'source', 'importedAt', 'rev', 'transcode', 'hidden', 'coverRev', 'customCover'];
  const meta = { ...info };
  for (const k of keep) if (g.meta[k] !== undefined) meta[k] = g.meta[k];
  await fsp.writeFile(path.join(lib.gameDir(id), 'files.json'), JSON.stringify(files));
  await lib.writeMeta(id, meta);
  if (opts.precompress !== false) await precompressGame(lib, id, { log: opts.log, concurrency: opts.threads });
  return meta;
}

/**
 * @param {import('../library.js').Library} lib
 * @param {string} source  path to an archive or folder
 * @param {{id?:string,title?:string,transcode?:'auto'|'off'|'audio'|'video'|'all',
 *          onProgress?:Function, log?:Function, keepSource?:boolean,
 *          precompress?:boolean, limits?:{maxBytes?:number,maxFiles?:number}}} opts
 */
export async function importGame(lib, source, opts = {}) {
  const log = opts.log || (() => {});
  const progress = (phase, done, total, message) => opts.onProgress?.({ phase, done, total, message });
  const st = await fsp.stat(source);
  const budget = new UnpackBudget(opts.limits);
  const work = path.join(lib.tmpDir, 'import-' + crypto.randomBytes(6).toString('hex'));
  await fsp.mkdir(work, { recursive: true });
  try {
    let base = source;
    if (st.isFile()) {
      base = path.join(work, 'src');
      await fsp.mkdir(base);
      progress('extract', 0, 1, 'Extracting archive');
      log(`extracting ${path.basename(source)}`);
      await extractArchive(source, base, progress, log, budget);
    }
    progress('locate', 0, 1, 'Looking for the game');
    const scratch = path.join(work, 'unwrap');
    await fsp.mkdir(scratch);
    const { root, packaging } = await locateGame(base, scratch, { log, budget });
    log(`game root: ${path.relative(base, root) || '.'} (${packaging})`);

    // Stage a private copy we can modify (move when we own it).
    const staged = path.join(work, 'game');
    if (root.startsWith(work + path.sep)) await fsp.rename(root, staged);
    else await fsp.cp(root, staged, { recursive: true });
    await removeJunk(staged);
    await stripNwRuntime(staged, log);

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
    // Text assets compressed once now, so serving them costs no CPU.
    let preDir = null;
    if (opts.precompress !== false) {
      preDir = path.join(work, 'pre');
      await precompressTree(staged, files, preDir, {
        log, concurrency: opts.threads, onProgress: (d, t) => progress('precompress', d, t, 'Compressing text files'),
      });
    }
    progress('install', 0, 1, 'Installing');
    await lib.install(id, staged, files, meta, { preDir });
    log(`installed as "${id}" (rev ${meta.rev})`);
    progress('done', 1, 1, 'Done');
    return meta;
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}
