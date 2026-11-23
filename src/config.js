import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Merge CLI flags, env and <data>/config.json; create an admin token on first run. */
export function loadConfig(flags = {}) {
  const dataDir = path.resolve(flags.data || process.env.RPGM_DATA || './data');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'config.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  if (!saved.adminToken && !process.env.RPGM_ADMIN_TOKEN) {
    saved.adminToken = crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
  }
  const bool = (v, d) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(v));
  return {
    dataDir,
    port: Number(flags.port || process.env.RPGM_PORT || saved.port || 8080),
    host: flags.host || process.env.RPGM_HOST || saved.host || '0.0.0.0',
    adminToken: process.env.RPGM_ADMIN_TOKEN || saved.adminToken,
    // API-only: no library page at /, the game list needs the admin token;
    // games stay reachable at /play/<id>/ and /embed/<id>/.
    apiOnly: /^api$/i.test(process.env.RPGM_MODE || saved.mode || '') || bool(process.env.RPGM_API_ONLY, saved.apiOnly ?? false),
    publicLibrary: bool(process.env.RPGM_PUBLIC_LIBRARY, saved.publicLibrary ?? true),
    maxUploadBytes: Number(process.env.RPGM_MAX_UPLOAD_GB || saved.maxUploadGB || 8) * 1024 ** 3,
    // CSP frame-ancestors for embeds: '*' (anyone) or a space-separated list of origins
    frameAncestors: process.env.RPGM_FRAME_ANCESTORS || saved.frameAncestors || '*',
    trustProxy: bool(process.env.RPGM_TRUST_PROXY, saved.trustProxy ?? false),
    // Caps for unpacking uploaded archives (zip bombs and the like).
    limits: {
      maxBytes: Number(process.env.RPGM_MAX_UNPACKED_GB || saved.maxUnpackedGB || 20) * 1024 ** 3,
      maxFiles: Number(process.env.RPGM_MAX_FILES || saved.maxFiles || 200000),
    },
    // Imports run one at a time by default so they never starve game serving.
    importConcurrency: Math.max(1, Number(process.env.RPGM_IMPORT_CONCURRENCY || saved.importConcurrency || 1)),
    // Brotli/gzip copies of text files made at import (served with zero CPU).
    precompress: bool(process.env.RPGM_PRECOMPRESS, saved.precompress ?? true),
  };
}
