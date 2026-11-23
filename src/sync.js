// Several servers behind one load balancer: one primary holds the library,
// replicas mirror it. A replica pulls changes from the primary over HTTP (no
// shared disk, no manual copying) and forwards admin writes to it.
//
//   primary:  GET /api/sync             -> { games: [{ id, rev, stamp }] }
//             GET /api/sync/<id>        -> { stamp, files: [[path, size, mtimeMs]] }
//             GET /api/sync/<id>/file?path=<path>   raw bytes
//   replica:  RPGM_UPSTREAM=https://primary  (same RPGM_ADMIN_TOKEN)
//
// Files keep the primary's size and mtime, so every node sends identical
// ETags and validates precompressed copies the same way. Unchanged files are
// hard-linked from the previous copy; only differences are downloaded.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { ID_RE } from './library.js';
import { safeRelative } from './importer/zip.js';

const SYNC_FILE = '.sync.json';

async function listTree(root) {
  const out = [];
  const walk = async (dir, rel) => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!rel && e.name === SYNC_FILE) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, r);
      else if (e.isFile()) {
        const st = await fsp.stat(p);
        out.push([r, st.size, Math.floor(st.mtimeMs)]);
      }
    }
  };
  await walk(root, '');
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

/** A short fingerprint of everything a replica needs to copy for one game. */
function stampOf(files) {
  const h = crypto.createHash('sha1');
  for (const [p, s, m] of files) h.update(`${p}\0${s}\0${m}\n`);
  return h.digest('hex').slice(0, 16);
}

// ---- primary side --------------------------------------------------------
export function createSyncSource(lib) {
  const cache = new Map(); // id -> { mtime, files, stamp }
  async function game(id) {
    const g = await lib.get(id);
    if (!g) return null;
    const c = cache.get(id);
    // The tree changes with meta.json (import, refresh, rename, cover); a
    // short TTL covers anything else (precompress rebuilds write meta too).
    if (c && c.mtime === g.mtime && Date.now() - c.at < 30000) return c;
    const files = await listTree(lib.gameDir(id));
    const entry = { mtime: g.mtime, at: Date.now(), files, stamp: stampOf(files), rev: g.meta.rev };
    cache.set(id, entry);
    return entry;
  }
  return {
    async list() {
      const games = [];
      for (const m of await lib.list()) {
        const e = await game(m.id);
        if (e) games.push({ id: m.id, rev: e.rev, stamp: e.stamp });
      }
      return { version: 1, games };
    },
    game,
    /** Absolute path of a listed file, or null. */
    async file(id, rel) {
      const e = await game(id);
      const clean = safeRelative(String(rel || ''));
      if (!e || !clean || !e.files.some(([p]) => p === clean)) return null;
      return path.join(lib.gameDir(id), clean);
    },
  };
}

// ---- replica side --------------------------------------------------------
export class Replica {
  /**
   * @param {import('./library.js').Library} lib
   * @param {{ upstream: string, token: string, intervalMs?: number, log?: Function, concurrency?: number }} opts
   */
  constructor(lib, opts) {
    this.lib = lib;
    this.upstream = opts.upstream.replace(/\/+$/, '');
    this.token = opts.token;
    this.intervalMs = opts.intervalMs ?? 60000;
    this.log = opts.log || (() => {});
    this.concurrency = opts.concurrency || 4;
    this.state = { lastSync: null, lastError: null, running: false, games: 0 };
    this.timer = null;
    this.pending = null;
  }

  async fetch(p, init = {}) {
    const r = await fetch(this.upstream + p, { ...init, headers: { Authorization: `Bearer ${this.token}`, ...(init.headers || {}) } });
    if (!r.ok) throw new Error(`upstream ${p}: HTTP ${r.status}`);
    return r;
  }

  start() {
    const tick = () => { this.syncNow().catch(() => {}).finally(() => { this.timer = setTimeout(tick, this.intervalMs); this.timer.unref?.(); }); };
    tick();
  }

  stop() { clearTimeout(this.timer); this.timer = null; }

