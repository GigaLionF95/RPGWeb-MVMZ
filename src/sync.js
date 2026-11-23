// Several servers behind one load balancer. One primary keeps the catalog
// (meta.json, files.json, covers) and decides where each game's files live;
// replicas copy the catalog of every game and the files of the games placed
// on them, from whichever node already has them. See ./cluster.js.
//
//   GET  /api/sync?node=<id>          what this node should hold (primary)
//   POST /api/sync/heartbeat          a node reports its disk and copies (primary)
//   GET  /api/sync/<id>?part=catalog|data   file list of one part (any node)
//   GET  /api/sync/<id>/file?path=<path>    raw bytes (any node)
//
// Files keep their size and mtime everywhere, so every node sends identical
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

export const SYNC_FILE = '.sync.json';

async function listTree(root) {
  const out = [];
  const walk = async (dir, rel) => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!rel && e.name.startsWith('.')) continue; // node-local state (.sync.json)
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

/** A short fingerprint of a file list (paths, sizes, mtimes). */
export function stampOf(files) {
  const h = crypto.createHash('sha1');
  for (const [p, s, m] of files) h.update(`${p}\0${s}\0${m}\n`);
  return h.digest('hex').slice(0, 16);
}

/** Catalog = top-level files (meta, files.json, cover); data = game/ and precompressed/. */
const isCatalog = (p) => !p.includes('/');

