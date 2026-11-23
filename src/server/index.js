// HTTP server: library UI, admin API, and game file serving.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { mimeOf, isCompressible } from './mime.js';
import { hookFor, patchScript, patchIndexHtml } from './inject.js';
import { importGame } from '../importer/index.js';
import { ID_RE } from '../library.js';
import { decrypt } from '../importer/rpgcrypt.js';
import { compressAsync, patchId, PRE_DIR, PRE_EXT } from '../precompress.js';
import { createSyncSource, Replica } from '../sync.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WEB_DIR = path.join(ROOT, 'web');
const RUNTIME_DIR = path.join(ROOT, 'runtime');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// Game documents get an opaque origin: game code cannot read this site's
// storage, cookies or admin token, nor call the API with them. Downloads,
// popups (links), dialogs and pointer lock keep working.
export const GAME_SANDBOX = 'allow-scripts allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-forms allow-orientation-lock allow-presentation';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// --- small LRU for compressed / patched text responses ---------------------
class Lru {
  constructor(maxBytes) { this.max = maxBytes; this.size = 0; this.map = new Map(); }
  get(k) {
    const v = this.map.get(k);
    if (v) { this.map.delete(k); this.map.set(k, v); }
    return v;
  }
  set(k, v) {
    if (v.length > this.max / 4) return;
    if (this.map.has(k)) { this.size -= this.map.get(k).length; this.map.delete(k); }
    this.map.set(k, v);
    this.size += v.length;
    for (const [key, val] of this.map) {
      if (this.size <= this.max) break;
      this.map.delete(key);
      this.size -= val.length;
    }
  }
}

