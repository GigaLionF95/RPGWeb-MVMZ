/*!
 * rpgm-web embed SDK
 *
 * Put an RPG Maker MV/MZ game from an rpgm-web server on your page, and
 * optionally keep players' saves in YOUR backend, under YOUR accounts:
 *
 *   <div id="game"></div>
 *   <script src="https://games.example.com/sdk/rpgm-embed.js"></script>
 *   <script>
 *     RPGMWeb.embed('#game', {
 *       server: 'https://games.example.com',
 *       game: 'my-game',
 *       cloudSaves: {
 *         // Return the object you stored last time, or null for a new player.
 *         load: (game) => fetch('/api/saves/' + game, { credentials: 'include' })
 *                           .then((r) => (r.status === 404 ? null : r.json())),
 *         // `data` is a JSON-safe object; store it as-is for the signed-in user.
 *         save: (game, data, info) => {
 *           const body = JSON.stringify(data);
 *           return fetch('/api/saves/' + game, {
 *             method: 'PUT', credentials: 'include',
 *             headers: { 'Content-Type': 'application/json' }, body,
 *             // finish even if the tab is closing (browsers cap keepalive at 64 KB)
 *             keepalive: body.length < 60000,
 *           });
 *         },
 *       },
 *     });
 *   </script>
 *
 * The game never sees your cookies or tokens: it asks this page for saves over
 * postMessage, and this page answers with whatever your backend returns.
 * If `load` throws (for example the visitor is not signed in), the game falls
 * back to saving in the visitor's browser and tells them so.
 */
(function (global) {
  'use strict';
  var VERSION = '1';

  function resolveTarget(target) {
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) throw new Error('RPGMWeb: element not found: ' + target);
    return el;
  }

  /**
   * Wire an existing <iframe> (pointing at /embed/<id>/ or /play/<id>/) to the
   * page: cloud saves and lifecycle events. Returns { detach }.
   */
  function attach(iframe, opts) {
    opts = opts || {};
    var origin = new URL(iframe.src, location.href).origin;
    var saves = opts.cloudSaves || null;
    var queue = Promise.resolve();

    function reply(msg) {
      msg.rpgm = 1;
      if (iframe.contentWindow) iframe.contentWindow.postMessage(msg, origin);
    }
    function emit(type, detail) {
      if (typeof opts.onEvent === 'function') { try { opts.onEvent(type, detail); } catch (e) { console.error(e); } }
    }

    function onMessage(e) {
      var d = e.data;
      if (e.source !== iframe.contentWindow || e.origin !== origin || !d || d.rpgm !== 1) return;
      if (d.type === 'hello') {
        emit('hello', { game: d.game, title: d.title });
        if (!d.cloud) return;
        if (!saves || typeof saves.load !== 'function') { reply({ type: 'saves', game: d.game, error: 'cloud saves are not configured on this page' }); return; }
        Promise.resolve().then(function () { return saves.load(d.game); }).then(
          function (data) { reply({ type: 'saves', game: d.game, data: data || null }); emit('loaded', { game: d.game, empty: !data }); },
          function (err) { reply({ type: 'saves', game: d.game, error: String((err && err.message) || err || 'load failed') }); emit('error', { game: d.game, stage: 'load', error: err }); }
        );
      } else if (d.type === 'save') {
        if (!saves || typeof saves.save !== 'function') return;
        // Keep writes in order; a newer snapshot always lands last.
        // info.final: the game or this page is being hidden/closed; use a
        // request that survives unload (fetch keepalive / sendBeacon).
        var info = { seq: d.seq, final: !!d.final || document.visibilityState === 'hidden' };
        queue = queue.then(function () { return saves.save(d.game, d.data, info); }).then(
          function () { reply({ type: 'saved', game: d.game, seq: d.seq, ok: true }); emit('saved', { game: d.game, seq: d.seq }); },
          function (err) { reply({ type: 'saved', game: d.game, seq: d.seq, ok: false, error: String((err && err.message) || err) }); emit('error', { game: d.game, stage: 'save', error: err }); }
        );
      } else {
        emit(d.type, d); // 'started', 'exit'
      }
    }
    global.addEventListener('message', onMessage);
    return { iframe: iframe, detach: function () { global.removeEventListener('message', onMessage); } };
  }

  /**
   * Create the embed inside `target`.
   * opts: server, game (id), cloudSaves {load, save}, mute (bool),
   *       width/height (fixed px; default responsive with the game's ratio),
   *       ratio ('16/9'; default from the server), onEvent(type, detail)
   */
  function embed(target, opts) {
    opts = opts || {};
    if (!opts.server || !opts.game) throw new Error('RPGMWeb.embed: `server` and `game` are required');
    var host = resolveTarget(target);
    var server = String(opts.server).replace(/\/+$/, '');
    var q = new URLSearchParams();
    if (opts.cloudSaves) q.set('cloud', '1');
    if (opts.mute) q.set('mute', '1');
    var src = server + '/embed/' + encodeURIComponent(opts.game) + '/' + (q.toString() ? '?' + q : '');

    var iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.title = opts.title || 'Game';
    iframe.allow = 'fullscreen; autoplay; gamepad';
    iframe.setAttribute('allowfullscreen', '');
    iframe.loading = opts.loading || 'lazy';
    iframe.style.border = '0';

    if (opts.width && opts.height) {
      iframe.width = opts.width;
      iframe.height = opts.height;
      host.appendChild(iframe);
    } else {
      var box = document.createElement('div');
      box.style.cssText = 'position:relative;width:100%;aspect-ratio:' + (opts.ratio || '16/9');
      iframe.style.cssText += ';position:absolute;inset:0;width:100%;height:100%';
      box.appendChild(iframe);
      host.appendChild(box);
      if (!opts.ratio) {
        fetch(server + '/api/games/' + encodeURIComponent(opts.game)).then(function (r) { return r.ok ? r.json() : null; }).then(function (g) {
          if (!g || !g.screen) return;
          box.style.aspectRatio = g.screen.width + '/' + g.screen.height;
          box.style.maxWidth = g.screen.width + 'px';
          if (!opts.title) iframe.title = g.title;
        }).catch(function () { /* keep 16:9 */ });
      }
    }
    return attach(iframe, opts);
  }

  global.RPGMWeb = { version: VERSION, embed: embed, attach: attach };
})(window);
