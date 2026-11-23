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
    publicLibrary: bool(process.env.RPGM_PUBLIC_LIBRARY, saved.publicLibrary ?? true),
    maxUploadBytes: Number(process.env.RPGM_MAX_UPLOAD_GB || saved.maxUploadGB || 8) * 1024 ** 3,
    trustProxy: bool(process.env.RPGM_TRUST_PROXY, saved.trustProxy ?? false),
  };
}
