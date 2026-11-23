// Inspect an RPG Maker web root: engine, version, title, encryption, media.
import fsp from 'node:fs/promises';
import path from 'node:path';

async function readJson(file) {
  try {
    const txt = (await fsp.readFile(file, 'utf8')).replace(/^﻿/, '');
    return JSON.parse(txt);
  } catch { return null; }
}

/** Walk a directory and return [[relPath, size], ...] with '/' separators. */
export async function listFiles(root) {
  const out = [];
  const walk = async (dir, rel) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), r);
      else if (e.isFile()) out.push([r, (await fsp.stat(path.join(dir, e.name))).size]);
    }
  };
  await walk(root, '');
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

export async function analyzeGame(root, files) {
  const lower = new Map(files.map(([p]) => [p.toLowerCase(), p]));
  const has = (p) => lower.get(p.toLowerCase());
  let engine = null;
  let coreFile = has('js/rmmz_core.js');
  if (coreFile) engine = 'mz';
  else if ((coreFile = has('js/rpg_core.js'))) engine = 'mv';
  if (!engine) {
    const main = has('js/main.js');
    const txt = main ? await fsp.readFile(path.join(root, main), 'utf8') : '';
    if (/rmmz_/.test(txt)) engine = 'mz';
    else if (/rpg_core|SceneManager\.run/.test(txt)) engine = 'mv';
  }
  if (!engine) throw new Error('Not an RPG Maker MV/MZ game (no rpg_core.js / rmmz_core.js).');

  let version = null;
  if (coreFile) {
    const core = await fsp.readFile(path.join(root, coreFile), 'utf8');
    version = core.match(/RPGMAKER_VERSION\s*=\s*["']([\d.]+)["']/)?.[1]
      || core.match(/rpg_core\.js v([\d.]+)/)?.[1]
      || core.match(/rmmz_core\.js v([\d.]+)/)?.[1]
      || null;
  }

  const sysPath = has('data/System.json');
  const system = sysPath ? await readJson(path.join(root, sysPath)) : null;
  const pkgPath = has('package.json');
  const pkg = pkgPath ? await readJson(path.join(root, pkgPath)) : null;
  const indexHtml = await fsp.readFile(path.join(root, has('index.html')), 'utf8');
  const htmlTitle = indexHtml.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();

  const count = (re) => files.filter(([p]) => re.test(p)).length;
  const media = {
    ogg: count(/^audio\/.*\.(ogg|rpgmvo|ogg_)$/i),
    m4a: count(/^audio\/.*\.(m4a|rpgmvm|m4a_)$/i),
    webm: count(/^movies\/.*\.webm$/i),
    mp4: count(/^movies\/.*\.mp4$/i),
  };

  const width = engine === 'mz' ? system?.advanced?.screenWidth || 816 : 816;
  const height = engine === 'mz' ? system?.advanced?.screenHeight || 624 : 624;

  return {
    engine,
    engineVersion: version,
    title: system?.gameTitle?.trim() || htmlTitle || pkg?.window?.title || 'Untitled',
    encryption: {
      images: !!system?.hasEncryptedImages,
      audio: !!system?.hasEncryptedAudio,
      key: system?.encryptionKey || null,
    },
    mzGameId: engine === 'mz' ? system?.advanced?.gameId ?? null : null,
    screen: { width, height },
    icon: has('icon/icon.png') || null,
    media,
    fileCount: files.length,
    totalBytes: files.reduce((s, [, n]) => s + n, 0),
  };
}
