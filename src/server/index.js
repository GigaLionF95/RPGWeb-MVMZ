// HTTP server: library UI, admin API, and game file serving.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { mimeOf, isCompressible } from './mime.js';
import { hookFor, patchScript, patchIndexHtml } from './inject.js';
import { importGame } from '../importer/index.js';
import { ID_RE } from '../library.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WEB_DIR = path.join(ROOT, 'web');
const RUNTIME_DIR = path.join(ROOT, 'runtime');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

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

function compress(buf, enc) {
  if (enc === 'br') return zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } });
  return zlib.gzipSync(buf, { level: 6 });
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
  const cache = new Lru(256 * 1024 * 1024);
  const jobs = new Map(); // id -> job
  const runtimeVersion = PKG.version + '-' + Math.floor(Date.now() / 1000).toString(36);

  const isAdmin = (req) => {
    const h = String(req.headers.authorization || '');
    const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
    return !!tok && safeEqual(tok, config.adminToken);
  };
  const requireAdmin = (req) => { if (!isAdmin(req)) throw new HttpError(401, 'admin token required'); };

  // ---- static file sender ---------------------------------------------------
  async function sendFile(req, res, file, { type, cacheControl, transform, cacheKey, etagSeed = '' }) {
    let st;
    try { st = await fsp.stat(file); } catch { throw new HttpError(404, 'not found'); }
    if (!st.isFile()) throw new HttpError(404, 'not found');
    type ||= mimeOf(file);
    const etag = `"${etagSeed}${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}${transform ? '-p' : ''}"`;
    const headers = { 'Content-Type': type, 'Cache-Control': cacheControl + ', no-transform', ETag: etag, 'X-Content-Type-Options': 'nosniff', Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }

    const enc = isCompressible(type) && st.size > 1024 ? pickEncoding(req) : null;
    if (transform || enc) {
      const key = `${cacheKey || file}|${etag}|${enc || 'id'}`;
      let body = cache.get(key);
      if (!body) {
        let buf = await fsp.readFile(file);
        if (transform) buf = transform(buf);
        body = enc ? compress(buf, enc) : buf;
        cache.set(key, body);
      }
      if (enc) headers['Content-Encoding'] = enc;
      headers['Content-Length'] = body.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    headers['Accept-Ranges'] = 'bytes';
    const range = req.headers.range ? parseRange(req.headers.range, st.size) : null;
    if (range === 'invalid') {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      res.end();
      return;
    }
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${st.size}`;
      headers['Content-Length'] = range.end - range.start + 1;
      res.writeHead(206, headers);
    } else {
      headers['Content-Length'] = st.size;
      res.writeHead(200, headers);
    }
    if (req.method === 'HEAD') { res.end(); return; }
    await pipeline(fs.createReadStream(file, range || {}), res).catch(() => {});
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
      res.writeHead(302, { Location: `r${meta.rev}/${rest}${search}`, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    const rev = Number(m[1]);
    let rel = m[2];
    const current = rev === meta.rev;
    const immutable = current ? 'public, max-age=31536000, immutable' : 'no-cache';

    if (rel === '' || rel.toLowerCase() === 'index.html') {
      const indexRel = resolveGamePath(g, 'index.html');
      const cfg = {
        id, engine: meta.engine, title: meta.title, rev: meta.rev,
        mzGameId: meta.mzGameId, runtimeVersion, media: meta.media,
        library: '../../../',
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
        const body = Buffer.from(JSON.stringify(g.files.map(([p, s]) => [p, s])));
        const enc = pickEncoding(req);
        const out = enc ? compress(body, enc) : body;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': immutable + ', no-transform', ...(enc ? { 'Content-Encoding': enc } : {}), 'Content-Length': out.length, Vary: 'Accept-Encoding' });
        return res.end(out);
      }
      if (name === 'manifest.webmanifest') {
        const icon = meta.icon ? [{ src: '../' + meta.icon.split('/').map(encodeURIComponent).join('/'), sizes: 'any', type: 'image/png' }] : [];
        return sendJson(res, 200, {
          name: meta.title, short_name: meta.title.slice(0, 24), start_url: './', scope: './',
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
    return sendFile(req, res, path.join(lib.rootDir(id), hit), {
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
    return { ...rest, encryption: { images: encryption?.images, audio: encryption?.audio }, url: `play/${m.id}/` };
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
    importGame(lib, tmp, {
      id, title: url.searchParams.get('title') || undefined,
      transcode: url.searchParams.get('transcode') || undefined,
      log: (m) => { job.log.push(m); if (job.log.length > 200) job.log.shift(); },
      onProgress: (p) => Object.assign(job, { phase: p.phase, done: p.done, total: p.total, message: p.message }),
    }).then((meta) => { job.status = 'done'; job.game = publicMeta(meta); })
      .catch((e) => { job.status = 'error'; job.error = e.message; })
      .finally(() => { fsp.rm(tmp, { force: true }); setTimeout(() => jobs.delete(job.id), 3600e3).unref(); });
    sendJson(res, 202, { job: job.id });
  }

  async function handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop 'api'
    const method = req.method;
    if (parts[0] === 'auth' && method === 'GET') return sendJson(res, isAdmin(req) ? 200 : 401, { admin: isAdmin(req) });
    if (parts[0] === 'games' && parts.length === 1) {
      if (method === 'GET') {
        const admin = isAdmin(req);
        if (!config.publicLibrary && !admin) throw new HttpError(401, 'admin token required');
        const games = (await lib.list()).filter((g) => admin || !g.hidden).map(publicMeta);
        return sendJson(res, 200, { games, admin });
      }
      if (method === 'POST' || method === 'PUT') return handleUpload(req, res, url);
    }
    if (parts[0] === 'games' && parts[1]) {
      const id = parts[1];
      const g = await lib.get(id);
      if (!g) throw new HttpError(404, 'game not found');
      if (parts[2] === 'icon' && method === 'GET') {
        if (!g.meta.icon) throw new HttpError(404, 'no icon');
        return sendFile(req, res, path.join(lib.rootDir(id), g.meta.icon), { cacheControl: 'public, max-age=3600' });
      }
      if (parts.length === 2) {
        if (method === 'GET') return sendJson(res, 200, publicMeta(g.meta));
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
      const job = jobs.get(parts[1]);
      if (!job) throw new HttpError(404, 'job not found');
      return sendJson(res, 200, job);
    }
    throw new HttpError(404, 'unknown endpoint');
  }

  // ---- router ----------------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let url;
    try {
      url = new URL(req.url, 'http://x');
      const p = url.pathname;
      if (p.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      if (p === '/healthz') return sendJson(res, 200, { ok: true, version: PKG.version });
      const play = /^\/play\/([^/]+)(?:\/(.*))?$/s.exec(p);
      if (play) {
        if (play[2] === undefined) { res.writeHead(301, { Location: `${play[1]}/` }); return res.end(); }
        return await serveGame(req, res, play[1], play[2], url.search);
      }
      if (p === '/' || p === '/index.html') return await sendFile(req, res, path.join(WEB_DIR, 'index.html'), { cacheControl: 'no-cache' });
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
  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`rpgm-web ${PKG.version} listening on http://${shown}:${config.port}/  (data: ${config.dataDir})`);
  console.log(`admin token: run "rpgm-web token" (or set RPGM_ADMIN_TOKEN)`);
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return server;
}
