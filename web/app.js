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

function renderGames(games) {
  const list = $('#games');
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
    meta.append(tag, ` · ${fmtBytes(g.totalBytes)} · ${num.format(g.fileCount)} files${g.hidden ? ' · hidden' : ''}`);
    const play = li.querySelector('.play');
    play.href = g.url;
    play.setAttribute('aria-label', `Play ${g.title}`);
    const adm = li.querySelector('.admin');
    adm.hidden = !admin;
    const hideBtn = li.querySelector('[data-act=hide]');
    hideBtn.classList.toggle('on', !!g.hidden);
    hideBtn.setAttribute('aria-label', g.hidden ? 'Show in library' : 'Hide from library');
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

const PHASES = { queued: 'Waiting', extract: 'Extracting', locate: 'Finding the game', transcode: 'Converting media for phones', install: 'Installing', done: 'Done' };

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
    else if (act === 'hide') {
      const hidden = !li.classList.contains('hidden-game');
      await api(`games/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hidden }) });
      await refresh();
    } else if (act === 'rename') startRename(li, id);
  } catch (err) { setStatus(err.message); }
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
