/*
 * rpgm-web browser runtime.
 *
 * Injected before any game script. Keeps the engine in its native browser mode
 * and gives NW.js-only code what it expects:
 *   - per-game persistent storage (IndexedDB) behind localStorage, localforage
 *     and a synchronous `fs`, loaded before the game boots;
 *   - require()/process/nw shims for plugins that call Node or NW.js APIs;
 *   - desktop-identical defaults (stretch to window) and media fallbacks;
 *   - a small overlay: fullscreen, sound, save export/import, back to library.
 */
(function () {
  'use strict';
  if (window.__RPGM) return;
  var CFG = window.__RPGM_CONFIG || {};
  var GAME_ID = CFG.id || 'game';
  var params = new URLSearchParams(location.search);
  var R = (window.__RPGM = { config: CFG, version: CFG.runtimeVersion, hooksRun: {} });
  var log = function () { if (params.has('rpgm-debug')) console.log.apply(console, ['[rpgm]'].concat([].slice.call(arguments))); };

  // The game runs inside /play/<id>/ (web/play.html), in a sandboxed frame with
  // an opaque origin: it cannot reach the site's storage, cookies or admin
  // token. The host page (our code, real origin) keeps the saves and talks to
  // the game over postMessage. HERE is the server origin the host lives on.
  var HERE = new URL(location.href).origin;
  var SANDBOX = !!CFG.sandbox;
  if (window.parent === window) {
    // Opened directly (old link or bookmark): go through the host page.
    location.replace('../' + location.search + location.hash);
    return;
  }

  // Compatibility with the opaque origin. Every request to the server is now
  // cross-origin (the server answers with CORS headers):
  if (SANDBOX) {
    // - images/videos from the server need CORS mode, or WebGL refuses them
    //   (PIXI thinks they are same-origin and would not ask for it);
    var corsify = function (proto, prop) {
      var d = proto && Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.set) return;
      Object.defineProperty(proto, prop, {
        configurable: true, enumerable: d.enumerable, get: d.get,
        set: function (v) {
          try { if (this.crossOrigin == null && new URL(String(v), location.href).origin === HERE) this.crossOrigin = 'anonymous'; } catch (e) { /* keep as is */ }
          d.set.call(this, v);
        },
      });
    };
    corsify(window.HTMLImageElement && HTMLImageElement.prototype, 'src');
    corsify(window.HTMLMediaElement && HTMLMediaElement.prototype, 'src');
    // - requests "with credentials" (cookies) to the server: browsers refuse the
    //   server's "Access-Control-Allow-Origin: *" for those, so the load fails.
    //   Game files need no cookies; send them without. (Old Effekseer, in MZ
    //   1.1 games, hard-codes image.crossOrigin = "use-credentials".)
    var ours = function (u) { try { return new URL(String(u), location.href).origin === HERE; } catch (e) { return false; } };
    var co = window.HTMLImageElement && Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'crossOrigin');
    var srcD = window.HTMLImageElement && Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (co && co.set && srcD && srcD.set) {
      Object.defineProperty(HTMLImageElement.prototype, 'crossOrigin', {
        configurable: true, enumerable: co.enumerable, get: co.get,
        set: function (v) {
          // Before src is known, keep the wish; the src setter below decides.
          if (v === 'use-credentials') { this.__rpgmCreds = true; v = 'anonymous'; }
          co.set.call(this, v);
        },
      });
      var srcWrapped = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        configurable: true, enumerable: srcWrapped.enumerable, get: srcWrapped.get,
        set: function (v) {
          // A credentialed load of another site's image keeps its credentials.
          if (this.__rpgmCreds && !ours(v)) co.set.call(this, 'use-credentials');
          srcWrapped.set.call(this, v);
        },
      });
    }
    if (window.XMLHttpRequest) {
      var XO2 = XMLHttpRequest.prototype.open, XS2 = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) { this.__rpgmOurs = ours(u); return XO2.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function () {
        if (this.__rpgmOurs && this.withCredentials) this.withCredentials = false;
        return XS2.apply(this, arguments);
      };
    }
    if (window.fetch) {
      var F2 = window.fetch;
      window.fetch = function (input, init) {
        var url = input && input.url ? input.url : input;
        if (init && init.credentials === 'include' && ours(url)) init = Object.assign({}, init, { credentials: 'omit' });
        return F2.call(this, input, init);
      };
    }
    // - scripts too, so errors in them show their message instead of
    //   "Script error." (plugins are added as <script src> by the engine);
    corsify(window.HTMLScriptElement && HTMLScriptElement.prototype, 'src');
    // - a Worker script must be same-origin: start it from a blob instead
    //   (MZ decodes Ogg audio in a worker);
    var OrigWorker = window.Worker;
    if (OrigWorker) {
      var SandboxWorker = function (url, opts) {
        var abs = null;
        try { abs = new URL(String(url), location.href); } catch (e) { /* let the browser report it */ }
        if (!abs || abs.origin !== HERE) return new OrigWorker(url, opts);
        var code = opts && opts.type === 'module' ? 'import ' + JSON.stringify(abs.href) + ';' : 'importScripts(' + JSON.stringify(abs.href) + ');';
        return new OrigWorker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })), opts);
      };
      SandboxWorker.prototype = OrigWorker.prototype;
      window.Worker = SandboxWorker;
    }
    // - document.cookie and sessionStorage throw in an opaque origin.
    var memStore = function () {
      var m = new Map();
      return {
        getItem: function (k) { return m.has(String(k)) ? m.get(String(k)) : null; },
        setItem: function (k, v) { m.set(String(k), String(v)); },
        removeItem: function (k) { m.delete(String(k)); },
        clear: function () { m.clear(); },
        key: function (i) { return Array.from(m.keys())[i] || null; },
        get length() { return m.size; },
      };
    };
    try { void window.sessionStorage; } catch (e) {
      var ss = memStore();
      try { Object.defineProperty(window, 'sessionStorage', { configurable: true, get: function () { return ss; } }); } catch (e2) { /* ignore */ }
    }
    try { void document.cookie; } catch (e) {
      var jar = '';
      try { Object.defineProperty(document, 'cookie', { configurable: true, get: function () { return jar; }, set: function (v) { jar = String(v).split(';')[0]; } }); } catch (e2) { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Persistent key/value store (in memory, mirrored to IndexedDB)
  // ---------------------------------------------------------------------------
  var PREFIX = GAME_ID + '\u0001';
  var mem = new Map();
  var dirty = new Map(); // key -> value | DELETE
  var DELETE = {};
  var flushTimer = null;
  var persistentOk = true;

  // Saves live in the host page's IndexedDB (same database and keys as
  // before the sandbox, so existing saves carry over).
  function hostLoad() {
    return new Promise(function (resolve) {
      var done = false;
      function onMsg(e) {
        var d = e.data;
        if (e.source !== window.parent || e.origin !== HERE || !d || d.rpgm !== 1 || d.type !== 'kv-data') return;
        done = true;
        removeEventListener('message', onMsg);
        if (!d.ok) { persistentOk = false; console.warn('[rpgm-web] browser storage unavailable, saves will not persist:', d.error); }
        (d.entries || []).forEach(function (kv) { mem.set(kv[0], kv[1]); });
        resolve();
      }
      addEventListener('message', onMsg);
      postParent({ type: 'kv-load' });
      setTimeout(function () {
        if (done) return;
        removeEventListener('message', onMsg);
        persistentOk = false;
        console.warn('[rpgm-web] no answer from the host page, saves will not persist');
        resolve();
      }, 10000);
    });
  }

  // Cloud saves: when the embedding site opted in (iframe URL has cloud=1),
  // the site stores saves under its own accounts via the postMessage bridge
  // (see web/sdk.js). Then the site, not this browser, is the storage.
  var CLOUD_WANTED = params.get('cloud') === '1';
  var cloud = { active: false, timer: null, seq: 0, lastError: null };
  // Only ever to our host page (never '*': saves must not leak to a foreign
  // page that frames the game directly). The host relays cloud messages.
  function postParent(msg) {
    msg.rpgm = 1; msg.game = GAME_ID;
    try { window.parent.postMessage(msg, HERE); } catch (e) { /* detached */ }
  }
  function cloudSnapshot() {
    var entries = {};
    mem.forEach(function (v, k) { entries[k] = encodeValue(v); });
    return { format: 'rpgm-web-saves', version: 1, game: GAME_ID, title: CFG.title, engine: CFG.engine, savedAt: new Date().toISOString(), entries: entries };
  }
  // `final`: the page is being hidden or closed, the host should send it now
  // in a way that survives unload (fetch keepalive).
  function cloudPush(final) {
    cloud.timer = null;
    postParent({ type: 'save', seq: ++cloud.seq, final: !!final, data: cloudSnapshot() });
  }
  function cloudLoad() {
    return new Promise(function (resolve) {
      var done = false;
      function onMsg(e) {
        var d = e.data;
        if (e.source !== window.parent || e.origin !== HERE || !d || d.rpgm !== 1 || d.type !== 'saves' || d.game !== GAME_ID) return;
        done = true;
        removeEventListener('message', onMsg);
        resolve(d);
      }
      addEventListener('message', onMsg);
      postParent({ type: 'hello', cloud: true, title: CFG.title, engine: CFG.engine });
      setTimeout(function () { if (!done) { removeEventListener('message', onMsg); resolve({ error: 'the site did not answer' }); } }, 10000);
    });
  }

  function flush() {
    flushTimer = null;
    if (cloud.active) {
      if (!dirty.size) return;
      dirty = new Map();
      if (cloud.timer) clearTimeout(cloud.timer);
      // Short debounce: one save touches a few keys within a few ms. Sending
      // right away matters more than batching: a closing tab may never
      // deliver a later message to the host page.
      cloud.timer = setTimeout(cloudPush, 150);
      return;
    }
    if (!dirty.size) return;
    var ops = [];
    dirty.forEach(function (v, k) { ops.push(v === DELETE ? [k] : [k, v]); });
    dirty = new Map();
    postParent({ type: 'kv-write', ops: ops });
  }
  function schedule() { if (!flushTimer) flushTimer = setTimeout(flush, 0); }
  function kvGet(k) { return mem.get(k); }
  function kvHas(k) { return mem.has(k); }
  function kvSet(k, v) { mem.set(k, v); dirty.set(k, v); schedule(); }
  function kvDel(k) { if (mem.delete(k)) { dirty.set(k, DELETE); schedule(); } }
  function kvKeys(prefix) {
    var out = [];
    mem.forEach(function (_, k) { if (k.lastIndexOf(prefix, 0) === 0) out.push(k.slice(prefix.length)); });
    return out;
  }
  function flushNow() {
    flush();
    if (cloud.active && cloud.timer) { clearTimeout(cloud.timer); cloudPush(true); }
  }
  addEventListener('pagehide', flushNow);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flushNow(); });
  R.store = { get: kvGet, set: kvSet, del: kvDel, keys: kvKeys, flush: flush };


  // ---------------------------------------------------------------------------
  // Game file manifest (for fs.existsSync / readdirSync)
  // ---------------------------------------------------------------------------
  var manifest = new Map(); // lower-case path -> { path, size }
  var manifestDirs = new Map(); // lower-case dir -> Set(child names)
  function addManifest(list) {
    list.forEach(function (e) {
      var p = e[0];
      manifest.set(p.toLowerCase(), { path: p, size: e[1] });
      var parts = p.split('/');
      for (var i = 0; i < parts.length; i++) {
        var dir = parts.slice(0, i).join('/').toLowerCase();
        if (!manifestDirs.has(dir)) manifestDirs.set(dir, new Map());
        manifestDirs.get(dir).set(parts[i].toLowerCase(), parts[i]);
      }
    });
  }
  function loadManifest() {
    return fetch('__rpgm/files.json').then(function (r) { return r.json(); }).then(addManifest).catch(function (e) {
      console.warn('[rpgm-web] could not load file manifest', e);
    });
  }

  // ---------------------------------------------------------------------------
  // Asset loading progress (shown by the overlay while a burst of loads runs)
  // ---------------------------------------------------------------------------
  var BASE_PATH = location.pathname.replace(/[^/]*$/, '');
  /** Game-relative path of a URL on this server, or null. */
  function gamePath(u) {
    try {
      var x = new URL(String(u), location.href);
      if (x.origin !== HERE || x.pathname.indexOf(BASE_PATH) !== 0) return null;
      var rel = decodeURIComponent(x.pathname.slice(BASE_PATH.length));
      return rel && rel.indexOf('__rpgm/') !== 0 ? rel : null;
    } catch (e) { return null; }
  }
  // count/bytes: downloads started in this burst; queued: preload files not started yet.
  var loads = { active: 0, count: 0, done: 0, bytes: 0, loaded: 0, since: 0, onChange: null, preload: null, queued: 0, queuedBytes: 0 };
  function changed() { if (loads.onChange) loads.onChange(); }
  /** Start tracking one download; returns { progress(n), end() }. */
  function startBatch() {
    if (loads.active || loads.queued) return;
    loads.count = loads.done = loads.bytes = loads.loaded = 0; loads.since = Date.now();
  }
  var pre = null; // preload: { pending: Map(lower path -> entry), inflight: Set }
  /** Take a file off the preload queue (started by the preload, or wanted by the game). */
  function unqueue(key) {
    var e = pre.pending.get(key);
    if (!e) return false;
    pre.pending.delete(key);
    loads.queued--; loads.queuedBytes -= e.size;
    return true;
  }
  function track(u, fromPreload) {
    var rel = gamePath(u);
    if (rel === null) return null;
    var key = rel.toLowerCase();
    if (pre && !fromPreload) {
      // The game wants a file the preload is fetching or has queued: one download, counted once.
      if (pre.inflight.has(key)) return null;
      if (unqueue(key)) loads.preload.done++;
    }
    var entry = manifest.get(key);
    var size = entry ? entry.size : 0;
    startBatch();
    loads.active++; loads.count++; loads.bytes += size;
    var got = 0, ended = false;
    changed();
    return {
      progress: function (n) { if (ended || !(n > got)) return; loads.loaded += Math.min(n, size || n) - got; got = Math.min(n, size || n); },
      end: function () {
        if (ended) return;
        ended = true;
        loads.loaded += Math.max(0, size - got);
        loads.active--; loads.done++;
        changed();
      },
    };
  }
  R.loads = loads;
  (function () {
    var XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__rpgmUrl = u; return XO.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      var t = this.__rpgmUrl != null && track(this.__rpgmUrl);
      if (t) {
        this.addEventListener('progress', function (e) { t.progress(e.loaded); });
        this.addEventListener('loadend', t.end);
      }
      return XS.apply(this, arguments);
    };
    var F = window.fetch;
    loads.fetch = F;
    if (F) {
      window.fetch = function (input) {
        var t = track(input && input.url ? input.url : input);
        var p = F.apply(this, arguments);
        if (t) p.then(t.end, t.end);
        return p;
      };
    }
    var d = window.HTMLImageElement && Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (d && d.set) {
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        configurable: true, enumerable: d.enumerable, get: d.get,
        set: function (v) {
          var t = track(v);
          if (t) {
            var img = this;
            var fin = function () { img.removeEventListener('load', fin); img.removeEventListener('error', fin); t.end(); };
            img.addEventListener('load', fin); img.addEventListener('error', fin);
          }
          d.set.call(this, v);
        },
      });
    }
  })();

  /**
   * Preload (server setting, per game): download files under these folders in
   * the background, a few at a time, so the browser cache has them before the
   * game asks. Live2D games often load every model at the title screen.
   */
  function startPreload(prefixes) {
    if (!prefixes || !prefixes.length || !loads.fetch || params.get('preload') === '0') return;
    var lower = prefixes.map(function (p) { return p.toLowerCase(); });
    var queue = [];
    manifest.forEach(function (e, k) { if (lower.some(function (p) { return k.indexOf(p) === 0; })) queue.push(e); });
    if (!queue.length) return;
    var total = queue.reduce(function (a, e) { return a + e.size; }, 0);
    loads.preload = { files: queue.length, bytes: total, done: 0 };
    startBatch();
    loads.queued = queue.length; loads.queuedBytes = total;
    log('preloading', queue.length, 'files', total);
    pre = { pending: new Map(queue.map(function (e) { return [e.path.toLowerCase(), e]; })), inflight: new Set() };
    var url = function (p) { return BASE_PATH + p.split('/').map(encodeURIComponent).join('/'); };
    var worker = function () {
      var e;
      while ((e = queue.shift()) && !pre.pending.has(e.path.toLowerCase())) { /* the game took it */ }
      if (!e) return Promise.resolve();
      var key = e.path.toLowerCase();
      unqueue(key); pre.inflight.add(key);
      var t = track(url(e.path), true);
      return loads.fetch.call(window, url(e.path), { priority: 'low' }).then(function (r) {
        if (!r.body || !r.body.getReader) return r.arrayBuffer();
        var rd = r.body.getReader(), n = 0;
        var pump = function () { return rd.read().then(function (c) { if (c.done) return; n += c.value.length; if (t) t.progress(n); return pump(); }); };
        return pump();
      }).catch(function () { /* the game will ask again */ }).then(function () {
        pre.inflight.delete(key);
        if (t) t.end();
        loads.preload.done++;
        return worker();
      });
    };
    for (var i = 0; i < 3; i++) worker();
  }

  // ---------------------------------------------------------------------------
  // Buffer-ish helper (returned by fs reads; not installed globally)
  // ---------------------------------------------------------------------------
  var te = new TextEncoder();
  var td = new TextDecoder();
  function b64encode(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64decode(str) {
    var bin = atob(str);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function toBytes(data, enc) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    var s = String(data);
    enc = (enc || 'utf8').toLowerCase();
    if (enc === 'base64') return b64decode(s);
    if (enc === 'latin1' || enc === 'binary') { var o = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) o[i] = s.charCodeAt(i) & 255; return o; }
    if (enc === 'hex') { var h = new Uint8Array(s.length >> 1); for (var j = 0; j < h.length; j++) h[j] = parseInt(s.substr(j * 2, 2), 16); return h; }
    return te.encode(s);
  }
  function bytesToString(bytes, enc) {
    enc = (enc || 'utf8').toLowerCase();
    if (enc === 'base64') return b64encode(bytes);
    if (enc === 'latin1' || enc === 'binary') { var s = ''; for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return s; }
    if (enc === 'hex') { var h = ''; for (var j = 0; j < bytes.length; j++) h += (bytes[j] < 16 ? '0' : '') + bytes[j].toString(16); return h; }
    return td.decode(bytes);
  }
  function FakeBuffer(bytes) {
    var b = new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength !== undefined ? bytes.byteLength : bytes.length);
    Object.setPrototypeOf(b, FakeBuffer.prototype);
    return b;
  }
  FakeBuffer.prototype = Object.create(Uint8Array.prototype);
  FakeBuffer.prototype.constructor = FakeBuffer;
  FakeBuffer.prototype.toString = function (enc) { return bytesToString(this, enc); };
  FakeBuffer.prototype.toJSON = function () { return { type: 'Buffer', data: Array.from(this) }; };
  FakeBuffer.from = function (d, enc) { return FakeBuffer(toBytes(d, enc)); };
  FakeBuffer.alloc = function (n) { return FakeBuffer(new Uint8Array(n)); };
  FakeBuffer.isBuffer = function (b) { return b instanceof FakeBuffer; };
  FakeBuffer.byteLength = function (d, enc) { return toBytes(d, enc).length; };
  FakeBuffer.concat = function (list) {
    var n = list.reduce(function (s, b) { return s + b.length; }, 0);
    var out = new Uint8Array(n), o = 0;
    list.forEach(function (b) { out.set(b, o); o += b.length; });
    return FakeBuffer(out);
  };

  // ---------------------------------------------------------------------------
  // path (posix flavour; backslashes accepted everywhere)
  // ---------------------------------------------------------------------------
  function normalizeSlashes(p) { return String(p).replace(/\\/g, '/'); }
  function normalizePath(p) {
    p = normalizeSlashes(p);
    var abs = p.charAt(0) === '/';
    var out = [];
    p.split('/').forEach(function (seg) {
      if (!seg || seg === '.') return;
      if (seg === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); return; }
      out.push(seg);
    });
    var r = (abs ? '/' : '') + out.join('/');
    return r || (abs ? '/' : '.');
  }
  var GAME_ROOT = '/game';
  var pathMod = {
    sep: '/', delimiter: ':',
    normalize: function (p) { var n = normalizePath(p); return /[\\/]$/.test(p) && n !== '/' ? n + '/' : n; },
    join: function () { var a = [].slice.call(arguments).filter(function (s) { return s !== ''; }); return a.length ? pathMod.normalize(a.join('/')) : '.'; },
    resolve: function () {
      var r = '';
      for (var i = arguments.length - 1; i >= 0 && r.charAt(0) !== '/'; i--) {
        var s = normalizeSlashes(arguments[i]);
        if (/^[a-zA-Z]:\//.test(s)) s = '/' + s;
        r = s + (r ? '/' + r : '');
      }
      if (r.charAt(0) !== '/') r = GAME_ROOT + '/' + r;
      return normalizePath(r);
    },
    dirname: function (p) { p = normalizeSlashes(p).replace(/\/+$/, ''); var i = p.lastIndexOf('/'); return i < 0 ? '.' : i === 0 ? '/' : p.slice(0, i); },
    basename: function (p, ext) { var b = normalizeSlashes(p).replace(/\/+$/, ''); b = b.slice(b.lastIndexOf('/') + 1); if (ext && b.slice(-ext.length) === ext) b = b.slice(0, -ext.length); return b; },
    extname: function (p) { var b = pathMod.basename(p); var i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i); },
    isAbsolute: function (p) { return /^([\\/]|[a-zA-Z]:[\\/])/.test(String(p)); },
    relative: function (from, to) {
      var f = pathMod.resolve(from).split('/').filter(Boolean), t = pathMod.resolve(to).split('/').filter(Boolean);
      while (f.length && t.length && f[0] === t[0]) { f.shift(); t.shift(); }
      return f.map(function () { return '..'; }).concat(t).join('/');
    },
    parse: function (p) { var base = pathMod.basename(p), ext = pathMod.extname(p); return { root: pathMod.isAbsolute(p) ? '/' : '', dir: pathMod.dirname(p), base: base, ext: ext, name: ext ? base.slice(0, -ext.length) : base }; },
    format: function (o) { return (o.dir ? o.dir + '/' : '') + (o.base || (o.name || '') + (o.ext || '')); },
  };
  pathMod.posix = pathMod;
  pathMod.win32 = pathMod;

  // ---------------------------------------------------------------------------
  // fs: game files are read-only (sync XHR, manifest), writes go to the store
  // ---------------------------------------------------------------------------
  function fsKey(abs) { return 'fs:' + abs.toLowerCase(); }
  function dirKey(abs) { return 'fsd:' + abs.toLowerCase(); }
  function tombKey(abs) { return 'fsx:' + abs.toLowerCase(); }
  // Old MV builds derive the save folder from location.pathname; map the
  // page's (revisioned) URL directory onto the stable virtual game root.
  var PAGE_DIR = decodeURIComponent(location.pathname.replace(/[^/]*$/, '')).toLowerCase();
  function absPath(p) {
    if (p instanceof URL) p = decodeURIComponent(p.pathname);
    var a = pathMod.resolve(String(p));
    var l = a.toLowerCase();
    if (PAGE_DIR.length > 1 && (l + '/').lastIndexOf(PAGE_DIR, 0) === 0) a = GAME_ROOT + '/' + a.slice(PAGE_DIR.length);
    return normalizePath(a);
  }
  function gameRel(abs) {
    var l = abs.toLowerCase();
    if (l === GAME_ROOT) return '';
    if (l.lastIndexOf(GAME_ROOT + '/', 0) === 0) return abs.slice(GAME_ROOT.length + 1);
    return null;
  }
  function fsError(code, syscall, p) {
    var msgs = { ENOENT: 'no such file or directory', EISDIR: 'illegal operation on a directory', ENOTDIR: 'not a directory', EEXIST: 'file already exists', ENOTEMPTY: 'directory not empty' };
    var e = new Error(code + ': ' + (msgs[code] || 'error') + ', ' + syscall + " '" + p + "'");
    e.code = code; e.errno = -2; e.syscall = syscall; e.path = String(p);
    return e;
  }
  function gameFile(abs) {
    var rel = gameRel(abs);
    if (rel === null || kvHas(tombKey(abs))) return null;
    return manifest.get(rel.toLowerCase()) || null;
  }
  function isDir(abs) {
    if (kvHas(dirKey(abs))) return true;
    var rel = gameRel(abs);
    if (rel !== null && manifestDirs.has(rel.toLowerCase())) return true;
    var prefix = 'fs:' + abs.toLowerCase().replace(/\/$/, '') + '/';
    var found = false;
    mem.forEach(function (_, k) { if (!found && k.lastIndexOf(prefix, 0) === 0) found = true; });
    if (found) return true;
    return abs === '/' || abs.toLowerCase() === GAME_ROOT;
  }
  function stored(abs) {
    var v = kvGet(fsKey(abs));
    return v === undefined ? null : v;
  }
  function readGameBytes(entry) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', entry.path.split('/').map(encodeURIComponent).join('/'), false);
    xhr.overrideMimeType('text/plain; charset=x-user-defined');
    xhr.send();
    if (xhr.status >= 400) throw fsError('ENOENT', 'open', entry.path);
    var t = xhr.responseText, out = new Uint8Array(t.length);
    for (var i = 0; i < t.length; i++) out[i] = t.charCodeAt(i) & 255;
    return out;
  }
  function encOf(opts) { return typeof opts === 'string' ? opts : opts && opts.encoding; }
  function makeStat(abs, kind, size, mtime) {
    var d = new Date(mtime || 0);
    return {
      dev: 1, ino: 0, mode: kind === 'dir' ? 16877 : 33188, nlink: 1, uid: 0, gid: 0, rdev: 0,
      size: size || 0, blksize: 4096, blocks: Math.ceil((size || 0) / 512),
      atimeMs: +d, mtimeMs: +d, ctimeMs: +d, birthtimeMs: +d, atime: d, mtime: d, ctime: d, birthtime: d,
      isFile: function () { return kind === 'file'; }, isDirectory: function () { return kind === 'dir'; },
      isSymbolicLink: function () { return false; }, isFIFO: function () { return false; }, isSocket: function () { return false; },
      isBlockDevice: function () { return false; }, isCharacterDevice: function () { return false; },
    };
  }
  function ensureParent(abs) {
    var dir = pathMod.dirname(abs);
    if (!isDir(dir)) kvSet(dirKey(dir), 1); // be lenient: games often skip mkdir
  }

  var fsMod = {
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
    F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
    existsSync: function (p) { try { var a = absPath(p); return stored(a) !== null || !!gameFile(a) || isDir(a); } catch (e) { return false; } },
    accessSync: function (p) { if (!fsMod.existsSync(p)) throw fsError('ENOENT', 'access', p); },
    statSync: function (p, opts) {
      var a = absPath(p), s = stored(a);
      if (s !== null) return makeStat(a, 'file', s.data ? s.data.length : 0, s.mtime);
      var g = gameFile(a);
      if (g) return makeStat(a, 'file', g.size, 0);
      if (isDir(a)) return makeStat(a, 'dir', 0, 0);
      if (opts && opts.throwIfNoEntry === false) return undefined;
      throw fsError('ENOENT', 'stat', p);
    },
    readFileSync: function (p, opts) {
      if (typeof p === 'number') throw fsError('EBADF', 'read', p);
      var a = absPath(p), enc = encOf(opts), s = stored(a), bytes;
      if (s !== null) bytes = s.data;
      else {
        var g = gameFile(a);
        if (!g) { if (isDir(a)) throw fsError('EISDIR', 'read', p); throw fsError('ENOENT', 'open', p); }
        bytes = readGameBytes(g);
      }
      return enc ? bytesToString(bytes, enc) : FakeBuffer(bytes);
    },
    writeFileSync: function (p, data, opts) {
      var a = absPath(p);
      if (isDir(a) && stored(a) === null && !gameFile(a)) throw fsError('EISDIR', 'open', p);
      ensureParent(a);
      var flag = opts && typeof opts === 'object' && opts.flag;
      var bytes = toBytes(data, encOf(opts));
      if (flag && flag.charAt(0) === 'a') {
        var prev = fsMod.existsSync(a) ? fsMod.readFileSync(a) : new Uint8Array(0);
        var merged = new Uint8Array(prev.length + bytes.length);
        merged.set(prev, 0); merged.set(bytes, prev.length); bytes = merged;
      }
      kvDel(tombKey(a));
      kvSet(fsKey(a), { path: a, data: bytes, mtime: Date.now() });
    },
    appendFileSync: function (p, data, opts) { fsMod.writeFileSync(p, data, Object.assign({}, typeof opts === 'string' ? { encoding: opts } : opts, { flag: 'a' })); },
    copyFileSync: function (src, dst) { fsMod.writeFileSync(dst, fsMod.readFileSync(src)); },
    unlinkSync: function (p) {
      var a = absPath(p);
      if (stored(a) === null && !gameFile(a)) throw fsError('ENOENT', 'unlink', p);
      kvDel(fsKey(a));
      if (gameFile(a)) kvSet(tombKey(a), 1);
    },
    renameSync: function (from, to) {
      var data = fsMod.readFileSync(from);
      fsMod.writeFileSync(to, data);
      fsMod.unlinkSync(from);
    },
    mkdirSync: function (p, opts) {
      var a = absPath(p);
      if (isDir(a)) { if (opts && opts.recursive) return undefined; throw fsError('EEXIST', 'mkdir', p); }
      kvSet(dirKey(a), 1);
      return opts && opts.recursive ? a : undefined;
    },
    readdirSync: function (p, opts) {
      var a = absPath(p);
      if (!isDir(a)) throw fsError(fsMod.existsSync(a) ? 'ENOTDIR' : 'ENOENT', 'scandir', p);
      var names = new Map(), lowerA = a.toLowerCase().replace(/\/$/, '');
      var rel = gameRel(a);
      if (rel !== null) {
        var kids = manifestDirs.get(rel.toLowerCase());
        if (kids) kids.forEach(function (name, l) {
          var childAbs = (a.replace(/\/$/, '') + '/' + name);
          if (!kvHas(tombKey(childAbs))) names.set(l, name);
        });
      }
      mem.forEach(function (v, k) {
        var prefix = k.lastIndexOf('fs:', 0) === 0 ? 'fs:' : k.lastIndexOf('fsd:', 0) === 0 ? 'fsd:' : null;
        if (!prefix) return;
        var rest = k.slice(prefix.length);
        if (rest.lastIndexOf(lowerA + '/', 0) !== 0) return;
        var tail = rest.slice(lowerA.length + 1);
        var first = tail.split('/')[0];
        if (!first) return;
        var original = prefix === 'fs:' && v && v.path ? v.path.slice(a.replace(/\/$/, '').length + 1).split('/')[0] : first;
        if (!names.has(first)) names.set(first, original);
      });
      var list = Array.from(names.values()).sort();
      if (opts && opts.withFileTypes) {
        return list.map(function (n) {
          var child = a.replace(/\/$/, '') + '/' + n, d = isDir(child) && stored(child) === null && !gameFile(child);
          return { name: n, isFile: function () { return !d; }, isDirectory: function () { return d; }, isSymbolicLink: function () { return false; } };
        });
      }
      return list;
    },
    rmdirSync: function (p) { kvDel(dirKey(absPath(p))); },
    rmSync: function (p, opts) {
      var a = absPath(p);
      if (stored(a) !== null || gameFile(a)) return fsMod.unlinkSync(a);
      if (isDir(a)) {
        if (opts && opts.recursive) fsMod.readdirSync(a).forEach(function (n) { fsMod.rmSync(a + '/' + n, opts); });
        kvDel(dirKey(a));
        return undefined;
      }
      if (!(opts && opts.force)) throw fsError('ENOENT', 'rm', p);
      return undefined;
    },
    realpathSync: function (p) { return absPath(p); },
    openSync: function () { throw fsError('ENOSYS', 'open', ''); },
    watch: function () { return { close: function () {}, on: function () { return this; } }; },
    watchFile: function () {}, unwatchFile: function () {},
    createWriteStream: function (p) {
      var chunks = [];
      return { write: function (c) { chunks.push(toBytes(c)); return true; }, end: function (c) { if (c) chunks.push(toBytes(c)); fsMod.writeFileSync(p, FakeBuffer.concat(chunks)); }, on: function () { return this; }, once: function () { return this; } };
    },
  };
  fsMod.lstatSync = fsMod.statSync;
  fsMod.rmdirSync = function (p, opts) { return fsMod.rmSync(p, Object.assign({ force: true }, opts)); };
  fsMod.realpathSync.native = fsMod.realpathSync;
  // callback + promise flavours
  ['access', 'stat', 'lstat', 'readFile', 'writeFile', 'appendFile', 'copyFile', 'unlink', 'rename', 'mkdir', 'readdir', 'rmdir', 'rm', 'realpath'].forEach(function (name) {
    var sync = fsMod[name + 'Sync'];
    fsMod[name] = function () {
      var args = [].slice.call(arguments), cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      setTimeout(function () {
        var res, err = null;
        try { res = sync.apply(fsMod, args); } catch (e) { err = e; }
        if (cb) cb(err, res);
      }, 0);
    };
  });
  fsMod.exists = function (p, cb) { var r = fsMod.existsSync(p); setTimeout(function () { cb && cb(r); }, 0); };
  fsMod.promises = {};
  ['access', 'stat', 'lstat', 'readFile', 'writeFile', 'appendFile', 'copyFile', 'unlink', 'rename', 'mkdir', 'readdir', 'rmdir', 'rm', 'realpath'].forEach(function (name) {
    fsMod.promises[name] = function () {
      var args = arguments;
      return new Promise(function (resolve, reject) {
        setTimeout(function () { try { resolve(fsMod[name + 'Sync'].apply(fsMod, args)); } catch (e) { reject(e); } }, 0);
      });
    };
  });

  // ---------------------------------------------------------------------------
  // Fullscreen / window helpers shared by the nw shim and the overlay
  // ---------------------------------------------------------------------------
  // Desktop builds may enter fullscreen at boot. Browsers only allow it after
  // a user gesture: Firefox rejects with a TypeError, and MZ turns any
  // unhandled rejection into a fatal error screen. Never let the request
  // fail; if it is refused, retry once on the next click or key press.
  var origRequestFs = {};
  var pendingFs = null;
  function retryFsOnGesture(el, name) {
    if (pendingFs) { pendingFs.el = el; pendingFs.name = name; return; }
    pendingFs = { el: el, name: name };
    var fire = function () {
      var p = pendingFs;
      pendingFs = null;
      ['pointerup', 'keyup', 'touchend'].forEach(function (t) { document.removeEventListener(t, fire, true); });
      if (!p || document.fullscreenElement || document.webkitFullscreenElement) return;
      try { var r = origRequestFs[p.name].call(p.el); if (r && r.catch) r.catch(function () {}); } catch (e) { /* still refused */ }
    };
    ['pointerup', 'keyup', 'touchend'].forEach(function (t) { document.addEventListener(t, fire, true); });
  }
  ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen', 'mozRequestFullScreen', 'msRequestFullscreen'].forEach(function (name) {
    var orig = Element.prototype[name];
    if (typeof orig !== 'function') return;
    origRequestFs[name] = orig;
    Element.prototype[name] = function () {
      var el = this, args = arguments, r;
      try { r = orig.apply(el, args); } catch (e) { retryFsOnGesture(el, name); return Promise.resolve(); }
      if (r && typeof r.then === 'function') {
        return r.catch(function () { retryFsOnGesture(el, name); });
      }
      return r;
    };
  });
  ['exitFullscreen', 'webkitExitFullscreen', 'mozCancelFullScreen'].forEach(function (name) {
    var orig = Document.prototype[name];
    if (typeof orig !== 'function') return;
    Document.prototype[name] = function () {
      var r;
      try { r = orig.apply(this, arguments); } catch (e) { return Promise.resolve(); }
      return r && typeof r.catch === 'function' ? r.catch(function () {}) : r;
    };
  });
  // Autoplay policy: play() before any user gesture rejects with
  // NotAllowedError, which MZ would also treat as fatal. Resume on gesture.
  if (window.HTMLMediaElement && HTMLMediaElement.prototype.play) {
    var origPlay = HTMLMediaElement.prototype.play;
    var blockedMedia = new Set();
    var resumeMedia = function () {
      var list = Array.from(blockedMedia);
      blockedMedia.clear();
      list.forEach(function (m) { if (m.paused && m.isConnected) { var r = origPlay.call(m); if (r && r.catch) r.catch(function () {}); } });
    };
    ['pointerup', 'keyup', 'touchend'].forEach(function (t) { document.addEventListener(t, resumeMedia, true); });
    HTMLMediaElement.prototype.play = function () {
      var m = this, r = origPlay.apply(m, arguments);
      if (!r || typeof r.then !== 'function') return r;
      return r.catch(function (e) {
        if (e && e.name === 'NotAllowedError') { blockedMedia.add(m); return undefined; }
        throw e;
      });
    };
  }
  function isFullscreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
  function enterFullscreen() {
    var el = document.documentElement;
    var fn = el.requestFullscreen || el.webkitRequestFullscreen;
    if (fn) { try { var p = fn.call(el, { navigationUI: 'hide' }); if (p && p.catch) p.catch(function () {}); } catch (e) { /* ignore */ } }
    try { screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape').catch(function () {}); } catch (e) { /* ignore */ }
  }
  function exitFullscreen() {
    var fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (fn && isFullscreen()) { try { var p = fn.call(document); if (p && p.catch) p.catch(function () {}); } catch (e) { /* ignore */ } }
  }
  function toggleFullscreen() { if (isFullscreen()) exitFullscreen(); else enterFullscreen(); }
  // Embedded on another site (iframe from /embed/<id>/): leaving the game
  // returns to the embed's cover screen instead of the library.
  var EMBED = params.get('embed') === '1';
  var ROOT = CFG.library || '/';
  function backToLibrary() {
    flushNow();
    if (EMBED) postParent({ type: 'exit' });
    // The sandbox cannot navigate the tab; the host page does it.
    postParent({ type: 'nav', to: EMBED ? 'embed' : 'library' });
  }
  function openInNewTab() {
    flushNow();
    try { window.open(ROOT + 'play/' + encodeURIComponent(GAME_ID) + '/', '_blank', 'noopener'); } catch (e) { /* blocked */ }
  }

  // ---------------------------------------------------------------------------
  // nw.gui / nw shim
  // ---------------------------------------------------------------------------
  function Emitter() { this._l = {}; }
  Emitter.prototype.on = Emitter.prototype.addListener = function (t, f) { (this._l[t] = this._l[t] || []).push(f); return this; };
  Emitter.prototype.once = function (t, f) { var s = this; function w() { s.off(t, w); f.apply(s, arguments); } return this.on(t, w); };
  Emitter.prototype.off = Emitter.prototype.removeListener = function (t, f) { this._l[t] = (this._l[t] || []).filter(function (x) { return x !== f; }); return this; };
  Emitter.prototype.removeAllListeners = function (t) { if (t) delete this._l[t]; else this._l = {}; return this; };
  Emitter.prototype.emit = function (t) { var a = [].slice.call(arguments, 1), s = this; (this._l[t] || []).slice().forEach(function (f) { f.apply(s, a); }); return true; };
  Emitter.prototype.listeners = function (t) { return (this._l[t] || []).slice(); };
  Emitter.prototype.setMaxListeners = function () { return this; };

  var nwWin = new Emitter();
  Object.defineProperties(nwWin, {
    x: { get: function () { return window.screenX; }, set: function () {} },
    y: { get: function () { return window.screenY; }, set: function () {} },
    width: { get: function () { return window.innerWidth; }, set: function () {} },
    height: { get: function () { return window.innerHeight; }, set: function () {} },
    title: { get: function () { return document.title; }, set: function (v) { document.title = v; } },
    isFullscreen: { get: isFullscreen },
    isKioskMode: { get: isFullscreen },
    zoomLevel: { value: 0, writable: true },
    menu: { value: null, writable: true },
    window: { get: function () { return window; } },
  });
  ['focus', 'blur', 'show', 'hide', 'minimize', 'maximize', 'unmaximize', 'restore', 'moveTo', 'moveBy', 'resizeTo', 'resizeBy',
    'setResizable', 'setAlwaysOnTop', 'setVisibleOnAllWorkspaces', 'setMinimumSize', 'setMaximumSize', 'setPosition', 'setShowInTaskbar',
    'requestAttention', 'setProgressBar', 'setBadgeLabel', 'showDevTools', 'closeDevTools', 'reloadIgnoringCache', 'capturePage', 'setShadow',
    'setTransparent', 'cookies', 'eval', 'evalNWBin'].forEach(function (m) { nwWin[m] = function () { return nwWin; }; });
  nwWin.isDevToolsOpen = function () { return false; };
  nwWin.enterFullscreen = enterFullscreen;
  nwWin.leaveFullscreen = exitFullscreen;
  nwWin.toggleFullscreen = toggleFullscreen;
  nwWin.enterKioskMode = enterFullscreen;
  nwWin.leaveKioskMode = exitFullscreen;
  nwWin.toggleKioskMode = toggleFullscreen;
  nwWin.reload = function () { flush(); location.reload(); };
  nwWin.reloadDev = nwWin.reload;
  nwWin.close = function (force) {
    if (!force && nwWin.listeners('close').length) { nwWin.emit('close'); return; }
    backToLibrary();
  };
  nwWin.get = function () { return nwWin; };

  function NwMenu() { this.items = []; }
  NwMenu.prototype.append = function (i) { this.items.push(i); };
  NwMenu.prototype.insert = function (i, at) { this.items.splice(at, 0, i); };
  NwMenu.prototype.remove = function (i) { this.items = this.items.filter(function (x) { return x !== i; }); };
  NwMenu.prototype.removeAt = function (at) { this.items.splice(at, 1); };
  NwMenu.prototype.popup = function () {};
  NwMenu.prototype.createMacBuiltin = function () {};
  function NwMenuItem(o) { Object.assign(this, o || {}); }

  var clipboardText = '';
  var nwApp = new Emitter();
  Object.assign(nwApp, {
    argv: [], fullArgv: [], filteredArgv: [], dataPath: '/userdata', startPath: GAME_ROOT,
    manifest: { name: CFG.title || GAME_ID, main: 'index.html', window: {} },
    quit: function () { backToLibrary(); }, closeAllWindows: function () { backToLibrary(); },
    clearCache: function () {}, clearAppCache: function () {}, setProxyConfig: function () {},
    registerGlobalHotKey: function () {}, unregisterGlobalHotKey: function () {}, crashBrowser: function () {}, crashRenderer: function () {},
    getProxyForURL: function () { return 'DIRECT'; }, addOriginAccessWhitelistEntry: function () {}, removeOriginAccessWhitelistEntry: function () {},
  });
  var nwShim = {
    Window: nwWin, App: nwApp, Menu: NwMenu, MenuItem: NwMenuItem,
    Shell: {
      openExternal: function (url) { try { window.open(String(url), '_blank', 'noopener'); } catch (e) { /* popup blocked */ } },
      openItem: function () {}, showItemInFolder: function () {}, moveItemToTrash: function () { return false; },
    },
    Clipboard: { get: function () { return { get: function () { return clipboardText; }, set: function (t) { clipboardText = String(t); try { navigator.clipboard.writeText(clipboardText); } catch (e) { /* ignore */ } }, clear: function () { clipboardText = ''; } }; } },
    Screen: { Init: function () {}, screens: [], on: function () {} },
    Shortcut: function () {},
    Tray: function () { this.remove = function () {}; this.on = function () {}; },
    process: null,
    require: function (m) { return shimRequire(m); },
  };

  // ---------------------------------------------------------------------------
  // process + require
  // ---------------------------------------------------------------------------
  var startTime = performance.now();
  var processShim = new Emitter();
  Object.assign(processShim, {
    title: 'browser', browser: true, platform: 'win32', arch: 'x64', pid: 1, ppid: 0,
    version: '', versions: {}, release: { name: 'browser' }, // no versions.node: emscripten must stay in web mode
    argv: [GAME_ROOT + '/Game.exe'], execArgv: [], execPath: GAME_ROOT + '/Game.exe',
    env: {
      NODE_ENV: 'production', USERNAME: 'player', USER: 'player', HOME: 'C:\\Users\\player', USERPROFILE: 'C:\\Users\\player',
      APPDATA: 'C:\\Users\\player\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\player\\AppData\\Local', TEMP: 'C:\\Users\\player\\AppData\\Local\\Temp', TMP: 'C:\\Users\\player\\AppData\\Local\\Temp',
    },
    mainModule: { filename: GAME_ROOT + '/index.html', exports: {}, paths: [] },
    cwd: function () { return GAME_ROOT; }, chdir: function () {}, umask: function () { return 18; },
    exit: function () { backToLibrary(); }, abort: function () { backToLibrary(); }, kill: function () {},
    nextTick: function (fn) { var a = [].slice.call(arguments, 1); queueMicrotask(function () { fn.apply(null, a); }); },
    hrtime: function (prev) {
      var t = performance.now() - startTime, s = Math.floor(t / 1000), ns = Math.floor((t % 1000) * 1e6);
      if (prev) { s -= prev[0]; ns -= prev[1]; if (ns < 0) { s--; ns += 1e9; } }
      return [s, ns];
    },
    uptime: function () { return (performance.now() - startTime) / 1000; },
    memoryUsage: function () { var m = performance.memory || {}; return { rss: m.totalJSHeapSize || 0, heapTotal: m.totalJSHeapSize || 0, heapUsed: m.usedJSHeapSize || 0, external: 0, arrayBuffers: 0 }; },
    cpuUsage: function () { return { user: 0, system: 0 }; },
    stdout: { write: function (s) { console.log(String(s).replace(/\n$/, '')); return true; }, isTTY: false },
    stderr: { write: function (s) { console.warn(String(s).replace(/\n$/, '')); return true; }, isTTY: false },
    binding: function () { throw new Error('process.binding is not available in the browser'); },
  });
  processShim.hrtime.bigint = function () { return BigInt(Math.floor((performance.now() - startTime) * 1e6)); };
  nwShim.process = processShim;

  var osMod = {
    platform: function () { return 'win32'; }, type: function () { return 'Windows_NT'; }, arch: function () { return 'x64'; }, release: function () { return '10.0.19045'; },
    homedir: function () { return processShim.env.USERPROFILE; }, tmpdir: function () { return processShim.env.TEMP; }, hostname: function () { return 'browser'; },
    userInfo: function () { return { username: 'player', homedir: processShim.env.USERPROFILE, shell: null, uid: -1, gid: -1 }; },
    cpus: function () { var n = navigator.hardwareConcurrency || 4, out = []; for (var i = 0; i < n; i++) out.push({ model: 'cpu', speed: 0, times: {} }); return out; },
    totalmem: function () { return (navigator.deviceMemory || 4) * 1073741824; }, freemem: function () { return (navigator.deviceMemory || 4) * 536870912; },
    networkInterfaces: function () { return {}; }, uptime: function () { return processShim.uptime(); }, loadavg: function () { return [0, 0, 0]; },
    EOL: '\r\n', endianness: function () { return 'LE'; },
  };
  var utilMod = {
    inherits: function (ctor, sup) { ctor.super_ = sup; ctor.prototype = Object.create(sup.prototype, { constructor: { value: ctor, writable: true, configurable: true } }); },
    format: function (f) { var a = [].slice.call(arguments, 1); return String(f).replace(/%[sdifjoO%]/g, function (m) { if (m === '%%') return '%'; var v = a.shift(); return m === '%j' || m === '%o' || m === '%O' ? JSON.stringify(v) : String(v); }) + (a.length ? ' ' + a.join(' ') : ''); },
    promisify: function (fn) { return function () { var a = [].slice.call(arguments), s = this; return new Promise(function (res, rej) { fn.apply(s, a.concat(function (e, v) { if (e) rej(e); else res(v); })); }); }; },
    inspect: function (v) { try { return JSON.stringify(v); } catch (e) { return String(v); } },
    isArray: Array.isArray, deprecate: function (fn) { return fn; }, TextEncoder: TextEncoder, TextDecoder: TextDecoder,
    types: { isPromise: function (p) { return p instanceof Promise; } },
  };
  function notAvailable(name) {
    return function () { var e = new Error(name + ' is not available in the browser'); e.code = 'ENOSYS'; throw e; };
  }
  var childProcessMod = {
    exec: function (cmd, opts, cb) { cb = typeof opts === 'function' ? opts : cb; var e = new Error('child_process is not available in the browser'); setTimeout(function () { cb && cb(e, '', ''); }, 0); return new Emitter(); },
    execSync: notAvailable('child_process.execSync'), spawn: function () { var p = new Emitter(); setTimeout(function () { p.emit('error', new Error('child_process is not available in the browser')); }, 0); p.stdout = new Emitter(); p.stderr = new Emitter(); p.kill = function () {}; return p; },
    spawnSync: function () { return { status: 1, error: new Error('child_process is not available in the browser'), stdout: '', stderr: '' }; },
    execFile: function (f, a, o, cb) { cb = [a, o, cb].filter(function (x) { return typeof x === 'function'; })[0]; setTimeout(function () { cb && cb(new Error('child_process is not available in the browser')); }, 0); return new Emitter(); },
    fork: notAvailable('child_process.fork'),
  };
  var urlMod = {
    URL: URL, URLSearchParams: URLSearchParams,
    parse: function (u) { try { var x = new URL(u, location.href); return { href: x.href, protocol: x.protocol, host: x.host, hostname: x.hostname, port: x.port, pathname: x.pathname, search: x.search, query: x.search.slice(1), hash: x.hash }; } catch (e) { return { href: u, pathname: u }; } },
    format: function (o) { return typeof o === 'string' ? o : o.href || ''; },
    fileURLToPath: function (u) { return decodeURIComponent(new URL(u).pathname); },
    pathToFileURL: function (p) { return new URL('file://' + absPath(p)); },
  };
  var MODULES = {
    fs: fsMod, 'fs/promises': fsMod.promises, 'graceful-fs': fsMod, path: pathMod, os: osMod, util: utilMod, url: urlMod,
    events: Object.assign(Emitter, { EventEmitter: Emitter, default: Emitter }),
    'nw.gui': nwShim, child_process: childProcessMod,
    buffer: { Buffer: FakeBuffer }, process: processShim,
    assert: Object.assign(function (v, m) { if (!v) throw new Error(m || 'assertion failed'); }, { ok: function (v, m) { if (!v) throw new Error(m || 'assertion failed'); } }),
    timers: { setTimeout: setTimeout.bind(window), clearTimeout: clearTimeout.bind(window), setInterval: setInterval.bind(window), clearInterval: clearInterval.bind(window), setImmediate: function (f) { return setTimeout(f, 0); } },
  };
  function shimRequire(name) {
    name = String(name).replace(/^node:/, '');
    if (Object.prototype.hasOwnProperty.call(MODULES, name)) return MODULES[name];
    var e = new Error("Cannot find module '" + name + "' (not available in the browser)");
    e.code = 'MODULE_NOT_FOUND';
    log('require failed:', name);
    throw e;
  }
  shimRequire.resolve = function (n) { return n; };
  shimRequire.cache = {};
  shimRequire.main = processShim.mainModule;
  R.require = shimRequire;

  var DEFINE = function (name, value) {
    try { Object.defineProperty(window, name, { value: value, writable: true, configurable: true }); } catch (e) { window[name] = value; }
  };
  if (typeof window.require !== 'function') DEFINE('require', shimRequire);
  if (typeof window.process !== 'object') DEFINE('process', processShim);
  if (typeof window.nw !== 'object') DEFINE('nw', nwShim);

  // ---------------------------------------------------------------------------
  // localStorage (per-game namespace in the store; no 5 MB quota)
  // ---------------------------------------------------------------------------
  var LS = 'ls:';
  var lsTarget = {
    getItem: function (k) { var v = kvGet(LS + k); return v === undefined ? null : String(v); },
    setItem: function (k, v) { kvSet(LS + k, String(v)); },
    removeItem: function (k) { kvDel(LS + k); },
    clear: function () { kvKeys(LS).forEach(function (k) { kvDel(LS + k); }); },
    key: function (i) { var k = kvKeys(LS); return i < k.length ? k[i] : null; },
  };
  var lsProxy = new Proxy(lsTarget, {
    get: function (t, p) {
      if (p === 'length') return kvKeys(LS).length;
      if (typeof p === 'symbol' || Object.prototype.hasOwnProperty.call(t, p)) return t[p];
      return t.getItem(p);
    },
    set: function (t, p, v) { if (typeof p === 'string') t.setItem(p, v); return true; },
    has: function (t, p) { return Object.prototype.hasOwnProperty.call(t, p) || kvHas(LS + String(p)); },
    deleteProperty: function (t, p) { t.removeItem(p); return true; },
    ownKeys: function () { return kvKeys(LS); },
    getOwnPropertyDescriptor: function (t, p) { var v = kvGet(LS + String(p)); return v === undefined ? undefined : { value: String(v), enumerable: true, configurable: true, writable: true }; },
  });
  try {
    Object.defineProperty(window, 'localStorage', { configurable: true, enumerable: true, get: function () { return lsProxy; } });
  } catch (e) {
    console.warn('[rpgm-web] could not redirect localStorage', e);
  }

  // ---------------------------------------------------------------------------
  // localforage (MZ saves) → same store
  // ---------------------------------------------------------------------------
  var LF = 'lf:';
  var realLocalforage = null;
  function lfp(fn) { return function () { var a = arguments; return new Promise(function (res, rej) { try { res(fn.apply(null, a)); } catch (e) { rej(e); } }); }; }
  function withCb(p, cb) { if (typeof cb === 'function') p.then(function (v) { cb(null, v); }, function (e) { cb(e); }); return p; }
  var lfShim = {
    INDEXEDDB: 'asyncStorage', WEBSQL: 'webSQLStorage', LOCALSTORAGE: 'localStorageWrapper',
    getItem: function (k, cb) { return withCb(lfp(function () { var v = kvGet(LF + k); return v === undefined ? null : v; })(), cb); },
    setItem: function (k, v, cb) { return withCb(lfp(function () { kvSet(LF + k, v === undefined ? null : v); return v; })(), cb); },
    removeItem: function (k, cb) { return withCb(lfp(function () { kvDel(LF + k); })(), cb); },
    clear: function (cb) { return withCb(lfp(function () { kvKeys(LF).forEach(function (k) { kvDel(LF + k); }); })(), cb); },
    keys: function (cb) { return withCb(lfp(function () { return kvKeys(LF); })(), cb); },
    key: function (i, cb) { return withCb(lfp(function () { return kvKeys(LF)[i] || null; })(), cb); },
    length: function (cb) { return withCb(lfp(function () { return kvKeys(LF).length; })(), cb); },
    iterate: function (it, cb) { return withCb(lfp(function () { var ks = kvKeys(LF); for (var i = 0; i < ks.length; i++) { var r = it(kvGet(LF + ks[i]), ks[i], i + 1); if (r !== undefined) return r; } })(), cb); },
    config: function () { return true; }, ready: function (cb) { return withCb(Promise.resolve(), cb); },
    createInstance: function () { return lfShim; }, setDriver: function () { return Promise.resolve(); },
    driver: function () { return 'asyncStorage'; }, supports: function () { return true; },
    defineDriver: function () { return Promise.resolve(); }, dropInstance: function () { return Promise.resolve(); },
  };
  try {
    Object.defineProperty(window, 'localforage', { configurable: true, enumerable: true, get: function () { return lfShim; }, set: function (v) { realLocalforage = v; } });
  } catch (e) { /* ignore */ }
  R.realLocalforage = function () { return realLocalforage; };

  // ---------------------------------------------------------------------------
  // Hold the game's start until saves + manifest are loaded
  // ---------------------------------------------------------------------------
  var ready = false;
  function storageLoad() {
    if (!CLOUD_WANTED) return hostLoad();
    return cloudLoad().then(function (r) {
      if (r.error) {
        cloud.lastError = r.error;
        console.warn('[rpgm-web] cloud saves unavailable (' + r.error + '); saving in this browser instead');
        R.cloudFallback = true;
        return hostLoad();
      }
      cloud.active = true;
      var entries = r.data && r.data.entries;
      if (entries && typeof entries === 'object') Object.keys(entries).forEach(function (k) { mem.set(k, decodeValue(entries[k])); });
      log('cloud saves loaded', mem.size, 'keys');
    });
  }
  var readyPromise = Promise.all([storageLoad(), loadManifest()]).then(function () { ready = true; log('storage ready', mem.size, 'keys'); });
  readyPromise.then(function () { startPreload(CFG.preload); });
  R.ready = readyPromise;
  var origAdd = window.addEventListener;
  var origRemove = window.removeEventListener;
  var wrapped = new WeakMap();
  window.addEventListener = function (type, fn, opts) {
    if (type === 'load' && fn && !ready) {
      var w = wrapped.get(fn);
      if (!w) {
        w = function (ev) { var self = this; readyPromise.then(function () { beforeStart(); typeof fn === 'function' ? fn.call(self, ev) : fn.handleEvent(ev); }); };
        wrapped.set(fn, w);
      }
      return origAdd.call(this, type, w, opts);
    }
    return origAdd.call(this, type, fn, opts);
  };
  window.removeEventListener = function (type, fn, opts) {
    return origRemove.call(this, type, (fn && wrapped.get(fn)) || fn, opts);
  };
  var userOnload = null;
  try {
    Object.defineProperty(window, 'onload', {
      configurable: true, enumerable: true,
      get: function () { return userOnload; },
      set: function (fn) {
        userOnload = typeof fn === 'function' ? fn : null;
        if (document.readyState === 'complete' && userOnload) readyPromise.then(function () { beforeStart(); userOnload && userOnload.call(window, new Event('load')); });
      },
    });
    origAdd.call(window, 'load', function (ev) { readyPromise.then(function () { beforeStart(); if (userOnload) userOnload.call(window, ev); }); });
  } catch (e) { console.warn('[rpgm-web] could not hook window.onload', e); }

  // ---------------------------------------------------------------------------
  // Engine hooks (called from the end of core scripts by the server)
  // ---------------------------------------------------------------------------
  var media = CFG.media || {};
  var muted = false;
  try { muted = params.get('mute') === '1' || window.sessionStorage.getItem('rpgm-muted') === '1'; } catch (e) { /* ignore */ }
  var userMasterVolume = 1;

  // GPU state guard (MZ, WebGL2), a backstop for patchPixiUploads below.
  // Firefox on macOS was seen drawing half of the map background sheared for a
  // whole session: one vertex of the quad every tiling sprite shares (map
  // parallaxes, window backgrounds) came out wrong. Every few seconds, outside
  // rendering, compare PIXI's small static buffers and vertex arrays with what
  // the GPU holds, and rebuild whatever differs.
  function gpuCheck() {
    var r = typeof Graphics !== 'undefined' && Graphics.app && Graphics.app.renderer;
    var gl = r && r.gl, gs = r && r.geometry;
    if (!gl || !gs || !gs.managedGeometries || typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) return;
    if (gl.isContextLost()) return;
    var U = r.CONTEXT_UID, fixed = [];
    var prevVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING), prevCopy = gl.getParameter(gl.COPY_READ_BUFFER_BINDING);
    try {
      Object.keys(gs.managedGeometries).forEach(function (id) {
        var g = gs.managedGeometries[id], bad = false;
        // Small static geometry only (quads); batches and tilemaps rewrite theirs every frame.
        if (!g.buffers.every(function (b) { return b.static && (!b.data || b.data.byteLength <= 1024); })) return;
        var glBufs = g.buffers.map(function (b) { return b._glBuffers && b._glBuffers[U]; });
        g.buffers.forEach(function (b, i) {
          var gb = glBufs[i], data = b.data;
          if (!gb || !gb.buffer || !data || !data.byteLength || gb.updateID !== b._updateID) return;
          var got = new data.constructor(data.length);
          gl.bindBuffer(gl.COPY_READ_BUFFER, gb.buffer);
          gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, got);
          for (var k = 0; k < data.length; k++) {
            if (got[k] !== data[k] && !(got[k] !== got[k] && data[k] !== data[k])) { b._updateID++; fixed.push(g.constructor.name + ' buffer ' + i + '[' + k + '] ' + got[k] + '≠' + data[k]); return; }
          }
        });
        var vaos = g.glVertexArrayObjects && g.glVertexArrayObjects[U];
        if (vaos) {
          var want = glBufs.map(function (b) { return b && b.buffer; });
          var ib = g.indexBuffer && g.indexBuffer._glBuffers && g.indexBuffer._glBuffers[U];
          Object.keys(vaos).forEach(function (sig) {
            if (bad) return;
            gl.bindVertexArray(vaos[sig]);
            if (ib && gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING) !== ib.buffer) bad = 'index buffer';
            for (var a = 0; a < 16 && !bad; a++) {
              if (gl.getVertexAttrib(a, gl.VERTEX_ATTRIB_ARRAY_ENABLED) && want.indexOf(gl.getVertexAttrib(a, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING)) < 0) bad = 'attribute ' + a;
            }
          });
          if (bad) {
            gl.bindVertexArray(null);
            Object.keys(vaos).forEach(function (sig) {
              if (sig[0] !== 'g') return; // the rest are aliases of these
              gl.deleteVertexArray(vaos[sig]);
              glBufs.forEach(function (b) { if (b && b.refCount > 1) b.refCount--; }); // recreated on next draw
            });
            g.glVertexArrayObjects[U] = {};
            fixed.push(g.constructor.name + ' vertex array: ' + bad);
          }
        }
      });
    } catch (e) { /* diagnostics only */ }
    gl.bindBuffer(gl.COPY_READ_BUFFER, prevCopy);
    var vaoGone = fixed.some(function (f) { return / vertex array: /.test(f); });
    if (vaoGone) { gs.reset(); } else gl.bindVertexArray(prevVao);
    if (fixed.length) {
      R.gpuRepairs = (R.gpuRepairs || []).concat(fixed).slice(-20);
      console.warn('[rpgm-web] repaired GPU state: ' + fixed.join('; '));
    }
  }
  // PIXI rewrites the one quad all tiling sprites share with bufferSubData
  // several times a frame, while earlier draws may still read it. A driver that
  // gets this race wrong keeps getting it wrong the same way every frame, so
  // small buffers are re-specified with bufferData instead: the driver gives
  // each upload fresh storage and nothing in flight is overwritten.
  function patchPixiUploads() {
    var GS = typeof PIXI !== 'undefined' && PIXI.systems && PIXI.systems.GeometrySystem;
    var orig = GS && GS.prototype.updateBuffers;
    if (!orig || orig.__rpgm || !/bufferSubData\(type, 0, buffer\.data\)/.test(String(orig))) return;
    GS.prototype.updateBuffers = function () {
      var geometry = this._activeGeometry, gl = this.gl;
      for (var i = 0; i < geometry.buffers.length; i++) {
        var buffer = geometry.buffers[i], glBuffer = buffer._glBuffers[this.CONTEXT_UID];
        if (buffer._updateID === glBuffer.updateID) continue;
        glBuffer.updateID = buffer._updateID;
        var type = buffer.index ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER;
        gl.bindBuffer(type, glBuffer.buffer);
        this._boundBuffer = glBuffer;
        if (glBuffer.byteLength >= buffer.data.byteLength && buffer.data.byteLength > 16384) {
          gl.bufferSubData(type, 0, buffer.data);
        } else {
          glBuffer.byteLength = buffer.data.byteLength;
          gl.bufferData(type, buffer.data, buffer.static ? gl.STATIC_DRAW : gl.DYNAMIC_DRAW);
        }
      }
    };
    GS.prototype.updateBuffers.__rpgm = true;
  }

  function startGpuGuard() {
    if (R.gpuGuard) return;
    R.gpuGuard = setInterval(gpuCheck, 2000);
    R.gpuCheck = gpuCheck;
  }

  function canPlay(el, type) { try { return !!el.canPlayType(type).replace(/no/, ''); } catch (e) { return false; } }

  var HOOKS = {
    core: function () {
      if (typeof Utils === 'undefined') return;
      // Browser mode with desktop-like presentation.
      Utils.isNwjs = function () { return false; };
      if (typeof Graphics !== 'undefined') Graphics._defaultStretchMode = function () { return true; };
      try { patchPixiUploads(); } catch (e) { /* unknown PIXI build: leave it */ }
      if (typeof WebAudio !== 'undefined' && WebAudio.setMasterVolume) {
        var setMaster = WebAudio.setMasterVolume;
        WebAudio.setMasterVolume = function (v) { userMasterVolume = v; return setMaster.call(this, muted ? 0 : v); };
        R.applyMute = function () {
          try { setMaster.call(WebAudio, muted ? 0 : userMasterVolume); } catch (e) { /* not initialised */ }
          document.querySelectorAll('video,audio').forEach(function (m) { m.muted = muted; });
        };
        if (WebAudio.initialize) {
          var init = WebAudio.initialize;
          WebAudio.initialize = function () { var r = init.apply(this, arguments); if (muted) R.applyMute(); return r; };
        }
        if (WebAudio._createMasterGainNode) {
          var mk = WebAudio._createMasterGainNode;
          WebAudio._createMasterGainNode = function () { var r = mk.apply(this, arguments); if (muted && this._masterGainNode) this._masterGainNode.gain.value = 0; return r; };
        }
      }
    },
    managers: function () {
      if (CFG.engine === 'mv' && typeof AudioManager !== 'undefined') {
        // MV uses .m4a on every phone; prefer the original .ogg wherever it plays.
        var audio = document.createElement('audio');
        var ogg = canPlay(audio, 'audio/ogg; codecs="vorbis"') || canPlay(audio, 'audio/ogg');
        var m4a = canPlay(audio, 'audio/mp4; codecs="mp4a.40.2"') || canPlay(audio, 'audio/mp4');
        var ext = ogg && (media.ogg || !media.m4a) ? '.ogg' : m4a && media.m4a ? '.m4a' : ogg ? '.ogg' : '.m4a';
        AudioManager.audioFileExt = function () { return ext; };
      }
      if (typeof SceneManager !== 'undefined') {
        var term = SceneManager.terminate;
        SceneManager.terminate = function () { try { term && term.apply(this, arguments); } finally { backToLibrary(); } };
      }
      startGpuGuard();
    },
    objects: function () {
      if (CFG.engine === 'mv' && typeof Game_Interpreter !== 'undefined') {
        var v = document.createElement('video');
        var webm = canPlay(v, 'video/webm');
        var mp4 = canPlay(v, 'video/mp4');
        Game_Interpreter.prototype.videoFileExt = function () {
          if (webm && (media.webm || !media.mp4)) return '.webm';
          if (mp4 && media.mp4) return '.mp4';
          return webm ? '.webm' : '.mp4';
        };
      }
    },
    localforage: function () { /* the accessor above already redirected window.localforage */ },
  };
  // Runs once, after every plugin is loaded and right before the game starts.
  var started = false;
  function beforeStart() {
    if (started) return;
    started = true;
    if (window.parent !== window) postParent({ type: 'started', cloud: cloud.active });
    // Save the way the desktop build would: evaluate the final isLocalMode
    // chain (engine + plugins such as VisuMZ SaveCore) as if under NW.js, so
    // files land under save/ in our fs with desktop paths and semantics.
    if (typeof StorageManager !== 'undefined' && StorageManager.isLocalMode && params.get('storage') !== 'web') {
      var decide = StorageManager.isLocalMode;
      var local = true;
      var webIsNwjs = Utils.isNwjs;
      try { Utils.isNwjs = function () { return true; }; local = !!decide.call(StorageManager); } catch (e) { local = true; } finally { Utils.isNwjs = webIsNwjs; }
      StorageManager.isLocalMode = function () { return local; };
      log('storage mode:', local ? 'desktop files' : 'web storage');
    }
  }
  R.beforeStart = beforeStart;

  R.hook = function (name) {
    if (R.hooksRun[name]) return;
    R.hooksRun[name] = true;
    try { HOOKS[name] && HOOKS[name](); } catch (e) { console.error('[rpgm-web] hook ' + name + ' failed', e); }
  };
  // Fallback for games whose core files are renamed or bundled.
  readyPromise.then(function () { ['core', 'managers', 'objects'].forEach(function (h) { if (!R.hooksRun[h] && typeof Utils !== 'undefined') R.hook(h); }); });

  // ---------------------------------------------------------------------------
  // Mobile page behaviour
  // ---------------------------------------------------------------------------
  var style = document.createElement('style');
  style.textContent = 'html,body{overscroll-behavior:none;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}' +
    'body{touch-action:none}';
  (document.head || document.documentElement).appendChild(style);
  document.addEventListener('contextmenu', function (e) { if (e.target && e.target.tagName === 'CANVAS') e.preventDefault(); });

  // ---------------------------------------------------------------------------
  // Save export / import
  // ---------------------------------------------------------------------------
  function encodeValue(v) {
    if (v instanceof Uint8Array) return { $b64: b64encode(v) };
    if (v && typeof v === 'object' && v.data instanceof Uint8Array) return { $file: { path: v.path, mtime: v.mtime, b64: b64encode(v.data) } };
    return v;
  }
  function decodeValue(v) {
    if (v && typeof v === 'object' && typeof v.$b64 === 'string') return b64decode(v.$b64);
    if (v && typeof v === 'object' && v.$file) return { path: v.$file.path, mtime: v.$file.mtime, data: b64decode(v.$file.b64) };
    return v;
  }
  function exportSaves() {
    flush();
    var entries = {};
    mem.forEach(function (v, k) { entries[k] = encodeValue(v); });
    var payload = { format: 'rpgm-web-saves', version: 1, game: GAME_ID, title: CFG.title, engine: CFG.engine, exportedAt: new Date().toISOString(), entries: entries };
    var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = GAME_ID + '-saves-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  /** Folder the game itself saves into (honours plugin overrides). */
  function saveDir() {
    try {
      if (typeof StorageManager !== 'undefined') {
        if (StorageManager.localFileDirectoryPath) return absPath(StorageManager.localFileDirectoryPath());
        if (StorageManager.fileDirectoryPath) return absPath(StorageManager.fileDirectoryPath());
      }
    } catch (e) { console.warn('[rpgm-web] could not resolve the save folder', e); }
    return GAME_ROOT + '/save';
  }
  // ---- import: desktop save folders, single files, .zip, our .json export ----
  var JUNK_FILE = /^(desktop\.ini|thumbs\.db|\.ds_store|__macosx)$/i;
  var SAVE_FILE = /\.(rpgsave|rmmzsave)$/i;
  var MAX_IMPORT = 200 * 1024 * 1024;

  /** Where the desktop build keeps saves, in words a player can follow. */
  function desktopSaveHint() {
    var dir = saveDir().replace(/\/+$/, '');
    var rel = gameRel(dir);
    if (rel !== null) {
      var win = (rel || '.').replace(/\//g, '\\');
      // MV desktop exports keep the game in www\, MZ next to Game.exe.
      return CFG.engine === 'mv'
        ? { where: 'game', path: 'www\\' + win, alt: win }
        : { where: 'game', path: win };
    }
    var w = dir.replace(/^\//, '').replace(/\//g, '\\');
    w = w.replace(/^c:\\users\\player\\appdata\\local(?=\\|$)/i, '%LOCALAPPDATA%')
      .replace(/^c:\\users\\player\\appdata\\roaming(?=\\|$)/i, '%APPDATA%')
      .replace(/^c:\\users\\player(?=\\|$)/i, '%USERPROFILE%');
    return { where: 'user', path: w };
  }

  // Minimal zip reader (stored + deflate) on DecompressionStream.
  function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('this browser cannot open .zip files; unzip it first'));
    var ds = new DecompressionStream('deflate-raw');
    var out = new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
    return out.then(function (b) { return new Uint8Array(b); });
  }
  function unzip(buf) {
    var u8 = new Uint8Array(buf), dv = new DataView(buf);
    var eocd = -1;
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return Promise.reject(new Error('not a valid .zip file'));
    var count = dv.getUint16(eocd + 10, true), p = dv.getUint32(eocd + 16, true);
    var jobs = [], total = 0;
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      var method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      var nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
      var name = td.decode(u8.subarray(p + 46, p + 46 + nl)).replace(/\\/g, '/');
      p += 46 + nl + el + cl;
      if (/\/$/.test(name)) continue;
      total += usize;
      if (total > MAX_IMPORT) return Promise.reject(new Error('the .zip is too large'));
      var start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      var raw = u8.subarray(start, start + csize);
      jobs.push((function (name, method, raw) {
        var data = method === 0 ? Promise.resolve(raw.slice()) : method === 8 ? inflateRaw(raw) : Promise.reject(new Error(name + ': unsupported zip compression'));
        return data.then(function (d) { return { path: name, data: d }; });
      })(name, method, raw));
    }
    return Promise.all(jobs);
  }

  /** Flatten picked/dropped files (and folders, and zips) into {path, data}. */
  function readPicked(list) {
    var total = 0;
    return Promise.all(list.map(function (it) {
      total += it.file.size;
      if (total > MAX_IMPORT) return Promise.reject(new Error('that is more than 200 MB, is it really a save folder?'));
      return it.file.arrayBuffer().then(function (buf) {
        if (/\.zip$/i.test(it.path)) return unzip(buf);
        return [{ path: it.path, data: new Uint8Array(buf) }];
      });
    })).then(function (groups) { return [].concat.apply([], groups); });
  }
  function fromFileList(files) {
    return Array.from(files).map(function (f) { return { path: f.webkitRelativePath || f.name, file: f }; });
  }
  function fromDataTransfer(dt) {
    var items = Array.from(dt.items || []).map(function (i) { return i.webkitGetAsEntry && i.webkitGetAsEntry(); }).filter(Boolean);
    if (!items.length) return Promise.resolve(fromFileList(dt.files || []));
    var out = [];
    var walk = function (entry, prefix) {
      if (entry.isFile) return new Promise(function (res, rej) { entry.file(function (f) { out.push({ path: prefix + f.name, file: f }); res(); }, rej); });
      return new Promise(function (res, rej) {
        var reader = entry.createReader(), all = [];
        var next = function () {
          reader.readEntries(function (batch) {
            if (!batch.length) { Promise.all(all.map(function (e) { return walk(e, prefix + entry.name + '/'); })).then(res, rej); return; }
            all = all.concat(Array.from(batch)); next();
          }, rej);
        };
        next();
      });
    };
    return Promise.all(items.map(function (e) { return walk(e, ''); })).then(function () { return out; });
  }

  /**
   * Decide what to import. Our .json exports restore everything. Otherwise
   * take the folder holding the save files (*.rpgsave / *.rmmzsave), with
   * everything else in it (plugins keep extra files there), and copy it into
   * the folder the game saves to here.
   */
  function planImport(entries) {
    entries = entries.filter(function (e) { var b = e.path.split('/').pop(); return b && !JUNK_FILE.test(b) && e.path.split('/').indexOf('__MACOSX') < 0; });
    var jsons = entries.filter(function (e) { return /\.json$/i.test(e.path); });
    var exports = [], exportEntries = [];
    jsons.forEach(function (e) {
      try {
        var d = JSON.parse(td.decode(e.data));
        if (d && d.format === 'rpgm-web-saves' && d.entries) { exports.push(d); exportEntries.push(e); }
      } catch (err) { /* not ours */ }
    });
    var dirOf = function (p) { var i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
    var counts = {};
    entries.forEach(function (e) { if (SAVE_FILE.test(e.path)) counts[dirOf(e.path)] = (counts[dirOf(e.path)] || 0) + 1; });
    var best = null;
    Object.keys(counts).forEach(function (d) { if (best === null || counts[d] > counts[best]) best = d; });
    var files = best === null ? [] : entries.filter(function (e) { return dirOf(e.path) === best && exportEntries.indexOf(e) < 0; });
    files = files.map(function (e) { return { name: e.path.split('/').pop(), data: e.data }; });
    return { exports: exports, files: files };
  }

  function applyImport(plan) {
    var n = 0;
    plan.exports.forEach(function (d) { Object.keys(d.entries).forEach(function (k) { kvSet(k, decodeValue(d.entries[k])); n++; }); });
    if (plan.files.length) {
      var dir = saveDir().replace(/\/+$/, '');
      if (!fsMod.existsSync(dir)) fsMod.mkdirSync(dir, { recursive: true });
      plan.files.forEach(function (f) { fsMod.writeFileSync(dir + '/' + f.name, f.data); n++; });
    }
    flush();
    return n;
  }

  /** Full flow for picked or dropped items. Resolves to a message for the player. */
  function importFrom(listPromise) {
    return Promise.resolve(listPromise).then(readPicked).then(function (entries) {
      var plan = planImport(entries);
      if (!plan.exports.length && !plan.files.length) {
        throw new Error('No saves found. Pick the files from the game\u2019s save folder (they end in .' + (CFG.engine === 'mz' ? 'rmmzsave' : 'rpgsave') + '), the folder itself, or a .zip of it.');
      }
      if (plan.files.length) {
        var dir = saveDir().replace(/\/+$/, '');
        // Ask only when real save slots would be replaced (not config/global).
        var clash = plan.files.filter(function (f) { return !/^(config|global)\./i.test(f.name) && fsMod.existsSync(dir + '/' + f.name); }).length;
        if (clash && !window.confirm('Replace ' + clash + ' save' + (clash === 1 ? '' : 's') + ' in this browser with the ones from your computer?')) return null;
        var hasGlobal = plan.files.some(function (f) { return /^global\./i.test(f.name); }) || fsMod.existsSync(dir + '/global.' + (CFG.engine === 'mz' ? 'rmmzsave' : 'rpgsave'));
        var n = applyImport(plan);
        return 'Imported ' + n + ' file' + (n === 1 ? '' : 's') + (hasGlobal ? '' : '. global.' + (CFG.engine === 'mz' ? 'rmmzsave' : 'rpgsave') + ' was missing, so the save list may look empty; import the whole folder') + ' \u2014 reloading\u2026';
      }
      var m = applyImport(plan);
      return 'Restored ' + m + ' save entr' + (m === 1 ? 'y' : 'ies') + ' \u2014 reloading\u2026';
    });
  }
  // Older callers (tests, R API): a FileList or array of File.
  function importSaveFiles(files) {
    return readPicked(fromFileList(files)).then(function (entries) { return applyImport(planImport(entries)); });
  }
  R.exportSaves = exportSaves;
  R.importSaveFiles = importSaveFiles;
  R.importFrom = importFrom;
  R.fromDataTransfer = fromDataTransfer;
  R.desktopSaveHint = desktopSaveHint;

  // ---------------------------------------------------------------------------
  // Overlay
  // ---------------------------------------------------------------------------
  function buildOverlay() {
    if (params.get('overlay') === '0') return;
    var host = document.createElement('div');
    host.id = 'rpgm-overlay';
    var pin = function () {
      // Games and plugins restyle or reorder body children; stay on top.
      [['position', 'fixed'], ['top', '0'], ['left', '0'], ['width', '0'], ['height', '0'], ['z-index', '2147483647'], ['pointer-events', 'none'], ['display', 'block']]
        .forEach(function (d) { if (host.style.getPropertyValue(d[0]) !== d[1] || host.style.getPropertyPriority(d[0]) !== 'important') host.style.setProperty(d[0], d[1], 'important'); });
    };
    pin();
    new MutationObserver(pin).observe(host, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    root.innerHTML =
      '<style>' +
      '.btn{pointer-events:auto;position:fixed;top:calc(8px + env(safe-area-inset-top,0px));left:calc(8px + env(safe-area-inset-left,0px));width:34px;height:34px;border-radius:17px;border:0;' +
      'background:rgba(20,20,24,.55);color:#fff;cursor:pointer;opacity:0;transition:opacity .25s;padding:0;display:grid;place-items:center;-webkit-tap-highlight-color:transparent}' +
      '.btn.show,.btn:focus-visible{opacity:.9}.btn.touch{opacity:.35}' +
      '.menu{pointer-events:auto;position:fixed;top:calc(48px + env(safe-area-inset-top,0px));left:calc(8px + env(safe-area-inset-left,0px));min-width:210px;background:rgba(24,24,28,.94);color:#eee;border-radius:10px;padding:6px;' +
      'font:14px/1.3 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5);backdrop-filter:blur(8px)}' +
      '.menu[hidden]{display:none}' +
      '.menu{max-height:calc(100vh - 56px - env(safe-area-inset-top,0px));overflow-y:auto;overscroll-behavior:contain}' +
      '@media (max-height:440px){.menu{top:calc(6px + env(safe-area-inset-top,0px));left:calc(48px + env(safe-area-inset-left,0px));max-height:calc(100vh - 12px)}.menu button,.menu label{padding:6px 10px}.menu .title{display:none}.menu hr{margin:2px 6px}}' +
      '.menu button,.menu label{display:block;width:100%;text-align:left;background:none;border:0;color:inherit;font:inherit;padding:9px 12px;border-radius:7px;cursor:pointer;box-sizing:border-box}' +
      '.menu button:hover,.menu label:hover{background:rgba(255,255,255,.1)}' +
      '.menu hr{border:0;border-top:1px solid rgba(255,255,255,.12);margin:4px 6px}' +
      '.title{padding:8px 12px 6px;color:#aaa;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}' +
      '.toast{position:fixed;bottom:calc(20px + env(safe-area-inset-bottom,0px));left:50%;transform:translateX(-50%);background:rgba(24,24,28,.94);color:#eee;padding:10px 16px;border-radius:8px;font:14px system-ui,sans-serif;pointer-events:none}' +
      'input{display:none}' +
      '.panel{pointer-events:auto;position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(440px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow-y:auto;box-sizing:border-box;' +
      'background:rgba(24,24,28,.97);color:#eee;border-radius:12px;padding:20px 20px 16px;font:14px/1.45 system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.6)}' +
      '.panel[hidden],.drop[hidden]{display:none}' +
      '.panel h2{margin:0 28px 6px 0;font-size:17px;font-weight:650}.panel p{margin:0 0 10px;color:#c8c8d0}.panel ol{margin:0 0 14px;padding-left:20px}.panel li{margin:4px 0}' +
      '.panel code{display:block;margin:6px 0 2px;padding:7px 9px;background:rgba(255,255,255,.08);border-radius:6px;font:13px ui-monospace,Menlo,Consolas,monospace;word-break:break-all;user-select:all;-webkit-user-select:all}' +
      '.panel .alt{color:#9a9aa6;font-size:12px}' +
      '.panel .row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}' +
      '.panel .row button{flex:1 1 140px;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#fff;font:inherit;cursor:pointer}' +
      '.panel .row button.primary{background:#f0a35e;border-color:#f0a35e;color:#2a1708;font-weight:650}' +
      '.panel .row button:hover{filter:brightness(1.1)}' +
      '.panel .note{font-size:12.5px;color:#9a9aa6;margin:0}' +
      '.panel .x{position:absolute;top:10px;right:10px;width:30px;height:30px;border:0;border-radius:15px;background:none;color:#bbb;font-size:20px;line-height:1;cursor:pointer}.panel .x:hover{background:rgba(255,255,255,.1);color:#fff}' +
      '.loading{pointer-events:none;position:fixed;right:calc(10px + env(safe-area-inset-right,0px));bottom:calc(10px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:5px;min-width:150px;' +
      'background:rgba(16,16,20,.72);color:#ddd;font:12px/1.2 system-ui,sans-serif;padding:7px 10px 8px;border-radius:9px;opacity:0;transition:opacity .3s;font-variant-numeric:tabular-nums}' +
      '.loading.on{opacity:1}.loading i{display:block;height:3px;border-radius:2px;background:rgba(255,255,255,.15);overflow:hidden}.loading b{display:block;height:100%;width:0;background:#f0a35e;transition:width .2s}' +
      '.drop{pointer-events:none;position:fixed;inset:12px;border:3px dashed rgba(240,163,94,.9);border-radius:16px;background:rgba(13,11,18,.78);color:#fff;display:grid;place-items:center;font:600 18px system-ui,sans-serif;text-align:center;padding:20px}' +
      '</style>' +
      '<button class="btn" part="btn" aria-label="Menu" title="Menu"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg></button>' +
      '<div class="menu" hidden role="menu">' +
      '<div class="title"></div>' +
      '<button data-a="fullscreen">Fullscreen</button>' +
      '<button data-a="mute"></button>' +
      '<hr><button data-a="export">Export saves</button>' +
      '<button data-a="import">Import saves…</button>' +
      (EMBED
        ? '<hr><button data-a="newtab">Open in new tab</button><button data-a="library">Exit game</button>'
        : '<hr><button data-a="library">Back to library</button>') +
      '</div>' +
      '<div class="panel" hidden role="dialog" aria-modal="true" aria-labelledby="imp-h">' +
      '<h2 id="imp-h">Import saves</h2>' +
      '<p>Continue where you left off in the desktop version of the game.</p>' +
      '<ol><li>On your computer, open the game\u2019s save folder:<code class="path"></code><span class="alt"></span></li>' +
      '<li>Choose that folder, or select all the files in it.</li></ol>' +
      '<div class="row"><button data-p="folder" class="primary">Choose folder</button><button data-p="files">Choose files</button></div>' +
      '<p class="note">You can also drop the folder, or a .zip of it, onto the game. Files from <b>Export saves</b> (.json) work too.</p>' +
      '<button class="x" data-p="close" aria-label="Close">\u00d7</button>' +
      '</div>' +
      '<div class="drop" hidden>Drop your save folder here to import it</div>' +
      '<div class="loading" role="status" aria-live="off"><span></span><i><b></b></i></div>' +
      '<input type="file" class="in-files" multiple>' +
      '<input type="file" class="in-folder" webkitdirectory multiple>';
    document.body.appendChild(host);
    var btn = root.querySelector('.btn'), menu = root.querySelector('.menu');
    var panel = root.querySelector('.panel'), drop = root.querySelector('.drop');
    var inFiles = root.querySelector('.in-files'), inFolder = root.querySelector('.in-folder');
    root.querySelector('.title').textContent = CFG.title || '';
    var muteBtn = root.querySelector('[data-a=mute]');
    var setMuteLabel = function () { muteBtn.textContent = muted ? 'Sound: off' : 'Sound: on'; };
    setMuteLabel();
    var toast = function (msg, ms) {
      var t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; root.appendChild(t);
      setTimeout(function () { t.remove(); }, ms || 2600);
    };
    readyPromise.then(function () {
      if (R.cloudFallback) toast('Cloud saves are unavailable right now. Progress is saved in this browser only.', 7000);
    });
    var hideTimer = null;
    var reveal = function () { btn.classList.add('show'); clearTimeout(hideTimer); hideTimer = setTimeout(function () { if (menu.hidden) btn.classList.remove('show'); }, 2500); };
    origAdd.call(window, 'mousemove', function (e) { if (e.clientX < 120 && e.clientY < 120) reveal(); }, { passive: true });
    if (matchMedia('(pointer: coarse)').matches) btn.classList.add('touch');
    var stop = function (e) { e.stopPropagation(); };
    ['mousedown', 'mouseup', 'touchstart', 'touchend', 'pointerdown', 'pointerup', 'click', 'wheel'].forEach(function (t) { host.addEventListener(t, stop); });
    btn.addEventListener('click', function () { menu.hidden = !menu.hidden; reveal(); });
    menu.addEventListener('click', function (e) {
      var a = e.target.getAttribute && e.target.getAttribute('data-a');
      if (!a) return;
      if (a === 'fullscreen') toggleFullscreen();
      else if (a === 'mute') {
        muted = !muted;
        try { window.sessionStorage.setItem('rpgm-muted', muted ? '1' : '0'); } catch (err) { /* ignore */ }
        R.applyMute && R.applyMute();
        setMuteLabel();
      } else if (a === 'export') { exportSaves(); toast('Saves exported'); }
      else if (a === 'import') openImport();
      else if (a === 'library') backToLibrary();
      else if (a === 'newtab') openInNewTab();
      menu.hidden = true;
    });
    // ---- import panel ----
    var runImport = function (p) {
      importFrom(p).then(function (msg) {
        if (!msg) return;
        panel.hidden = true;
        toast(msg, 3000);
        setTimeout(function () { location.reload(); }, 1600);
      }, function (err) { toast(err.message || String(err), 7000); });
    };
    function openImport() {
      var h = desktopSaveHint();
      root.querySelector('.path').textContent = (h.where === 'game' ? '<game folder>\\' : '') + h.path;
      root.querySelector('.alt').textContent = h.alt ? 'or <game folder>\\' + h.alt : h.where === 'user' ? 'Paste it into the File Explorer address bar.' : '';
      if (!('webkitdirectory' in inFolder) || matchMedia('(pointer: coarse)').matches) root.querySelector('[data-p=folder]').hidden = true;
      panel.hidden = false;
      var first = panel.querySelector('.row button:not([hidden])');
      if (first) first.focus();
    }
    panel.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('[data-p]');
      a = a && a.getAttribute('data-p');
      if (a === 'close') panel.hidden = true;
      else if (a === 'files') inFiles.click();
      else if (a === 'folder') inFolder.click();
    });
    // Keys typed in the panel must not drive the game (Esc closes it).
    ['keydown', 'keyup'].forEach(function (t) {
      panel.addEventListener(t, function (e) { e.stopPropagation(); if (t === 'keydown' && e.key === 'Escape') panel.hidden = true; });
    });
    [inFiles, inFolder].forEach(function (inp) {
      inp.addEventListener('change', function () {
        if (inp.files.length) runImport(fromFileList(inp.files));
        inp.value = '';
      });
    });
    // Drag a save folder (or files, or a .zip) onto the game.
    var hasFiles = function (e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; };
    origAdd.call(window, 'dragover', function (e) { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; drop.hidden = false; });
    origAdd.call(window, 'dragleave', function (e) { if (!e.relatedTarget) drop.hidden = true; });
    origAdd.call(window, 'drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      drop.hidden = true;
      runImport(fromDataTransfer(e.dataTransfer));
    });
    // Close the menu when the game is clicked.
    origAdd.call(window, 'pointerdown', function (e) {
      if (menu.hidden) return;
      var path = e.composedPath ? e.composedPath() : [];
      if (path.indexOf(host) >= 0) return; // a click inside the overlay itself
      menu.hidden = true;
    }, true);
    // ---- asset loading indicator ----
    var ld = root.querySelector('.loading'), ldText = ld.querySelector('span'), ldBar = ld.querySelector('b');
    var mb = function (n) { return n >= 10485760 ? Math.round(n / 1048576) : (n / 1048576).toFixed(1); };
    var ldTimer = null, ldHide = null;
    var renderLoads = function () {
      var busy = loads.active > 0 || loads.queued > 0;
      var count = loads.count + loads.queued, bytes = loads.bytes + loads.queuedBytes;
      var big = bytes > 1048576 || count > 10;
      if (busy && big && Date.now() - loads.since > 800) {
        clearTimeout(ldHide); ldHide = null;
        var pct = bytes ? Math.min(100, loads.loaded / bytes * 100) : loads.done / count * 100;
        ldText.textContent = 'Loading ' + loads.done + ' / ' + count + (bytes ? ' \u00b7 ' + mb(loads.loaded) + ' / ' + mb(bytes) + ' MB' : '');
        ldBar.style.width = pct.toFixed(1) + '%';
        ld.classList.add('on');
      } else if (!busy && ld.classList.contains('on') && !ldHide) {
        ldBar.style.width = '100%';
        ldHide = setTimeout(function () { ld.classList.remove('on'); ldHide = null; }, 500);
      }
      if (busy && !ldTimer) ldTimer = setInterval(renderLoads, 250);
      if (!busy && ldTimer) { clearInterval(ldTimer); ldTimer = null; }
    };
    if (params.get('loading') !== '0') { loads.onChange = renderLoads; renderLoads(); }
    var mo = new MutationObserver(function () {
      if (muted) R.applyMute && R.applyMute();
      if (document.body.lastElementChild !== host) document.body.appendChild(host); // keep last in stacking order
    });
    mo.observe(document.body, { childList: true, subtree: false });
  }
  if (document.body) buildOverlay();
  else document.addEventListener('DOMContentLoaded', buildOverlay);
})();
