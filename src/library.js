// On-disk game library:  <data>/games/<id>/{meta.json, files.json, game/}
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export function slugify(s) {
  const slug = String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'game';
}

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class Library {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.gamesDir = path.join(this.dataDir, 'games');
    this.tmpDir = path.join(this.dataDir, 'tmp');
    fs.mkdirSync(this.gamesDir, { recursive: true });
    fs.mkdirSync(this.tmpDir, { recursive: true });
    this._cache = new Map(); // id -> { meta, files, lowerIndex, mtime }
  }

  gameDir(id) { return path.join(this.gamesDir, id); }
  rootDir(id) { return path.join(this.gamesDir, id, 'game'); }

  async list() {
    const out = [];
    for (const e of await fsp.readdir(this.gamesDir, { withFileTypes: true })) {
      if (!e.isDirectory() || !ID_RE.test(e.name)) continue;
      const g = await this.get(e.name);
      if (g) out.push(g.meta);
    }
    out.sort((a, b) => (b.importedAt || '').localeCompare(a.importedAt || ''));
    return out;
  }

  /** Cached { meta, files, lower } for a game; reloads when meta.json changes. */
  async get(id) {
    if (!ID_RE.test(id)) return null;
    const metaFile = path.join(this.gameDir(id), 'meta.json');
    let st;
    try { st = await fsp.stat(metaFile); } catch { this._cache.delete(id); return null; }
    const c = this._cache.get(id);
    if (c && c.mtime === st.mtimeMs) return c;
    const meta = JSON.parse(await fsp.readFile(metaFile, 'utf8'));
    const files = JSON.parse(await fsp.readFile(path.join(this.gameDir(id), 'files.json'), 'utf8'));
    const lower = new Map();
    for (const [p] of files) if (!lower.has(p.toLowerCase())) lower.set(p.toLowerCase(), p);
    const entry = { meta, files, lower, mtime: st.mtimeMs, fileSet: new Set(files.map(([p]) => p)) };
    this._cache.set(id, entry);
    return entry;
  }

  async exists(id) {
    try { await fsp.access(path.join(this.gameDir(id), 'meta.json')); return true; } catch { return false; }
  }

  async uniqueId(base) {
    let id = slugify(base);
    if (!(await this.exists(id))) return id;
    for (let i = 2; ; i++) if (!(await this.exists(`${id}-${i}`))) return `${id}-${i}`;
  }

  async writeMeta(id, meta) {
    const file = path.join(this.gameDir(id), 'meta.json');
    const tmp = file + '.' + crypto.randomBytes(4).toString('hex');
    await fsp.writeFile(tmp, JSON.stringify(meta, null, 2));
    await fsp.rename(tmp, file);
    this._cache.delete(id);
  }

  async updateMeta(id, patch) {
    const g = await this.get(id);
    if (!g) throw new Error('not found');
    const meta = { ...g.meta, ...patch, id };
    await this.writeMeta(id, meta);
    return meta;
  }

  /** Atomically put a prepared game root in place (moves the directory). */
  async install(id, srcRoot, files, meta, { preDir } = {}) {
    const dir = this.gameDir(id);
    await fsp.mkdir(dir, { recursive: true });
    const finalRoot = this.rootDir(id);
    const old = finalRoot + '.old-' + Date.now();
    let hadOld = false;
    try { await fsp.rename(finalRoot, old); hadOld = true; } catch { /* first import */ }
    try {
      await fsp.rename(srcRoot, finalRoot);
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      await fsp.cp(srcRoot, finalRoot, { recursive: true, preserveTimestamps: true });
    }
    // Precompressed copies belong to this exact tree: replace or drop them.
    const pre = path.join(dir, 'precompressed');
    await fsp.rm(pre, { recursive: true, force: true });
    if (preDir) {
      try { await fsp.rename(preDir, pre); } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        await fsp.cp(preDir, pre, { recursive: true });
      }
    }
    await fsp.writeFile(path.join(dir, 'files.json'), JSON.stringify(files));
    await this.writeMeta(id, meta);
    if (hadOld) await fsp.rm(old, { recursive: true, force: true });
  }

  // --- cover art (custom upload stored next to meta.json) -------------------
  static COVER_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

  async customCover(id) {
    for (const ext of Object.keys(Library.COVER_TYPES)) {
      const p = path.join(this.gameDir(id), `cover.${ext}`);
      try { await fsp.access(p); return { path: p, type: Library.COVER_TYPES[ext] }; } catch { /* next */ }
    }
    return null;
  }

  async setCover(id, buf, ext) {
    if (!Library.COVER_TYPES[ext]) throw new Error('cover must be png, jpg or webp');
    await this.removeCover(id);
    await fsp.writeFile(path.join(this.gameDir(id), `cover.${ext}`), buf);
    await this.updateMeta(id, { customCover: true, coverRev: Date.now() });
  }

  async removeCover(id, { updateMeta = false } = {}) {
    for (const ext of Object.keys(Library.COVER_TYPES)) await fsp.rm(path.join(this.gameDir(id), `cover.${ext}`), { force: true });
    if (updateMeta) await this.updateMeta(id, { customCover: false, coverRev: Date.now() });
  }

  async remove(id) {
    if (!ID_RE.test(id)) throw new Error('bad id');
    this._cache.delete(id);
    const dir = this.gameDir(id);
    const trash = path.join(this.tmpDir, `rm-${id}-${Date.now()}`);
    await fsp.rename(dir, trash);
    await fsp.rm(trash, { recursive: true, force: true });
  }
}
