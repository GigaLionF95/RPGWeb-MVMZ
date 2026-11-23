const $ = (s) => document.querySelector(s);
const TOKEN_KEY = 'rpgm-admin-token';
let token = localStorage.getItem(TOKEN_KEY) || '';
let admin = false;

const fmtBytes = (n) => {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
};
const num = new Intl.NumberFormat();

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`api/${path}`, { ...opts, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(body.error || res.statusText); e.status = res.status; throw e; }
  return body;
}

function setStatus(msg) { $('#status').textContent = msg || ''; }

const byId = new Map();

function embedCode(g, mode, width) {
  const src = new URL(g.embedUrl, location.href).href;
  const { width: w, height: h } = g.screen || { width: 816, height: 624 };
  const title = g.title.replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]));
  const attrs = `src="${src}" title="${title}" allow="fullscreen; autoplay; gamepad" allowfullscreen loading="lazy"`;
  if (mode === 'sdk') {
    const origin = new URL('.', location.href).href.replace(/\/$/, '');
    const el = `rpgm-${g.id}`;
    return `<div id="${el}"></div>
<script src="${origin}/sdk/rpgm-embed.js"></script>
<script>
  RPGMWeb.embed('#${el}', {
    server: '${origin}',
    game: '${g.id}',
    // Saves live on YOUR server under YOUR accounts. Replace the URLs with your API.
    cloudSaves: {
      load: (game) => fetch('/api/saves/' + game, { credentials: 'include' })
        .then((r) => (r.status === 404 ? null : r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))),
      save: (game, data) => fetch('/api/saves/' + game, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      }),
    },
  });
</script>`;
  }
  if (mode === 'fixed') {
    const fw = Math.max(240, Math.round(width || w));
    return `<iframe ${attrs} width="${fw}" height="${Math.round((fw * h) / w)}" style="border:0"></iframe>`;
  }
  return `<div style="position:relative;width:100%;max-width:${w}px;aspect-ratio:${w}/${h}">` +
    `<iframe ${attrs} style="position:absolute;inset:0;width:100%;height:100%;border:0"></iframe></div>`;
}

function renderEmbed(li) {
  const g = byId.get(li.dataset.id);
  const panel = li.querySelector('.embed');
  const mode = panel.querySelector('[aria-checked="true"]').dataset.size;
  const wInput = panel.querySelector('.fixed-w input');
  if (!wInput.value) wInput.value = g.screen?.width || 816;
  panel.querySelector('.fixed-w').hidden = mode !== 'fixed';
  const fw = Number(wInput.value) || g.screen.width;
  panel.querySelector('.fixed-h').textContent = `× ${Math.round((fw * g.screen.height) / g.screen.width)} px`;
  panel.querySelector('.embed-code').value = embedCode(g, mode, fw);
  panel.querySelector('.embed-code').rows = mode === 'sdk' ? 18 : 4;
  panel.querySelector('.embed-note').textContent = mode === 'sdk'
    ? 'Players sign in on your site; their saves are stored by your API and follow them to any device.'
    : 'Visitors click to start, like on itch.io. Saves stay in the visitor\'s browser.';
  panel.querySelector('.embed-preview').href = g.embedUrl;
  const thumb = panel.querySelector('.cover-thumb');
  thumb.hidden = !g.hasCover;
  if (g.hasCover) thumb.src = g.coverUrl;
  panel.querySelector('.cover-text').textContent = g.customCover
    ? 'Custom cover image.'
    : g.hasCover ? 'Cover is the game\'s title screen art. Upload an image to replace it.' : 'No cover yet: the embed shows the game icon. Upload a 16:9 image for a nicer start screen.';
  panel.querySelector('[data-act=remove-cover]').hidden = !g.customCover;
}

