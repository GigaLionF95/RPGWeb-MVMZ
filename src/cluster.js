// Where game files live when several servers share one library (primary side).
//
// RPGM_REPLICAS on the primary:
//   all  every server keeps every game (default)
//   N    each game is kept on N servers (e.g. 2)
//   1    no duplication: each game lives on one server
// New games go to the servers with the most free disk. A server that stops
// reporting for RPGM_NODE_TIMEOUT seconds is dropped from the placement and its
// games are copied to other servers (as long as some server still has them).
//
// State is plain files under <data>/cluster/ so every worker process can read it:
//   nodes/<id>.json   last heartbeat of each server ("primary" = this one)
//   placement.json    { mode, placement: {game: [node...]}, stamps: {game: dataStamp} }
// Only the leader worker writes placement.json and moves this server's files.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ID_RE } from './library.js';
import { diskSpace, copyGame, localSource, remoteSource } from './sync.js';
import { PRE_DIR } from './precompress.js';

export const PRIMARY = 'primary';
const NODE_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function parseReplicas(v) {
  const s = String(v ?? 'all').trim().toLowerCase();
  if (s === '' || s === 'all') return 'all';
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) throw new Error(`RPGM_REPLICAS must be "all" or a number ≥ 1 (got "${v}")`);
  return n;
}

