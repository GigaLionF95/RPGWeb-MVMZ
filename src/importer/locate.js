// Find the RPG Maker game root inside an extracted release, unwrapping the
// known desktop packagings on the way (NW.js package.nw / exe with appended
// zip, Dragonhouse "Halva" packages).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { ZipArchive } from './zip.js';
import { extractTar } from './tar.js';

const CORE_FILES = ['rpg_core.js', 'rmmz_core.js', 'main.js'];

async function listDir(dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
}

function findCi(entries, name) {
  const l = name.toLowerCase();
  return entries.find((e) => e.name.toLowerCase() === l);
}

/** True if dir looks like an MV/MZ web root (index.html + js/core). */
export async function isGameRoot(dir) {
  const entries = await listDir(dir);
  const index = findCi(entries, 'index.html');
  const js = findCi(entries, 'js');
  if (!index || !index.isFile() || !js || !js.isDirectory()) return false;
  const jsEntries = await listDir(path.join(dir, js.name));
  return CORE_FILES.some((f) => findCi(jsEntries, f));
}

async function walk(dir, depth, visit) {
  if (depth < 0) return;
  for (const e of await listDir(dir)) {
    const p = path.join(dir, e.name);
    await visit(p, e);
    if (e.isDirectory()) await walk(p, depth - 1, visit);
  }
}

async function findRoots(dir) {
  const roots = [];
  if (await isGameRoot(dir)) roots.push(dir);
  await walk(dir, 5, async (p, e) => {
    if (e.isDirectory() && (await isGameRoot(p))) roots.push(p);
  });
  // Prefer the shallowest root; for MV desktop builds that is <game>/www.
  roots.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
  return roots;
}

async function readBrotliJson(file) {
  return JSON.parse(zlib.brotliDecompressSync(await fsp.readFile(file)).toString('utf8'));
}

/** Dragonhouse/Halva launcher: GameConfig.sbcf + GamePackages/*.halva2 (= brotli(tar)). */
async function unpackHalva(configFile, out, log) {
  const cfg = await readBrotliJson(configFile);
  if (cfg?.config?.halvaPassword) {
    throw new Error('This game uses password-protected Halva packages, which are not supported yet.');
  }
  const base = path.dirname(configFile);
  const pkgs = [...(cfg.packageList?.baseContent || []), ...(cfg.packageList?.extraContent || [])];
  if (!pkgs.length) throw new Error('Halva GameConfig.sbcf lists no packages');
  for (const p of pkgs) {
    const file = path.join(base, ...String(p.packageLocation).split(/[\\/]/));
    log?.(`unpacking Halva package ${p.packageId} (${path.basename(file)})`);
    await extractTar(fs.createReadStream(file).pipe(zlib.createBrotliDecompress()), out);
  }
  return cfg;
}

async function looksLikeEnigma(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(4096);
    await fh.read(buf, 0, 4096, 0);
    return buf.includes('.enigma1') || buf.includes('.enigma2');
  } catch { return false; } finally { await fh?.close(); }
}

/**
 * Returns { root, packaging } for the game inside dir, unwrapping as needed.
 * Unwrapped content is written to scratch (a directory we own).
 */
export async function locateGame(dir, scratch, { log } = {}) {
  let roots = await findRoots(dir);
  if (roots.length) return { root: roots[0], packaging: 'folder' };

  // Halva
  const halva = [];
  await walk(dir, 3, async (p, e) => { if (e.isFile() && e.name.toLowerCase() === 'gameconfig.sbcf') halva.push(p); });
  if (halva.length) {
    const out = path.join(scratch, 'halva');
    await fsp.mkdir(out, { recursive: true });
    await unpackHalva(halva[0], out, log);
    roots = await findRoots(out);
    if (roots.length) return { root: roots[0], packaging: 'halva' };
  }

  // NW.js package.nw (zip or folder) and exes with an appended zip.
  const candidates = [];
  await walk(dir, 3, async (p, e) => {
    const n = e.name.toLowerCase();
    if (n === 'package.nw' || n === 'app.nw' || (e.isFile() && (n.endsWith('.exe') || n.endsWith('.nw')))) candidates.push({ p, e });
  });
  let sawEnigma = false;
  for (const { p, e } of candidates) {
    if (e.isDirectory()) {
      roots = await findRoots(p);
      if (roots.length) return { root: roots[0], packaging: 'nwjs-folder' };
      continue;
    }
    if (!(await ZipArchive.isZip(p))) {
      if (await looksLikeEnigma(p)) sawEnigma = true;
      continue;
    }
    const out = path.join(scratch, 'nw-' + path.basename(p).replace(/\W+/g, '_'));
    log?.(`unpacking NW.js package from ${path.basename(p)}`);
    const z = await ZipArchive.open(p);
    try { await z.extractAll(out); } finally { await z.close(); }
    roots = await findRoots(out);
    if (roots.length) return { root: roots[0], packaging: 'nwjs-package' };
  }
  if (sawEnigma) {
    throw new Error('The game is packed into the .exe with Enigma Virtual Box. Unpack it first (e.g. with evbunpack) and import the resulting folder.');
  }
  throw new Error('No RPG Maker MV/MZ game found (expected index.html + js/rpg_core.js or js/rmmz_core.js).');
}