/** Free and total bytes of the disk holding `dir`. */
export async function diskSpace(dir) {
  try {
    const s = await fsp.statfs(dir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch { return { free: 0, total: 0 }; }
}

/** This server's stable node id (data/node.json). */
export function nodeIdentity(dataDir) {
  const file = path.join(dataDir, 'node.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).id; } catch { /* first run */ }
  const id = 'n-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(file, JSON.stringify({ id }));
  return id;
}

// ---- file lists of local games (served to other nodes) ---------------------
export function createSyncSource(lib) {
  const cache = new Map(); // id -> entry
  async function game(id) {
    const g = await lib.get(id);
    if (!g) return null;
    const c = cache.get(id);
    if (c && c.mtime === g.mtime && Date.now() - c.at < 300000) return c;
    const files = await listTree(lib.gameDir(id));
    const catalog = files.filter(([p]) => isCatalog(p));
    const data = files.filter(([p]) => !isCatalog(p));
    const entry = {
      mtime: g.mtime, at: Date.now(), rev: g.meta.rev, size: g.meta.totalBytes || 0,
      catalog, data, catalogStamp: stampOf(catalog), dataStamp: data.length ? stampOf(data) : null,
    };
    cache.set(id, entry);
    return entry;
  }
  return {
    game,
    invalidate(id) { cache.delete(id); },
    /** Absolute path of a listed file, or null. */
    async file(id, rel) {
      const e = await game(id);
      const clean = safeRelative(String(rel || ''));
      if (!e || !clean || ![...e.catalog, ...e.data].some(([p]) => p === clean)) return null;
      return path.join(lib.gameDir(id), clean);
    },
  };
}

// ---- copying a game between nodes ------------------------------------------
/** Where a part of a game comes from: another node over HTTP, or this disk. */
export function remoteSource(baseUrl, token) {
  const base = baseUrl.replace(/\/+$/, '');
  const get = async (p) => {
    const r = await fetch(base + p, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`${base}${p}: HTTP ${r.status}`);
    return r;
  };
  return {
    name: base,
    async list(id, part) { return (await (await get(`/api/sync/${encodeURIComponent(id)}?part=${part}`)).json()).files; },
    async fetch(id, rel, dst) {
      const r = await get(`/api/sync/${encodeURIComponent(id)}/file?path=${encodeURIComponent(rel)}`);
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dst));
    },
  };
}
export function localSource(lib, source) {
  return {
    name: 'local',
    async list(id, part) { const e = await source.game(id); return e ? (part === 'catalog' ? e.catalog : e.data) : []; },
    async fetch(id, rel, dst) { await fsp.copyFile(path.join(lib.gameDir(id), rel), dst); },
  };
}

/**
 * Rebuild games/<id> from a catalog source and, when this node should hold
 * the files, a data source; swap it in with one rename. Returns stats.
 */
export async function copyGame(lib, id, { catalogFrom, dataFrom, concurrency = 4, log }) {
  const dir = lib.gameDir(id);
  const work = path.join(lib.tmpDir, `sync-${id}-${crypto.randomBytes(4).toString('hex')}`);
  await fsp.mkdir(work, { recursive: true });
  let fetched = 0, linked = 0, bytes = 0;
  try {
    const catalog = await catalogFrom.list(id, 'catalog');
    const data = dataFrom ? await dataFrom.list(id, 'data') : [];
    if (dataFrom && !data.length) throw new Error(`${dataFrom.name} has no files for ${id}`);
    const queue = [...catalog.map((f) => [f, catalogFrom]), ...data.map((f) => [f, dataFrom])];
    const worker = async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        const [[rel, size, mtime], from] = item;
        const clean = safeRelative(rel);
        if (!clean || clean !== rel) throw new Error(`bad path from ${from.name}: ${rel}`);
        const dst = path.join(work, clean);
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        const old = path.join(dir, clean);
        let reuse = false;
        try { const st = await fsp.stat(old); reuse = st.size === size && Math.floor(st.mtimeMs) === mtime; } catch { /* new file */ }
        if (reuse) {
          try { await fsp.link(old, dst); } catch { await fsp.copyFile(old, dst); }
          linked++;
        } else {
          await from.fetch(id, clean, dst);
          const st = await fsp.stat(dst);
          if (st.size !== size) throw new Error(`${clean}: got ${st.size} bytes, expected ${size}`);
          fetched++; bytes += size;
        }
        const t = new Date(mtime);
        await fsp.utimes(dst, t, t);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    const state = { catalog: stampOf(catalog), data: data.length ? stampOf(data) : null, at: new Date().toISOString() };
    await fsp.writeFile(path.join(work, SYNC_FILE), JSON.stringify(state));
    const old = path.join(lib.tmpDir, `old-${id}-${crypto.randomBytes(4).toString('hex')}`);
    let hadOld = false;
    try { await fsp.rename(dir, old); hadOld = true; } catch { /* first copy */ }
    await fsp.rename(work, dir);
    lib._cache.delete(id);
    if (hadOld) await fsp.rm(old, { recursive: true, force: true });
    log?.(`sync: ${id} ${data.length ? 'files' : 'catalog'} updated (${fetched} downloaded, ${(bytes / 1048576).toFixed(1)} MB; ${linked} reused)`);
    return state;
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

/** Stamps of the copy on this disk ({ catalog, data }), from the last sync or computed. */
export async function localStamps(lib, source, id) {
  try {
    const s = JSON.parse(await fsp.readFile(path.join(lib.gameDir(id), SYNC_FILE), 'utf8'));
    if ('catalog' in s) return s;
  } catch { /* never synced here */ }
  const e = await source.game(id);
  return e ? { catalog: e.catalogStamp, data: e.dataStamp } : null;
}

// ---- replica side ----------------------------------------------------------
const viewFile = (lib) => path.join(lib.dataDir, 'cluster', 'view.json');
async function writeView(lib, view) {
  const file = viewFile(lib);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}`;
  await fsp.writeFile(tmp, JSON.stringify(view));
  await fsp.rename(tmp, file);
}
/** The replica's last view of the pool ({ nodes: {id: url}, owners: {game: [id]} }). */
export async function readView(lib) {
  try { return JSON.parse(await fsp.readFile(viewFile(lib), 'utf8')); } catch { return { nodes: {}, owners: {} }; }
}

export class Replica {
  /**
   * @param {import('./library.js').Library} lib
   * @param {{ upstream: string, token: string, nodeId: string, advertise?: string|null,
   *           intervalMs?: number, log?: Function, concurrency?: number, source: object }} opts
   */
  constructor(lib, opts) {
    this.lib = lib;
    this.upstream = opts.upstream.replace(/\/+$/, '');
    this.token = opts.token;
    this.nodeId = opts.nodeId;
    this.advertise = opts.advertise || null;
    this.source = opts.source;
    this.intervalMs = opts.intervalMs ?? 60000;
    this.log = opts.log || (() => {});
    this.concurrency = opts.concurrency || 4;
    this.state = { lastSync: null, lastError: null, running: false, games: 0, local: 0 };
    this.mode = null;
    this.diskSpace = diskSpace; // replaceable in tests
    this.view = { nodes: {}, owners: {} }; // for forwarding requests to the node that has a game
    this.timer = null;
    this.pending = null;
  }

  async api(p, init = {}) {
    const r = await fetch(this.upstream + p, { ...init, headers: { Authorization: `Bearer ${this.token}`, ...(init.headers || {}) } });
    if (!r.ok) throw new Error(`upstream ${p}: HTTP ${r.status}`);
    return r;
  }

  start() {
    const tick = () => { this.syncNow().catch(() => {}).finally(() => { this.timer = setTimeout(tick, this.intervalMs); this.timer.unref?.(); }); };
    tick();
  }

  stop() { clearTimeout(this.timer); clearTimeout(this.pokeTimer); this.timer = null; }

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

  async heartbeat() {
    const games = {};
    for (const m of await this.lib.list()) {
      const s = await localStamps(this.lib, this.source, m.id);
      if (s?.data && fs.existsSync(this.lib.rootDir(m.id))) games[m.id] = s.data;
    }
    const disk = await this.diskSpace(this.lib.gamesDir);
    await this.api('/api/sync/heartbeat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: this.nodeId, url: this.advertise, ...disk, games }),
    });
  }

  urlOf(nodeId) { return nodeId === 'primary' ? this.upstream : this.view.nodes[nodeId] || null; }

  async _sync() {
    this.state.running = true;
    try {
      await this.heartbeat();
      const plan = await (await this.api(`/api/sync?node=${encodeURIComponent(this.nodeId)}`)).json();
      this.view = {
        nodes: Object.fromEntries((plan.nodes || []).map((n) => [n.id, n.url])),
        owners: Object.fromEntries((plan.games || []).map((g) => [g.id, g.owners || []])),
      };
      this.mode = plan.mode;
      // Other worker processes read this to forward requests for games kept elsewhere.
      await writeView(this.lib, { upstream: this.upstream, ...this.view });
      const primary = remoteSource(this.upstream, this.token);
      const wanted = new Set();
      let local = 0, changed = false;
      for (const g of plan.games || []) {
        if (!ID_RE.test(g.id)) continue;
        wanted.add(g.id);
        const have = await localStamps(this.lib, this.source, g.id);
        const hasFiles = fs.existsSync(this.lib.rootDir(g.id));
        if (!g.data && hasFiles && have?.catalog !== g.catalog) {
          // The primary doesn't know the current files yet: keep ours, update the rest.
          await copyGame(this.lib, g.id, { catalogFrom: primary, dataFrom: localSource(this.lib, this.source), concurrency: this.concurrency, log: this.log });
          this.source.invalidate(g.id);
          changed = true;
          continue;
        }
        if (!g.data && hasFiles) continue;
        const wantData = g.local ? g.data : null;
        if (have && have.catalog === g.catalog && (have.data || null) === wantData && hasFiles === !!wantData) {
          if (wantData) local++;
          continue;
        }
        let dataFrom = null;
        if (wantData) {
          // Copy from any node that has the current files (never from ourselves).
          const owners = (g.owners || []).filter((o) => o !== this.nodeId && this.urlOf(o));
          if (!owners.length) { this.log(`sync: no source for ${g.id} yet`); continue; }
          const pick = owners[Math.floor(Math.random() * owners.length)];
          dataFrom = remoteSource(this.urlOf(pick), this.token);
        }
        await copyGame(this.lib, g.id, { catalogFrom: primary, dataFrom, concurrency: this.concurrency, log: this.log });
        this.source.invalidate(g.id);
        if (wantData) local++;
        changed = true;
      }
      for (const m of await this.lib.list()) {
        if (!wanted.has(m.id)) { this.log(`sync: removing ${m.id} (gone on the primary)`); await this.lib.remove(m.id); changed = true; }
      }
      if (changed) await this.heartbeat().catch(() => {});
      Object.assign(this.state, { games: wanted.size, local, lastSync: new Date().toISOString(), lastError: null });
    } catch (e) {
      this.state.lastError = e.message;
      this.log(`sync failed: ${e.message}`);
      throw e;
    } finally {
      this.state.running = false;
    }
  }
}