async function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}`;
  await fsp.writeFile(tmp, JSON.stringify(obj));
  await fsp.rename(tmp, file);
}

export class Cluster {
  /**
   * @param {import('./library.js').Library} lib
   * @param {{ source: object, replicas: 'all'|number, token: string, nodeTimeoutMs?: number, log?: Function }} opts
   */
  constructor(lib, opts) {
    this.lib = lib;
    this.source = opts.source;
    this.mode = opts.replicas ?? 'all';
    this.token = opts.token;
    this.timeoutMs = opts.nodeTimeoutMs ?? 180000;
    this.log = opts.log || (() => {});
    this.dir = path.join(lib.dataDir, 'cluster');
    this.nodesDir = path.join(this.dir, 'nodes');
    fs.mkdirSync(this.nodesDir, { recursive: true });
    this.placementFile = path.join(this.dir, 'placement.json');
    this._read = { at: 0, value: null };
    this.busy = null;
    this.moving = new Set(); // games this server is copying right now
    this.diskSpace = diskSpace; // replaceable in tests
  }

  // ---- shared state (any worker) --------------------------------------------
  /** { nodes: {id: node}, placement, stamps, mode } — cached for a second. */
  async state() {
    if (Date.now() - this._read.at < 1000 && this._read.value) return this._read.value;
    const nodes = {};
    for (const f of await fsp.readdir(this.nodesDir).catch(() => [])) {
      if (!f.endsWith('.json')) continue;
      try { const n = JSON.parse(await fsp.readFile(path.join(this.nodesDir, f), 'utf8')); if (NODE_RE.test(n.id)) nodes[n.id] = n; } catch { /* being written */ }
    }
    let p = {};
    try { p = JSON.parse(await fsp.readFile(this.placementFile, 'utf8')); } catch { /* first run */ }
    const value = { nodes, placement: p.placement || {}, stamps: p.stamps || {}, mode: this.mode };
    this._read = { at: Date.now(), value };
    return value;
  }

  alive(n) { return !!n && (n.id === PRIMARY || Date.now() - n.seen < this.timeoutMs); }

  /** Store a heartbeat from another server. */
  async heartbeat(body) {
    const id = String(body?.id || '');
    if (!NODE_RE.test(id) || id === PRIMARY) throw new Error('bad node id');
    const games = {};
    for (const [g, s] of Object.entries(body.games || {})) if (ID_RE.test(g) && typeof s === 'string') games[g] = s.slice(0, 64);
    let url = null;
    if (body.url) {
      try { const u = new URL(String(body.url)); if (/^https?:$/.test(u.protocol)) url = u.origin; } catch { /* ignore */ }
    }
    const node = { id, url, free: Number(body.free) || 0, total: Number(body.total) || 0, games, seen: Date.now() };
    const known = fs.existsSync(path.join(this.nodesDir, id + '.json'));
    await writeJsonAtomic(path.join(this.nodesDir, id + '.json'), node);
    this._read.at = 0;
    return { known };
  }

  /** Nodes that have the current files of a game, alive ones only. */
  owners(st, game) {
    const want = st.stamps[game];
    if (!want) return [];
    return Object.values(st.nodes).filter((n) => this.alive(n) && n.games?.[game] === want).map((n) => n.id);
  }

  /** What one server should hold: GET /api/sync?node=<id>. */
  async plan(nodeId) {
    const st = await this.state();
    const games = [];
    for (const m of await this.lib.list()) {
      const e = await this.source.game(m.id);
      if (!e) continue;
      const assigned = st.placement[m.id] || [];
      // Our own copy is the freshest truth (a re-import shows here at once).
      const data = e.dataStamp || st.stamps[m.id] || null;
      const owners = this.owners({ ...st, stamps: { ...st.stamps, [m.id]: data } }, m.id).filter((n) => n !== PRIMARY);
      if (e.dataStamp) owners.unshift(PRIMARY);
      const holds = owners.includes(nodeId);
      // 'all': everyone keeps everything. Otherwise keep files until every
      // assigned server has them (hand-off, never zero copies).
      const local = this.mode === 'all' || assigned.includes(nodeId)
        || (holds && (!assigned.length || !assigned.every((a) => owners.includes(a))));
      games.push({ id: m.id, rev: m.rev, catalog: e.catalogStamp, data, local, owners });
    }
    const nodes = Object.values(st.nodes).filter((n) => n.id !== PRIMARY && n.url && this.alive(n)).map((n) => ({ id: n.id, url: n.url }));
    return { mode: this.mode, nodes, games };
  }

  /** Summary for /api/cluster and /healthz. */
  async summary() {
    const st = await this.state();
    const nodes = Object.values(st.nodes).map((n) => ({
      id: n.id, url: n.url, alive: this.alive(n), free: n.free, total: n.total,
      games: Object.keys(n.games || {}).filter((g) => n.games[g] === st.stamps[g]).length,
      lastSeen: new Date(n.seen).toISOString(),
    }));
    return { mode: this.mode, nodes, placement: st.placement };
  }

  // ---- leader: decide placement, move this server's own files ----------------
  tick() {
    if (this.busy) return this.busy;
    this.busy = this._tick().catch((e) => this.log(`cluster: ${e.message}`)).finally(() => { this.busy = null; });
    return this.busy;
  }

  async _tick() {
    const games = await this.lib.list();
    // 1. This server's own heartbeat and the current data stamp of each game
    //    (known from our copy; remembered after our copy is gone).
    let prev = {};
    try { prev = JSON.parse(await fsp.readFile(this.placementFile, 'utf8')); } catch { /* first run */ }
    const stamps = {};
    const mine = {};
    for (const m of games) {
      const hasFiles = fs.existsSync(this.lib.rootDir(m.id));
      const e = hasFiles ? await this.source.game(m.id) : null;
      if (e?.dataStamp) { stamps[m.id] = e.dataStamp; mine[m.id] = e.dataStamp; }
      else if (prev.stamps?.[m.id]) stamps[m.id] = prev.stamps[m.id];
    }
    const disk = await this.diskSpace(this.lib.gamesDir);
    await writeJsonAtomic(path.join(this.nodesDir, PRIMARY + '.json'), { id: PRIMARY, url: null, ...disk, games: mine, seen: Date.now() });
    this._read.at = 0;
    const st = { ...(await this.state()), stamps };

    // Forget servers that have been gone for a long time (7 days).
    for (const n of Object.values(st.nodes)) {
      if (n.id !== PRIMARY && Date.now() - n.seen > 7 * 86400e3) {
        await fsp.rm(path.join(this.nodesDir, n.id + '.json'), { force: true });
        delete st.nodes[n.id];
      }
    }

    // 2. Placement.
    const alive = Object.values(st.nodes).filter((n) => this.alive(n));
    const placement = this.place(games, alive, prev.placement || {}, st);
    const next = { mode: this.mode, placement, stamps, at: new Date().toISOString() };
    if (JSON.stringify([prev.mode, prev.placement, prev.stamps]) !== JSON.stringify([next.mode, next.placement, next.stamps])) {
      await writeJsonAtomic(this.placementFile, next);
      this._read.at = 0;
    }

    // 3. Move this server's own files: drop the ones handed off, fetch the ones assigned.
    const plan = await this.plan(PRIMARY);
    const urls = Object.fromEntries(plan.nodes.map((n) => [n.id, n.url]));
    for (const g of plan.games) {
      if (!stamps[g.id] || !placement[g.id]?.length) continue; // not placed yet
      const hasFiles = fs.existsSync(this.lib.rootDir(g.id));
      if (!g.local && hasFiles) {
        await this.dropFiles(g.id);
        this.log(`cluster: ${g.id} now lives on ${(placement[g.id] || []).join(', ')} — removed the copy here`);
      } else if (g.local && !hasFiles && !this.moving.has(g.id)) {
        const from = g.owners.filter((o) => urls[o]);
        if (!from.length) { this.log(`cluster: ${g.id} is placed here but no server has its files right now`); continue; }
        this.moving.add(g.id);
        try {
          await copyGame(this.lib, g.id, {
            catalogFrom: localSource(this.lib, this.source),
            dataFrom: remoteSource(urls[from[Math.floor(Math.random() * from.length)]], this.token),
            log: this.log,
          });
          this.source.invalidate(g.id);
        } catch (e) { this.log(`cluster: copying ${g.id} here failed: ${e.message}`); } finally { this.moving.delete(g.id); }
      }
    }
  }

  /**
   * Placement for every game: keep alive assignees, then fill up to the
   * target with the servers that have the most free space after the games
   * already headed their way. Largest games are placed first.
   */
  place(games, alive, prev, st) {
    const ids = alive.map((n) => n.id).sort();
    const target = this.mode === 'all' ? ids.length : Math.min(this.mode, ids.length);
    const size = Object.fromEntries(games.map((m) => [m.id, m.totalBytes || 0]));
    const free = Object.fromEntries(alive.map((n) => [n.id, n.free || 0]));
    const holds = (node, g) => st.nodes[node]?.games?.[g] && st.nodes[node].games[g] === st.stamps[g];
    // Games placed on a server it doesn't have yet will use that space.
    for (const [g, nodes] of Object.entries(prev)) {
      for (const n of nodes) if (n in free && !holds(n, g)) free[n] -= size[g] || 0;
    }
    const out = {};
    const order = [...games].sort((a, b) => (size[b.id] - size[a.id]) || a.id.localeCompare(b.id));
    for (const m of order) {
      if (this.mode === 'all') { out[m.id] = ids; continue; }
      let keep = (prev[m.id] || []).filter((n) => n in free);
      if (keep.length > target) {
        // Fewer copies wanted now: keep the ones on the emptiest servers.
        keep.sort((a, b) => free[b] - free[a]);
        for (const n of keep.slice(target)) if (!holds(n, m.id)) free[n] += size[m.id];
        keep = keep.slice(0, target);
      }
      while (keep.length < target) {
        // A server that already has the files counts them as free: no copy needed.
        const score = (n) => free[n] + (holds(n, m.id) ? size[m.id] : 0);
        const pick = ids.filter((n) => !keep.includes(n)).sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0];
        if (!pick) break;
        if (!holds(pick, m.id)) free[pick] -= size[m.id];
        keep.push(pick);
      }
      out[m.id] = keep.sort();
    }
    return out;
  }

  /** Remove a game's files here, keep its catalog entry (meta, cover, file list). */
  async dropFiles(id) {
    const trash = path.join(this.lib.tmpDir, `drop-${id}-${crypto.randomBytes(4).toString('hex')}`);
    await fsp.mkdir(trash);
    for (const d of ['game', PRE_DIR]) await fsp.rename(path.join(this.lib.gameDir(id), d), path.join(trash, d)).catch(() => {});
    await fsp.rm(path.join(this.lib.gameDir(id), '.sync.json'), { force: true });
    this.lib._cache.delete(id);
    this.source.invalidate(id);
    await fsp.rm(trash, { recursive: true, force: true });
  }
}
