#!/usr/bin/env node
// rpgm-web CLI: serve | import | list | remove | info | token
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Library } from '../src/library.js';
import { importGame } from '../src/importer/index.js';
import { loadConfig } from '../src/config.js';

const HELP = `rpgm-web — run RPG Maker MV/MZ games in the browser

Usage:
  rpgm-web serve  [--port 8080] [--host 0.0.0.0] [--data ./data]
  rpgm-web import <archive-or-folder> [--id my-game] [--title "Title"] [--transcode auto|off|audio|video]
  rpgm-web list
  rpgm-web info   <id>
  rpgm-web remove <id>
  rpgm-web token          print the admin API token

Environment: RPGM_DATA, RPGM_PORT, RPGM_HOST, RPGM_ADMIN_TOKEN, RPGM_FFMPEG,
             RPGM_PUBLIC_LIBRARY (1/0), RPGM_MAX_UPLOAD_GB
`;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    id: { type: 'string' },
    title: { type: 'string' },
    transcode: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [cmd, ...args] = positionals;
if (!cmd || opt.help) { process.stdout.write(HELP); process.exit(cmd ? 0 : 1); }

const config = loadConfig({ data: opt.data, port: opt.port, host: opt.host });
const lib = new Library(config.dataDir);

function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

try {
  switch (cmd) {
    case 'serve': {
      const { startServer } = await import('../src/server/index.js');
      await startServer(config, lib);
      break;
    }
    case 'import': {
      if (!args[0]) throw new Error('import: missing <archive-or-folder>');
      let lastLine = '';
      const meta = await importGame(lib, path.resolve(args[0]), {
        id: opt.id, title: opt.title, transcode: opt.transcode,
        log: (m) => { if (lastLine) process.stderr.write('\n'); lastLine = ''; console.log('•', m); },
        onProgress: ({ phase, done, total, message }) => {
          if (!process.stderr.isTTY || !total || total <= 1) return;
          lastLine = `\r  ${message || phase}: ${phase === 'extract' ? fmtBytes(done) + ' / ' + fmtBytes(total) : done + ' / ' + total}   `;
          process.stderr.write(lastLine);
        },
      });
      if (lastLine) process.stderr.write('\n');
      console.log(`\n✓ ${meta.title} → /play/${meta.id}/  (${meta.engine.toUpperCase()}, ${meta.fileCount} files, ${fmtBytes(meta.totalBytes)})`);
      break;
    }
    case 'list': {
      const games = await lib.list();
      if (!games.length) console.log('(library is empty)');
      for (const g of games) console.log(`${g.id.padEnd(32)} ${g.engine.toUpperCase()} ${String(g.engineVersion || '').padEnd(7)} ${fmtBytes(g.totalBytes).padStart(9)}  ${g.title}`);
      break;
    }
    case 'info': {
      const g = await lib.get(args[0] || '');
      if (!g) throw new Error(`no game "${args[0]}"`);
      console.log(JSON.stringify(g.meta, null, 2));
      break;
    }
    case 'remove': {
      if (!(await lib.get(args[0] || ''))) throw new Error(`no game "${args[0]}"`);
      await lib.remove(args[0]);
      console.log(`removed ${args[0]}`);
      break;
    }
    case 'token':
      console.log(config.adminToken);
      break;
    default:
      throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  }
} catch (e) {
  console.error('error:', e.message);
  process.exit(1);
}