/** Counting semaphore; a released slot is handed straight to the next waiter. */
class Slots {
  constructor(n) { this.free = n; this.waiting = []; }
  acquire() {
    if (this.free > 0) { this.free--; return Promise.resolve(); }
    return new Promise((resolve) => this.waiting.push(resolve));
  }
  release() {
    const next = this.waiting.shift();
    if (next) next(); else this.free++;
  }
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function pickEncoding(req) {
  const ae = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(ae)) return 'br';
  if (/\bgzip\b/.test(ae)) return 'gzip';
  return null;
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start === null) { if (end === null) return null; start = Math.max(0, size - end); end = size - 1; }
  if (end === null || end >= size) end = size - 1;
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export async function startServer(config, lib) {
  const workers = Math.max(1, Number(process.env.RPGM_WORKER_COUNT || 1));
  const leader = !process.env.RPGM_WORKER_ID || process.env.RPGM_WORKER_ID === '0';
  const cache = new Lru(Math.max(32, Math.floor(256 / workers)) * 1024 * 1024);
  const inflight = new Map(); // cache key -> Promise<Buffer>, so N requests compress once

  /** Cached body for `key`, built at most once at a time. */
  function cachedBody(key, make) {
    const hit = cache.get(key);
    if (hit) return hit;
    let p = inflight.get(key);
    if (!p) {
      p = make().then((body) => { cache.set(key, body); return body; }).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  }

  /** Precompressed index of a game, read once per meta version. */
  function preIndex(id, g) {
    g.pre ??= fsp.readFile(path.join(lib.gameDir(id), PRE_DIR, 'index.json'), 'utf8')
      .then((t) => JSON.parse(t).files || {})
      .catch(() => ({}));
    return g.pre;
  }
  const jobs = new Map(); // id -> job (this worker's imports)
  // Job state also goes to disk, so any worker can answer "how is it going".
  const jobsDir = path.join(lib.tmpDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });
  const jobWrites = new Map();
  const persistJob = (job, now = false) => {
    const write = () => { jobWrites.delete(job.id); fsp.writeFile(path.join(jobsDir, job.id + '.json'), JSON.stringify(job)).catch(() => {}); };
    if (now) { clearTimeout(jobWrites.get(job.id)); write(); return; }
    if (!jobWrites.has(job.id)) jobWrites.set(job.id, setTimeout(write, 250));
  };
  const readJob = async (id) => {
    if (jobs.has(id)) return jobs.get(id);
    if (!/^[0-9a-f]{16}$/.test(id)) return null;
    try { return JSON.parse(await fsp.readFile(path.join(jobsDir, id + '.json'), 'utf8')); } catch { return null; }
  };
  const importSlots = new Slots(config.importConcurrency || 1);
  const syncSource = createSyncSource(lib);
  // Replica mode: every worker forwards admin writes; only the leader worker syncs.
  const isReplica = !!config.upstream;
  const replica = config.upstream && leader
    ? new Replica(lib, { upstream: config.upstream, token: config.adminToken, intervalMs: config.syncIntervalMs, log: (m) => console.log(m) })
    : null;

  /** Ask the syncing worker to sync soon (it may be another process). */
  const pokeSync = () => {
    if (replica) replica.poke();
    else if (isReplica && process.send) process.send({ rpgm: 'sync-poke' });
  };
  if (replica && process.send) process.on('message', (m) => { if (m && m.rpgm === 'sync-poke') replica.poke(); });

  /** Replica: send an admin request on to the primary, streaming both ways. */
  function proxyToPrimary(req, res, url, { inspect } = {}) {
    const target = new URL(url.pathname + url.search, config.upstream + '/');
    const mod = target.protocol === 'https:' ? https : http;
    const headers = { ...req.headers, host: target.host };
    delete headers.connection;
    return new Promise((resolve) => {
      const up = mod.request(target, { method: req.method, headers }, async (ur) => {
        if (!inspect) {
          res.writeHead(ur.statusCode, ur.headers);
          ur.pipe(res);
          ur.on('end', resolve);
          ur.on('error', resolve);
          return;
        }
        const chunks = [];
        for await (const c of ur) chunks.push(c);
        const body = Buffer.concat(chunks);
        try { await inspect(ur.statusCode, body); } catch { /* sync errors show in /healthz */ }
        const h = { ...ur.headers, 'content-length': body.length };
        delete h['transfer-encoding'];
        res.writeHead(ur.statusCode, h);
        res.end(body);
        resolve();
      });
      up.on('error', (e) => {
        if (!res.headersSent) sendJson(res, 502, { error: `the primary server is unreachable (${e.message})` });
        resolve();
      });
      req.pipe(up);
    });
  }
  // Same on every worker and every server, changes only with the code the
  // browser gets, so ETags and the runtime URL stay stable behind a load balancer.
  const runtimeVersion = PKG.version + '-' + crypto.createHash('sha1')
    .update(fs.readFileSync(path.join(RUNTIME_DIR, 'runtime.js')))
    .update(fs.readFileSync(path.join(ROOT, 'src/server/inject.js')))
    .update(fs.readFileSync(path.join(WEB_DIR, 'play.html')))
    .digest('hex').slice(0, 10);

  const isAdmin = (req) => {
    const h = String(req.headers.authorization || '');
    const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
    return !!tok && safeEqual(tok, config.adminToken);
  };
  const requireAdmin = (req) => { if (!isAdmin(req)) throw new HttpError(401, 'admin token required'); };

  // ---- static file sender ---------------------------------------------------
  const CHUNK = 1024 * 1024; // read files in 1 MB blocks (default 64 KB = 16x the syscalls)

  async function sendFile(req, res, file, opts) {
    // Open once and stat the handle: one path lookup per request.
    let fh;
    try { fh = await fsp.open(file, 'r'); } catch { throw new HttpError(404, 'not found'); }
    let handedOff = false;
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new HttpError(404, 'not found');
      handedOff = await sendOpened(req, res, file, fh, st, opts);
    } finally {
      if (!handedOff) await fh.close().catch(() => {});
    }
  }

  /** Returns true when the handle was passed to a stream (which closes it). */
  async function sendOpened(req, res, file, fh, st, { type, cacheControl, transform, cacheKey, etagSeed = '', pre }) {
    type ||= mimeOf(file);
    const etag = `"${etagSeed}${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}${transform ? '-p' : ''}"`;
    const headers = { 'Content-Type': type, 'Cache-Control': cacheControl + ', no-transform', ETag: etag, 'X-Content-Type-Options': 'nosniff', Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return false; }

    const enc = isCompressible(type) && st.size > 1024 ? pickEncoding(req) : null;

    // Precompressed copy made at import: stream it, no CPU spent.
    const e = enc && pre?.entry;
    if (e && e[enc] && e.size === st.size && e.mtime === Math.floor(st.mtimeMs) && (e.patch || null) === (pre.patch || null)) {
      const ph = await fsp.open(pre.file + PRE_EXT[enc]).catch(() => null);
      if (ph) {
        headers['Content-Encoding'] = enc;
        headers['Content-Length'] = e[enc];
        res.writeHead(200, headers);
        if (req.method === 'HEAD') { await ph.close(); res.end(); return false; }
        await pipeline(ph.createReadStream({ highWaterMark: CHUNK }), res).catch(() => {});
        return false;
      }
    }

    if (transform || enc) {
      const key = `${cacheKey || file}|${etag}|${enc || 'id'}`;
      const body = await cachedBody(key, async () => {
        let buf = await fh.readFile();
        if (transform) buf = transform(buf);
        return enc ? compressAsync(buf, enc) : buf;
      });
      if (enc) headers['Content-Encoding'] = enc;
      headers['Content-Length'] = body.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
      return false;
    }

    headers['Accept-Ranges'] = 'bytes';
    const range = req.headers.range ? parseRange(req.headers.range, st.size) : null;
    if (range === 'invalid') {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      res.end();
      return false;
    }
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${st.size}`;
      headers['Content-Length'] = range.end - range.start + 1;
      res.writeHead(206, headers);
    } else {
      headers['Content-Length'] = st.size;
      res.writeHead(200, headers);
    }
    if (req.method === 'HEAD') { res.end(); return false; }
    if (st.size === 0) { res.end(); return false; }
    // The stream owns the handle from here (closes it at the end or on error).
    await pipeline(fh.createReadStream({ ...(range || {}), highWaterMark: CHUNK }), res).catch(() => {});
    return true;
  }

  // ---- games -----------------------------------------------------------------
  function resolveGamePath(g, rel) {
    if (g.fileSet.has(rel)) return rel;
    const hit = g.lower.get(rel.toLowerCase());
    if (hit) return hit;
    return null;
  }

  async function serveGame(req, res, id, rest, search = '') {
    const g = await lib.get(id);
    if (!g) throw new HttpError(404, 'game not found');
    const { meta } = g;
    // /play/<id>/  → versioned base so every asset URL can be cached forever.
    const m = /^r(\d+)\/(.*)$/s.exec(rest);
    if (!m) {
      if (rest === '' || rest.toLowerCase() === 'index.html') return servePlayHost(req, res, id, g);
      res.writeHead(302, { Location: `r${meta.rev}/${rest}${search}`, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    // Everything under r<rev>/ is game content: sandboxed, and reachable
    // from the sandbox's opaque origin (CORS).
    setFrameHeaders(res, true, config.gameSandbox !== false ? `sandbox ${GAME_SANDBOX}` : null);
    res.setHeader('Access-Control-Allow-Origin', '*');
    const rev = Number(m[1]);
    let rel = m[2];
    const current = rev === meta.rev;
    const immutable = current ? 'public, max-age=31536000, immutable' : 'no-cache';

    if (rel === '' || rel.toLowerCase() === 'index.html') {
      const indexRel = resolveGamePath(g, 'index.html');
      const cfg = {
        id, engine: meta.engine, title: meta.title, rev: meta.rev,
        mzGameId: meta.mzGameId, runtimeVersion, media: meta.media,
        library: '../../../', sandbox: config.gameSandbox !== false,
      };
      return sendFile(req, res, path.join(lib.rootDir(id), indexRel), {
        type: 'text/html; charset=utf-8', cacheControl: 'no-cache',
        transform: (buf) => Buffer.from(patchIndexHtml(buf.toString('utf8'), cfg)),
        cacheKey: `index|${id}|${runtimeVersion}`, etagSeed: runtimeVersion + '-',
      });
    }

    if (rel.startsWith('__rpgm/')) {
      const name = rel.slice(7);
      if (name === 'files.json') {
        const enc = pickEncoding(req);
        const out = await cachedBody(`files|${id}|${g.mtime}|${enc || 'id'}`, async () => {
          const body = Buffer.from(JSON.stringify(g.files.map(([p, s]) => [p, s])));
          return enc ? compressAsync(body, enc) : body;
        });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': immutable + ', no-transform', ...(enc ? { 'Content-Encoding': enc } : {}), 'Content-Length': out.length, Vary: 'Accept-Encoding' });
        return res.end(out);
      }
      if (name === 'manifest.webmanifest') {
        const icon = meta.icon ? [{ src: '../' + meta.icon.split('/').map(encodeURIComponent).join('/'), sizes: 'any', type: 'image/png' }] : [];
        return sendJson(res, 200, {
          name: meta.title, short_name: meta.title.slice(0, 24), start_url: '../../', scope: '../../',
          display: 'fullscreen', orientation: 'landscape', background_color: '#000000', theme_color: '#000000', icons: icon,
        });
      }
      if (/^[\w.-]+$/.test(name)) {
        return sendFile(req, res, path.join(RUNTIME_DIR, name), { cacheControl: 'no-cache' });
      }
      throw new HttpError(404, 'not found');
    }

    try { rel = rel.split('/').map(decodeURIComponent).join('/'); } catch { throw new HttpError(400, 'bad path'); }
    if (rel.split('/').some((s) => s === '..' || s === '.')) throw new HttpError(400, 'bad path');
    const hit = resolveGamePath(g, rel);
    if (!hit) throw new HttpError(404, 'not found');
    const hook = hookFor(hit);
    const preFiles = await preIndex(id, g);
    return sendFile(req, res, path.join(lib.rootDir(id), hit), {
      pre: preFiles[hit] ? { entry: preFiles[hit], file: path.join(lib.gameDir(id), PRE_DIR, hit), patch: patchId(hook) } : null,
      cacheControl: hook ? 'no-cache' : immutable,
      transform: hook ? (buf) => patchScript(buf, hook) : null,
      cacheKey: hook ? `hook|${id}|${hit}|${runtimeVersion}` : null,
      etagSeed: hook ? runtimeVersion + '-' : `r${rev}-`,
    });
  }

  // ---- API -------------------------------------------------------------------
  async function readJsonBody(req, limit = 64 * 1024) {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > limit) throw new HttpError(413, 'body too large'); chunks.push(c); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'invalid JSON'); }
  }

  function publicMeta(m) {
    const { encryption, ...rest } = m;
    const hasCover = !!(m.customCover || m.titleArt);
    return {
      ...rest,
      encryption: { images: encryption?.images, audio: encryption?.audio },
      url: `play/${m.id}/`,
      embedUrl: `embed/${m.id}/`,
      hasCover,
      coverUrl: hasCover ? `api/games/${m.id}/cover?v=${m.coverRev || m.rev}` : null,
    };
  }

  /** Cover art: custom upload, else the title screen background (decrypted). */
  async function sendCover(req, res, g) {
    const custom = g.meta.customCover ? await lib.customCover(g.meta.id) : null;
    if (custom) return sendFile(req, res, custom.path, { type: custom.type, cacheControl: 'public, max-age=86400' });
    const art = g.meta.titleArt;
    if (!art) throw new HttpError(404, 'no cover');
    const file = path.join(lib.rootDir(g.meta.id), art);
    const encrypted = /\.(rpgmvp|png_)$/i.test(art);
    if (!encrypted) return sendFile(req, res, file, { type: 'image/png', cacheControl: 'public, max-age=86400' });
    const key = g.meta.encryption?.key;
    if (!key) throw new HttpError(404, 'no cover');
    return sendFile(req, res, file, {
      type: 'image/png', cacheControl: 'public, max-age=86400',
      transform: (buf) => decrypt(buf, key), cacheKey: `cover|${g.meta.id}`,
    });
  }

  async function handleCoverUpload(req, res, id) {
    requireAdmin(req);
    const types = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
    const ext = types[String(req.headers['content-type'] || '').split(';')[0].trim()];
    if (!ext) throw new HttpError(415, 'cover must be PNG, JPEG or WebP');
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > 10 * 1024 * 1024) throw new HttpError(413, 'cover is larger than 10 MB'); chunks.push(c); }
    await lib.setCover(id, Buffer.concat(chunks), ext);
    return sendJson(res, 200, publicMeta((await lib.get(id)).meta));
  }

  async function handleUpload(req, res, url) {
    requireAdmin(req);
    const len = Number(req.headers['content-length'] || 0);
    if (len > config.maxUploadBytes) throw new HttpError(413, 'archive too large');
    const id = url.searchParams.get('id') || undefined;
    if (id && !ID_RE.test(id)) throw new HttpError(400, 'invalid id');
    const name = path.basename(url.searchParams.get('filename') || req.headers['x-filename'] || 'upload.zip').replace(/[^\w.\- ]+/g, '_');
    const tmp = path.join(lib.tmpDir, `upload-${crypto.randomBytes(6).toString('hex')}-${name}`);
    let received = 0;
    const limiter = async function* (src) {
      for await (const c of src) {
        received += c.length;
        if (received > config.maxUploadBytes) throw new HttpError(413, 'archive too large');
        yield c;
      }
    };
    try {
      await pipeline(req, limiter, fs.createWriteStream(tmp));
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e instanceof HttpError ? e : new HttpError(400, 'upload failed: ' + e.message);
    }
    const job = {
      id: crypto.randomBytes(8).toString('hex'), status: 'running', phase: 'queued', done: 0, total: 0,
      log: [], startedAt: new Date().toISOString(), game: null, error: null,
    };
    jobs.set(job.id, job);
    persistJob(job, true);
    // One import at a time (RPGM_IMPORT_CONCURRENCY): unpacking, ffmpeg and
    // brotli are CPU-heavy, and players come first.
    importSlots.acquire()
      .then(() => importGame(lib, tmp, {
      id, title: url.searchParams.get('title') || undefined,
      transcode: url.searchParams.get('transcode') || undefined,
      precompress: config.precompress,
      limits: config.limits,
      log: (m) => { job.log.push(m); if (job.log.length > 200) job.log.shift(); persistJob(job); },
      onProgress: (p) => { Object.assign(job, { phase: p.phase, done: p.done, total: p.total, message: p.message }); persistJob(job); },
    }).finally(() => importSlots.release()))
      .then((meta) => { job.status = 'done'; job.game = publicMeta(meta); })
      .catch((e) => { job.status = 'error'; job.error = e.message; })
      .finally(() => {
        persistJob(job, true);
        fsp.rm(tmp, { force: true });
        setTimeout(() => { jobs.delete(job.id); fsp.rm(path.join(jobsDir, job.id + '.json'), { force: true }); }, 3600e3).unref();
      });
    sendJson(res, 202, { job: job.id });
  }

  async function handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop 'api'
    const method = req.method;

    // Library sync for replicas (admin token).
    if (parts[0] === 'sync' && (method === 'GET' || method === 'HEAD')) {
      requireAdmin(req);
      if (parts.length === 1) return sendJson(res, 200, await syncSource.list());
      const id = parts[1];
      if (parts.length === 2) {
        const e = await syncSource.game(id);
        if (!e) throw new HttpError(404, 'game not found');
        return sendJson(res, 200, { id, stamp: e.stamp, files: e.files });
      }
      if (parts[2] === 'file' && parts.length === 3) {
        const file = await syncSource.file(id, url.searchParams.get('path'));
        if (!file) throw new HttpError(404, 'not found');
        const st = await fsp.stat(file);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
        if (method === 'HEAD') return res.end();
        return pipeline(fs.createReadStream(file), res).catch(() => {});
      }
      throw new HttpError(404, 'not found');
    }

    // Replica: the primary owns the library. Admin writes and import jobs go
    // there; when a job finishes, pull the result before answering.
    if (isReplica && (parts[0] === 'jobs' || (parts[0] === 'games' && method !== 'GET' && method !== 'HEAD'))) {
      requireAdmin(req);
      if (parts[0] === 'jobs') {
        return proxyToPrimary(req, res, url, {
          inspect: async (status, body) => {
            if (status !== 200 || JSON.parse(body).status !== 'done') return;
            if (replica) await replica.syncNow(); else pokeSync();
          },
        });
      }
      await proxyToPrimary(req, res, url);
      pokeSync();
      return;
    }

    if (parts[0] === 'auth' && method === 'GET') return sendJson(res, isAdmin(req) ? 200 : 401, { admin: isAdmin(req) });
    if (parts[0] === 'games' && parts.length === 1) {
      if (method === 'GET') {
        const admin = isAdmin(req);
        if ((!config.publicLibrary || config.apiOnly) && !admin) throw new HttpError(401, 'admin token required');
        const games = (await lib.list()).filter((g) => admin || !g.hidden).map(publicMeta);
        return sendJson(res, 200, { games, admin });
      }
      if (method === 'POST' || method === 'PUT') return handleUpload(req, res, url);
    }
    if (parts[0] === 'games' && parts[1]) {
      const id = parts[1];
      const g = await lib.get(id);
      if (!g) throw new HttpError(404, 'game not found');
      // Images come from the game: never let one run as a document here.
      if (parts[2] === 'icon' || parts[2] === 'cover') res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
      if (parts[2] === 'icon' && method === 'GET') {
        if (!g.meta.icon) throw new HttpError(404, 'no icon');
        return sendFile(req, res, path.join(lib.rootDir(id), g.meta.icon), { cacheControl: 'public, max-age=3600' });
      }
      if (parts[2] === 'cover' && parts.length === 3) {
        if (method === 'GET' || method === 'HEAD') return sendCover(req, res, g);
        if (method === 'PUT' || method === 'POST') return handleCoverUpload(req, res, id);
        if (method === 'DELETE') { requireAdmin(req); await lib.removeCover(id, { updateMeta: true }); return sendJson(res, 200, publicMeta((await lib.get(id)).meta)); }
      }
      if (parts.length === 2) {
        if (method === 'GET') { res.setHeader('Access-Control-Allow-Origin', '*'); return sendJson(res, 200, publicMeta(g.meta)); }
        if (method === 'PATCH') {
          requireAdmin(req);
          const body = await readJsonBody(req);
          const patch = {};
          if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim().slice(0, 200);
          if (typeof body.hidden === 'boolean') patch.hidden = body.hidden;
          return sendJson(res, 200, publicMeta(await lib.updateMeta(id, patch)));
        }
        if (method === 'DELETE') { requireAdmin(req); await lib.remove(id); return sendJson(res, 200, { removed: id }); }
      }
    }
    if (parts[0] === 'jobs' && parts[1] && method === 'GET') {
      requireAdmin(req);
      const job = await readJob(parts[1]);
      if (!job) throw new HttpError(404, 'job not found');
      return sendJson(res, 200, job);
    }
    throw new HttpError(404, 'unknown endpoint');
  }

  // ---- embeds ----------------------------------------------------------------
  /** Games and the embed page may be framed (as configured); the admin UI may not. */
  function setFrameHeaders(res, embeddable, extraCsp = null) {
    const csp = extraCsp ? [extraCsp] : [];
    if (!embeddable) {
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      csp.push("frame-ancestors 'self'");
    } else if (config.frameAncestors && config.frameAncestors !== '*') {
      csp.push(`frame-ancestors 'self' ${config.frameAncestors}`);
    }
    if (csp.length) res.setHeader('Content-Security-Policy', csp.join('; '));
  }

  /** /play/<id>/: our host page, which keeps saves and frames the sandboxed game. */
  async function servePlayHost(req, res, id, g) {
    const { meta } = g;
    const cfg = {
      id, title: meta.title,
      src: `r${meta.rev}/`,
      manifest: `r${meta.rev}/__rpgm/manifest.webmanifest`,
      library: '../../',
      embed: `../../embed/${id}/`,
      sandbox: config.gameSandbox !== false ? GAME_SANDBOX : null,
    };
    return sendFile(req, res, path.join(WEB_DIR, 'play.html'), {
      type: 'text/html; charset=utf-8', cacheControl: 'no-cache',
      transform: (buf) => Buffer.from(buf.toString('utf8').replace('/*RPGM_PLAY*/null', JSON.stringify(cfg).replace(/</g, '\\u003c'))),
      cacheKey: `play|${id}|${g.mtime}|${runtimeVersion}`, etagSeed: `h${Math.floor(g.mtime).toString(36)}-${runtimeVersion}-`,
    });
  }

  async function serveEmbed(req, res, id) {
    const g = await lib.get(id);
    if (!g) throw new HttpError(404, 'game not found');
    const m = publicMeta(g.meta);
    const cfg = {
      id, title: m.title, engine: m.engine, engineVersion: m.engineVersion, screen: m.screen,
      cover: m.coverUrl ? `../../${m.coverUrl}` : null,
      icon: m.icon ? `../../api/games/${id}/icon` : null,
      play: `../../play/${id}/?embed=1`,
      open: `../../play/${id}/`,
    };
    return sendFile(req, res, path.join(WEB_DIR, 'embed.html'), {
      type: 'text/html; charset=utf-8', cacheControl: 'no-cache',
      transform: (buf) => Buffer.from(buf.toString('utf8').replace('/*RPGM_EMBED*/null', JSON.stringify(cfg).replace(/</g, '\\u003c'))),
      cacheKey: `embed|${id}|${g.mtime}`, etagSeed: `e${Math.floor(g.mtime).toString(36)}-`,
    });
  }

  // ---- router ----------------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let url;
    try {
      url = new URL(req.url, 'http://x');
      const p = url.pathname;
      if (p.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method === 'OPTIONS' && p.startsWith('/play/')) {
        // CORS preflight from the sandboxed game (plugins sending custom headers).
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD',
          'Access-Control-Allow-Headers': String(req.headers['access-control-request-headers'] || '').slice(0, 1000),
          'Access-Control-Max-Age': '86400',
        });
        return res.end();
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      if (p === '/healthz') {
        return sendJson(res, 200, {
          ok: true, version: PKG.version,
          role: isReplica ? 'replica' : 'primary',
          ...(isReplica ? { upstream: config.upstream } : {}),
          ...(replica ? { sync: replica.state } : {}),
          ...(workers > 1 ? { worker: Number(process.env.RPGM_WORKER_ID || 0), workers } : {}),
        });
      }
      const play = /^\/play\/([^/]+)(?:\/(.*))?$/s.exec(p);
      if (play) {
        if (play[2] === undefined) { res.writeHead(301, { Location: `${play[1]}/${url.search}` }); return res.end(); }
        setFrameHeaders(res, true);
        return await serveGame(req, res, play[1], play[2], url.search);
      }
      const embed = /^\/embed\/([^/]+)(\/)?$/.exec(p);
      if (embed) {
        if (!embed[2]) { res.writeHead(301, { Location: `${embed[1]}/${url.search}` }); return res.end(); }
        setFrameHeaders(res, true);
        return await serveEmbed(req, res, embed[1]);
      }
      if (p === '/sdk/rpgm-embed.js') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        return await sendFile(req, res, path.join(WEB_DIR, 'sdk.js'), { cacheControl: 'public, max-age=3600' });
      }
      if (config.apiOnly && (p === '/' || p === '/index.html' || p.startsWith('/assets/'))) {
        throw new HttpError(404, 'this server runs in API-only mode (no library page)');
      }
      if (p === '/' || p === '/index.html') {
        setFrameHeaders(res, false);
        return await sendFile(req, res, path.join(WEB_DIR, 'index.html'), { cacheControl: 'no-cache' });
      }
      const asset = /^\/assets\/([\w.-]+)$/.exec(p);
      if (asset) return await sendFile(req, res, path.join(WEB_DIR, asset[1]), { cacheControl: 'no-cache' });
      throw new HttpError(404, 'not found');
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(`[${req.method} ${req.url}]`, e);
      if (!res.headersSent) sendJson(res, status, { error: e.message || 'error' });
      else res.destroy();
    } finally {
      if (process.env.RPGM_LOG === '1' || (res.statusCode >= 400 && res.statusCode !== 404)) {
        console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  });
  server.requestTimeout = 0; // large uploads
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 30_000;

  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  if (!leader) return server; // the leader prints the banner and runs the sync
  if (replica) {
    console.log(`replica of ${config.upstream}: syncing every ${Math.round(config.syncIntervalMs / 1000)} s`);
    replica.start();
    server.on('close', () => replica.stop());
    server.replica = replica;
  }
  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`rpgm-web ${PKG.version} listening on http://${shown}:${config.port}/  (data: ${config.dataDir})`);
  console.log(`admin token: run "rpgm-web token" (or set RPGM_ADMIN_TOKEN)`);
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return server;
}
