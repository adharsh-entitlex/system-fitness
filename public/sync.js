'use strict';

/* ======================================================================
   Backend sync
   ----------------------------------------------------------------------
   The server keeps the canonical record; localStorage stays the offline
   cache, so the app keeps working with the server down or closed.

   Conflict rule: last write wins on meta.updatedAt. Anything newer than
   this tab — another tab, a device, the server — is adopted rather than
   overwritten, and the server answers a stale write with 409 + its copy.
   ====================================================================== */

const SYNC_API = '/api';

const sync = { online: null, busy: false, at: 0, error: '' };
let pushTimer = null;
let adopting = false;

/* ---------------- status ---------------- */

function syncView() {
  if (sync.busy) return ['SYNCING…', ''];
  if (sync.online === false) return ['LOCAL ONLY', 'is-offline'];
  if (sync.error) return [`SYNC ERROR · ${sync.error}`, 'is-error'];
  if (sync.at) return [`SYNCED · ${new Date(sync.at).toLocaleTimeString()}`, ''];
  if (sync.online) return ['CONNECTED', ''];
  return ['CONNECTING…', ''];
}

function syncStatusText() {
  return syncView()[0];
}

function paintSync() {
  const [text, cls] = syncView();
  const badge = document.getElementById('syncState');
  if (badge) {
    badge.textContent = `SERVER · ${text}`;
    badge.className = `foot-sync ${cls}`;
  }
  const line = document.getElementById('settingsSync');
  if (line) line.textContent = text;
}

/* ---------------- transport ---------------- */

async function api(path, init) {
  const res = await fetch(SYNC_API + path, { cache: 'no-store', ...init });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

async function probe() {
  try {
    sync.online = (await fetch(`${SYNC_API}/health`, { cache: 'no-store' })).ok;
  } catch {
    sync.online = false;
  }
  paintSync();
  return sync.online;
}

/* ---------------- adopting ---------------- */

function modalOpen() {
  const root = document.getElementById('modalRoot');
  return !!root && !root.hidden;
}

// Rendering over an open modal would wipe what the user is typing, so the
// state is swapped now and the screen catches up on the next render.
function adopt(data) {
  if (!data || !data.state) return false;
  adopting = true;
  state = normalizeState(data.state);
  save();
  adopting = false;
  sync.error = '';
  sync.at = Date.now();
  if (!modalOpen()) renderAll();
  paintSync();
  return true;
}

/* ---------------- operations ---------------- */

async function push(silent) {
  clearTimeout(pushTimer);
  if (sync.online === false) {
    if (!silent) toast('No server reachable — changes stay in this browser.', 'danger');
    return;
  }

  sync.busy = true;
  paintSync();
  try {
    const res = await api('/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, updatedAt: Number((state.meta || {}).updatedAt) || Date.now() })
    });

    if (res.status === 409) {
      adopt(res.body);
      toast('The server held a newer record — this browser took that copy.', 'gold');
    } else if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    } else {
      sync.online = true;
      sync.error = '';
      sync.at = Date.now();
      if (!silent) toast('Record pushed to the server.', 'gold');
    }
  } catch (err) {
    // Network failure: keep working locally and retry when the server returns.
    sync.online = false;
    if (!silent) toast(`Push failed: ${err.message}`, 'danger');
  }
  sync.busy = false;
  paintSync();
}

async function pull() {
  if (sync.online === false) {
    toast('No server reachable — still running from this browser.', 'danger');
    return;
  }
  if (!confirm('Replace the data in this browser with the server copy?')) return;

  try {
    const res = await api('/state');
    if (res.status === 404) {
      toast('The server has no saved record yet.', 'danger');
    } else if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    } else if (adopt(res.body)) {
      toast('Record pulled from the server.', 'gold');
    }
  } catch (err) {
    sync.online = false;
    toast(`Pull failed: ${err.message}`, 'danger');
  }
  paintSync();
}

/* Called by save(): rapid taps become one request. */
function schedulePush() {
  if (adopting) return;
  clearTimeout(pushTimer);
  if (sync.online === false) return;
  pushTimer = setTimeout(() => push(true), 900);
}

/* ---------------- boot & recovery ---------------- */

async function initSync() {
  paintSync();
  if (!(await probe())) return;

  try {
    const res = await api('/state');
    const localAt = Number((state.meta || {}).updatedAt) || 0;
    const remoteAt = res.body ? Number(res.body.updatedAt) || 0 : 0;

    if (res.ok && remoteAt > localAt) {
      adopt(res.body);
      toast('Loaded your record from the server.', 'gold');
    } else if (res.ok || res.status === 404) {
      push(true);
    }
  } catch (err) {
    sync.error = err.message;
    paintSync();
  }
}

// Reconnect after the server or the network came back.
async function retrySync() {
  if (sync.busy) return;
  if (sync.online === true && !sync.error) return;
  if (await probe()) push(true);
}

window.addEventListener('online', retrySync);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) retrySync();
});

// Another tab wrote a newer copy: adopt it instead of clobbering it later.
window.addEventListener('storage', (e) => {
  if (e.key !== STORE_KEY || !e.newValue) return;
  let next;
  try {
    next = JSON.parse(e.newValue);
  } catch {
    return;
  }
  const theirs = Number(((next && next.meta) || {}).updatedAt) || 0;
  const ours = Number((state.meta || {}).updatedAt) || 0;
  if (theirs > ours) adopt({ state: next });
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (el.dataset.act === 'sync-push') push(false);
  else if (el.dataset.act === 'sync-pull') pull();
});

initSync();