function renderGames(games) {
  const list = $('#games');
  byId.clear();
  for (const g of games) byId.set(g.id, g);
  list.replaceChildren();
  $('#empty').hidden = games.length > 0;
  for (const g of games) {
    const li = $('#tpl-game').content.firstElementChild.cloneNode(true);
    li.dataset.id = g.id;
    li.classList.toggle('hidden-game', !!g.hidden);
    const img = li.querySelector('.icon');
    const fallback = () => {
      const s = document.createElement('span');
      s.className = 'icon fallback';
      s.setAttribute('aria-hidden', 'true');
      s.textContent = (g.title.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase();
      img.replaceWith(s);
    };
    if (g.icon) { img.onerror = fallback; img.src = `api/games/${encodeURIComponent(g.id)}/icon`; }
    else fallback();
    li.querySelector('.title').textContent = g.title;
    const meta = li.querySelector('.meta');
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = `${g.engine.toUpperCase()}${g.engineVersion ? ' ' + g.engineVersion : ''}`;
    meta.append(tag, ` · ${fmtBytes(g.totalBytes)} · ${num.format(g.fileCount)} files${g.hidden ? ' · unlisted' : ''}`);
    const play = li.querySelector('.play');
    play.href = g.url;
    play.setAttribute('aria-label', `Play ${g.title}`);
    const adm = li.querySelector('.admin');
    adm.hidden = !admin;
    const hideBtn = li.querySelector('[data-act=hide]');
    hideBtn.classList.toggle('on', !!g.hidden);
    hideBtn.title = g.hidden ? 'Show in the library' : 'Unlist: hide from the library, the link keeps working';
    hideBtn.setAttribute('aria-label', hideBtn.title);
    hideBtn.querySelector('use').setAttribute('href', g.hidden ? '#i-eye-off' : '#i-eye');
    list.append(li);
  }
}

async function refresh() {
  try {
    const { games, admin: isAdmin } = await api('games');
    setAdmin(isAdmin);
    renderGames(games);
    setStatus('');
  } catch (e) {
    if (e.status === 401) { setStatus('This library is private. Sign in with the admin token.'); renderGames([]); $('#empty').hidden = true; }
    else setStatus(`Could not load the library: ${e.message}`);
  }
}

function setAdmin(on) {
  admin = on;
  $('#btn-add').hidden = !on;
  const s = $('#btn-signin');
  s.querySelector('span').textContent = on ? 'Sign out' : 'Admin';
  s.setAttribute('aria-label', on ? 'Sign out' : 'Sign in as admin');
}

// --- sign in -----------------------------------------------------------------
$('#btn-signin').addEventListener('click', () => {
  if (admin) {
    token = ''; localStorage.removeItem(TOKEN_KEY); setAdmin(false);
    $('#upload').hidden = true; refresh(); return;
  }
  $('#signin').hidden = false;
  $('#token').focus();
});
$('#signin [data-close]').addEventListener('click', () => { $('#signin').hidden = true; });
$('#signin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#signin-error');
  err.hidden = true;
  token = $('#token').value.trim();
  try {
    await api('auth');
    localStorage.setItem(TOKEN_KEY, token);
    $('#signin').hidden = true;
    $('#token').value = '';
    await refresh();
  } catch {
    token = '';
    err.textContent = 'That token is not right. Check it with "rpgm-web token" on the server.';
    err.hidden = false;
  }
});

// --- upload --------------------------------------------------------------------
$('#btn-add').addEventListener('click', () => {
  const up = $('#upload');
  up.hidden = !up.hidden;
  if (!up.hidden) $('#drop').focus();
});
const drop = $('#drop');
drop.addEventListener('click', () => $('#file').click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click(); } });
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f) upload(f);
});
$('#file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) upload(f); e.target.value = ''; });

const job = {
  el: $('#job'),
  show(label) { this.el.hidden = false; this.el.className = 'job'; $('#job-log').replaceChildren(); this.set(label, 0); },
  set(label, frac, numText = '') {
    $('#job-label').textContent = label;
    $('#job-num').textContent = numText;
    $('#job-bar').style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
  },
  log(lines, cls) {
    const ol = $('#job-log');
    for (const l of lines) { const li = document.createElement('li'); li.textContent = l; if (cls) li.className = cls; ol.append(li); }
    ol.scrollTop = ol.scrollHeight;
  },
};

function upload(file) {
  const qs = new URLSearchParams({ filename: file.name });
  const title = $('#up-title').value.trim();
  const id = $('#up-id').value.trim();
  if (title) qs.set('title', title);
  if (id) qs.set('id', id);
  job.show(`Uploading ${file.name}`);
  drop.setAttribute('aria-disabled', 'true');
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `api/games?${qs}`);
  xhr.setRequestHeader('Authorization', `Bearer ${token}`);
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) job.set(`Uploading ${file.name}`, e.loaded / e.total, `${fmtBytes(e.loaded)} / ${fmtBytes(e.total)}`);
  };
  xhr.onerror = () => fail('The upload was interrupted. Check the connection and try again.');
  xhr.onload = () => {
    let body = {};
    try { body = JSON.parse(xhr.responseText); } catch { /* not json */ }
    if (xhr.status !== 202) return fail(body.error || `Upload failed (${xhr.status})`);
    job.set('Importing', 0);
    poll(body.job);
  };
  xhr.send(file);
}

const PHASES = { queued: 'Waiting', extract: 'Extracting', locate: 'Finding the game', transcode: 'Converting media for phones', precompress: 'Compressing text files', install: 'Installing', done: 'Done' };