  /** Sync soon (after an admin write), coalescing bursts. */
  poke(delayMs = 1500) {
    clearTimeout(this.pokeTimer);
    this.pokeTimer = setTimeout(() => this.syncNow().catch(() => {}), delayMs);
    this.pokeTimer.unref?.();
  }

  /** One full pass. Concurrent calls share the running pass. */
  syncNow() {
    if (this.pending) return this.pending;
    this.pending = this._sync().finally(() => { this.pending = null; });
    return this.pending;
  }

  async _sync() {
    this.state.running = true;
    try {
      const remote = await (await this.fetch('/api/sync')).json();
      const wanted = new Set();
      for (const g of remote.games || []) {
        if (!ID_RE.test(g.id)) continue;
        wanted.add(g.id);
        const local = await this.localStamp(g.id);
        if (local !== g.stamp) await this.syncGame(g.id);
      }
      for (const m of await this.lib.list()) {
        if (!wanted.has(m.id)) { this.log(`sync: removing ${m.id} (gone on the primary)`); await this.lib.remove(m.id); }
      }
      this.state.games = wanted.size;
      this.state.lastSync = new Date().toISOString();
      this.state.lastError = null;
    } catch (e) {
      this.state.lastError = e.message;
      this.log(`sync failed: ${e.message}`);
      throw e;
    } finally {
      this.state.running = false;
    }
  }

  async localStamp(id) {
    try { return JSON.parse(await fsp.readFile(path.join(this.lib.gameDir(id), SYNC_FILE), 'utf8')).stamp; } catch { return null; }
  }

  async syncGame(id) {
    const info = await (await this.fetch(`/api/sync/${encodeURIComponent(id)}`)).json();
    const dir = this.lib.gameDir(id);
    const work = path.join(this.lib.tmpDir, `sync-${id}-${crypto.randomBytes(4).toString('hex')}`);
    await fsp.mkdir(work, { recursive: true });
    let fetched = 0, linked = 0, bytes = 0;
    try {
      const queue = info.files.slice();
      const worker = async () => {
        for (;;) {
          const f = queue.shift();
          if (!f) return;
          const [rel, size, mtime] = f;
          const clean = safeRelative(rel);
          if (!clean || clean !== rel) throw new Error(`bad path from upstream: ${rel}`);
          const dst = path.join(work, clean);
          await fsp.mkdir(path.dirname(dst), { recursive: true });
          const old = path.join(dir, clean);
          let reuse = false;
          try { const st = await fsp.stat(old); reuse = st.size === size && Math.floor(st.mtimeMs) === mtime; } catch { /* new file */ }
          if (reuse) {
            try { await fsp.link(old, dst); linked++; continue; } catch { /* other fs: copy */ }
            await fsp.copyFile(old, dst); linked++;
          } else {
            const r = await this.fetch(`/api/sync/${encodeURIComponent(id)}/file?path=${encodeURIComponent(clean)}`);
            await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dst));
            const st = await fsp.stat(dst);
            if (st.size !== size) throw new Error(`${clean}: got ${st.size} bytes, expected ${size}`);
            fetched++; bytes += size;
          }
          const t = new Date(mtime);
          await fsp.utimes(dst, t, t);
        }
      };
      await Promise.all(Array.from({ length: this.concurrency }, worker));
      await fsp.writeFile(path.join(work, SYNC_FILE), JSON.stringify({ stamp: info.stamp, at: new Date().toISOString() }));
      // Swap the whole game directory in one rename.
      const old = path.join(this.lib.tmpDir, `old-${id}-${crypto.randomBytes(4).toString('hex')}`);
      let hadOld = false;
      try { await fsp.rename(dir, old); hadOld = true; } catch { /* first copy */ }
      await fsp.rename(work, dir);
      this.lib._cache.delete(id);
      if (hadOld) await fsp.rm(old, { recursive: true, force: true });
      this.log(`sync: ${id} updated (${fetched} files downloaded, ${(bytes / 1048576).toFixed(1)} MB; ${linked} reused)`);
    } finally {
      await fsp.rm(work, { recursive: true, force: true });
    }
  }
}
