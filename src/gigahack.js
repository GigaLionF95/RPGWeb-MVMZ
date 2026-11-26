// GigaHack MV/MZ (https://github.com/GigaLionF95/GigaHack-MVMZ): a mod and
// debug menu that installs into a game as ordinary plugins. A copy lives in
// vendor/gigahack; for games where an admin switched it on, the server adds
// its modules to the end of js/plugins.js and serves the module files as if
// they were in the game's js/plugins/. Nothing in the game folder changes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../vendor/gigahack');

let info;
/** { version, modules: [name…] } of the vendored copy, or null when it is missing. */
export function gigahack() {
  if (info !== undefined) return info;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
    const modules = (m.modules || []).map((x) => x.name).filter((n) => /^GigaHack_\w+$/.test(n));
    info = modules.length ? { version: String(m.version || '0'), modules } : null;
  } catch { info = null; }
  return info;
}

/** Disk path of a module the game asked for as js/plugins/<name>.js, or null. */
export function gigahackFile(rel) {
  const gh = gigahack();
  const m = /^js\/plugins\/(GigaHack_\w+)\.js$/i.exec(rel);
  if (!gh || !m) return null;
  const name = gh.modules.find((n) => n.toLowerCase() === m[1].toLowerCase());
  return name ? path.join(DIR, 'js/plugins', name + '.js') : null;
}

/**
 * Script appended to js/plugins.js: the modules go last, in manifest order, so
 * GigaHack's aliases wrap everything else (its load-order rule). A game that
 * ships its own GigaHack keeps its own entries, on or off.
 */
export function gigahackPluginsPatch() {
  const gh = gigahack();
  if (!gh) return '';
  return `\n;(function () {\n  if (typeof $plugins === 'undefined' || !Array.isArray($plugins)) return;\n  var have = {};\n  $plugins.forEach(function (p) { if (p && p.name) have[p.name] = 1; });\n  ${JSON.stringify(gh.modules)}.forEach(function (n) {\n    if (!have[n]) $plugins.push({ name: n, status: true, description: 'GigaHack ${gh.version} (added by rpgm-web)', parameters: {} });\n  });\n})();\n`;
}