async function poll(id) {
  let seen = 0;
  for (;;) {
    let j;
    try { j = await api(`jobs/${id}`); } catch (e) { return fail(e.message); }
    if (j.log.length > seen) { job.log(j.log.slice(seen)); seen = j.log.length; }
    const frac = j.total > 1 ? j.done / j.total : j.status === 'done' ? 1 : 0.05;
    const numText = j.phase === 'extract' ? `${fmtBytes(j.done)} / ${fmtBytes(j.total)}` : j.total > 1 ? `${j.done} / ${j.total}` : '';
    job.set(PHASES[j.phase] || j.phase, frac, numText);
    if (j.status === 'done') {
      job.el.classList.add('done');
      job.set(`Added “${j.game.title}”`, 1, '');
      drop.removeAttribute('aria-disabled');
      $('#up-title').value = ''; $('#up-id').value = '';
      return refresh();
    }
    if (j.status === 'error') return fail(j.error);
    await new Promise((r) => setTimeout(r, 700));
  }
}

function fail(msg) {
  job.el.classList.add('err');
  job.set('Import failed', 1, '');
  job.log([msg], 'err');
  drop.removeAttribute('aria-disabled');
}

// --- row actions -----------------------------------------------------------------
$('#games').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const li = btn.closest('.game');
  const id = li.dataset.id;
  const act = btn.dataset.act;
  try {
    if (act === 'delete') { li.querySelector('.confirm').hidden = false; li.querySelector('[data-act=cancel-delete]').focus(); }
    else if (act === 'cancel-delete') li.querySelector('.confirm').hidden = true;
    else if (act === 'confirm-delete') { btn.disabled = true; await api(`games/${id}`, { method: 'DELETE' }); await refresh(); setStatus('Game deleted.'); }
    else if (act === 'embed' || act === 'cover') {
      const panel = li.querySelector('.embed');
      panel.hidden = act === 'cover' ? false : !panel.hidden;
      if (!panel.hidden) { renderEmbed(li); if (act === 'cover') li.querySelector('.cover-file').click(); }
    } else if (act === 'copy-embed') {
      const code = li.querySelector('.embed-code');
      try { await navigator.clipboard.writeText(code.value); } catch { code.select(); document.execCommand('copy'); }
      btn.querySelector('span').textContent = 'Copied';
      setTimeout(() => { btn.querySelector('span').textContent = 'Copy code'; }, 1600);
    } else if (act === 'pick-cover') li.querySelector('.cover-file').click();
    else if (act === 'remove-cover') {
      await api(`games/${id}/cover`, { method: 'DELETE' });
      await refresh(); reopenEmbed(id);
    } else if (act === 'hide') {
      const hidden = !li.classList.contains('hidden-game');
      await api(`games/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hidden }) });
      await refresh();
    } else if (act === 'rename') startRename(li, id);
  } catch (err) { setStatus(err.message); }
});

function reopenEmbed(id) {
  const li = document.querySelector(`.game[data-id="${CSS.escape(id)}"]`);
  if (!li) return;
  li.querySelector('.embed').hidden = false;
  renderEmbed(li);
}

$('#games').addEventListener('click', (e) => {
  const seg = e.target.closest('.seg button');
  if (!seg) return;
  const li = seg.closest('.game');
  seg.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b === seg)));
  renderEmbed(li);
});
$('#games').addEventListener('input', (e) => {
  if (e.target.matches('.fixed-w input')) renderEmbed(e.target.closest('.game'));
});
$('#games').addEventListener('change', async (e) => {
  if (!e.target.matches('.cover-file') || !e.target.files[0]) return;
  const li = e.target.closest('.game');
  const id = li.dataset.id;
  const file = e.target.files[0];
  e.target.value = '';
  try {
    await api(`games/${id}/cover`, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
    await refresh(); reopenEmbed(id);
    setStatus('Cover updated.');
  } catch (err) { setStatus(`Could not set the cover: ${err.message}`); }
});

function startRename(li, id) {
  const t = li.querySelector('.title');
  const before = t.textContent;
  t.contentEditable = 'true';
  t.focus();
  document.getSelection().selectAllChildren(t);
  const done = async (save) => {
    t.contentEditable = 'false';
    t.removeEventListener('keydown', onKey);
    t.removeEventListener('blur', onBlur);
    const title = t.textContent.trim();
    if (!save || !title || title === before) { t.textContent = before; return; }
    try { await api(`games/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) }); await refresh(); }
    catch (err) { t.textContent = before; setStatus(err.message); }
  };
  const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); done(true); } if (e.key === 'Escape') done(false); };
  const onBlur = () => done(true);
  t.addEventListener('keydown', onKey);
  t.addEventListener('blur', onBlur);
}

refresh();
