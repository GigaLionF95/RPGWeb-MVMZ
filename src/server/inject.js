// Serve-time patches: runtime injection into index.html and hook calls
// appended to the engine's core scripts. Game files on disk stay untouched.

const HOOKS = {
  'js/rpg_core.js': 'core', 'js/rmmz_core.js': 'core',
  'js/rpg_managers.js': 'managers', 'js/rmmz_managers.js': 'managers',
  'js/rpg_objects.js': 'objects', 'js/rmmz_objects.js': 'objects',
  'js/rpg_scenes.js': 'scenes', 'js/rmmz_scenes.js': 'scenes',
  'js/rpg_sprites.js': 'sprites', 'js/rmmz_sprites.js': 'sprites',
  'js/rpg_windows.js': 'windows', 'js/rmmz_windows.js': 'windows',
  'js/plugins.js': 'plugins',
  'js/libs/localforage.min.js': 'localforage',
};

export function hookFor(relPath) {
  return HOOKS[relPath.toLowerCase()] || null;
}

export function patchScript(buf, hook) {
  return Buffer.concat([buf, Buffer.from(`\n;window.__RPGM&&window.__RPGM.hook(${JSON.stringify(hook)});\n`)]);
}

const esc = (s) => String(s).replace(/</g, '\\u003c');

export function patchIndexHtml(html, cfg) {
  const head = [
    `<script data-cfasync="false">window.__RPGM_CONFIG=${esc(JSON.stringify(cfg))};</script>`,
    `<script data-cfasync="false" crossorigin="anonymous" src="__rpgm/runtime.js?v=${encodeURIComponent(cfg.runtimeVersion)}"></script>`,
    `<link rel="manifest" href="__rpgm/manifest.webmanifest">`,
    `<meta name="mobile-web-app-capable" content="yes">`,
    `<meta name="theme-color" content="#000000">`,
  ].join('\n');
  let out = html.replace(/^﻿/, '');
  // Cloudflare Rocket Loader rewrites and defers <script> tags, which breaks
  // the engine's strict load order; opt every game script out of it.
  out = out.replace(/<script\b(?![^>]*data-cfasync)/gi, '<script data-cfasync="false"');
  // Load the game's own scripts in CORS mode: inside the sandbox they count as
  // cross-origin, and the browser would report every error in them as a bare
  // "Script error." without message, file or line.
  out = out.replace(/<script\b(?![^>]*\bcrossorigin)(?=[^>]*\ssrc=["']?(?![a-z][\w+.-]*:|\/\/))/gi, '<script crossorigin="anonymous"');
  // Mobile: fit the device width and allow drawing under the notch.
  const viewport = '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">';
  if (/<meta[^>]+name=["']?viewport[^>]*>/i.test(out)) out = out.replace(/<meta[^>]+name=["']?viewport[^>]*>/i, viewport);
  else out = out.replace(/<head[^>]*>/i, (m) => `${m}\n${viewport}`);
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => `${m}\n${head}`);
  else out = head + out;
  return out;
}
