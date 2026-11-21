'use strict';

/* ======================================================================
   Backend sync
   ----------------------------------------------------------------------
   server/server.mjs keeps the canonical record in data/state.json.
   localStorage stays the offline cache, so the app still works when the
   page is opened straight from disk or the server is unreachable.

   Conflict rule: last write wins on each side's updatedAt timestamp.
   ====================================================================== */

const API_BASE = '/api';

const sync = {
  online: false,
  busy: false,
  lastPushedAt: 0,
  lastError: ''
};

let pushTimer = null;
let suppressPush = false;

/* ---------------- status ---------------- */

function syncStatus() {
  if (sync.busy) return { text: 'SYNCING…', cls: '' };
  if (!sync.online) return { text: 'LOCAL ONLY · START THE SERVER FOR SERVER SAVE', cls: 'is-offline' };
  if (sync.lastError) return { text: `SYNC ERROR · ${sync.lastError}`, cls: 'is-error' };
  if (sync.lastPushedAt) return { text: `SYNCED · ${new Date(sync.lastPushedAt).toLocaleTimeString()}`, cls: '' };
  return { text: 'CONNECTED · SERVER READY', cls: '' };
}

function syncStatusText() {
  return syncStatus().text;
}

function paintSyncBadge() {
  const el = document.getElementById('syncState');
  if (!el) return;
  const s = syncStatus();
  el.textContent = `SERVER · ${s.text}`;
  el.classList.toggle('is-offline', s.cls === 'is-offline');
  el.classList.toggle('is-error', s.cls === 'is-error');
}

function refreshSettingsStatus() {
  const el = document.getElementById('settingsSync');
  if (el) el.textContent = syncStatusText();
}

/* ---------------- transport ---------------- */

async function apiJson(path, options) {
  const res = await fetch(`${API_BASE}${path}`, {
    cache: 'no-store',
    ...options,
    headers: { Accept: 'application/json', ...((options && options.headers) || {}) }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ---------------- operations ---------------- */

async function pushToServer(silent) {
  if (!sync.online) {
    if (!silent) toast('Backend not reachable. Start it with "npm start" and open the app from its address.', 'danger');
    return;
  }
  sync.busy = true;
  paintSyncBadge();
  try {
    await apiJson('/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, updatedAt: (state.meta || {}).updatedAt || Date.now() })
    });
    sync.lastPushedAt = Date.now();
    sync.lastError = '';
    if (!silent) toast('Record pushed to the server.', 'gold');
  } catch (err) {
    sync.lastError = err.message;
    if (!silent) toast(`Push failed: ${err.message}`, 'danger');
  }
  sync.busy = false;
  paintSyncBadge();
  refreshSettingsStatus();
}

/* Adopting the server copy must not immediately push it back. */
async function adoptServerState(record) {
  suppressPush = true;
  state = normalizeState(record.state);
  save();
  suppressPush = false;
  renderAll();
}

async function pullNow() {
  if (!sync.online) {
    toast('Backend not reachable. Start it with "npm start".', 'danger');
    return;
  }
  if (!confirm('Replace the data in this browser with the server copy?')) return;
  sync.busy = true;
  paintSyncBadge();
  try {
    const record = await apiJson('/state');
    if (!record || !record.state) {
      toast('The server has no saved record yet.', 'danger');
      return;
    }
    await adoptServerState(record);
    sync.lastPushedAt = Date.now();
    sync.lastError = '';
    toast('Record pulled from the server.', 'gold');
  } catch (err) {
    sync.lastError = err.message;
    toast(`Pull failed: ${err.message}`, 'danger');
  } finally {
    sync.busy = false;
    paintSyncBadge();
    refreshSettingsStatus();
  }
}

/* Debounced by save(), so rapid tick-tapping becomes one request. */
function schedulePush() {
  if (!sync.online || suppressPush) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushToServer(true), 900);
}

/* ---------------- boot ---------------- */

async function initSync() {
  paintSyncBadge();
  try {
    const health = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
    sync.online = health.ok;
  } catch (err) {
    sync.online = false;
  }
  if (!sync.online) {
    paintSyncBadge();
    return;
  }

  try {
    const record = await apiJson('/state');
    const localAt = Number((state.meta || {}).updatedAt) || 0;
    const remoteAt = record ? Number(record.updatedAt) || 0 : 0;
    if (record && record.state && remoteAt > localAt) {
      await adoptServerState(record);
      sync.lastPushedAt = Date.now();
      toast('Loaded your record from the server.', 'gold');
    } else {
      await pushToServer(true);
    }
  } catch (err) {
    sync.lastError = err.message;
  }
  paintSyncBadge();
  refreshSettingsStatus();
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (el.dataset.act === 'sync-push') pushToServer(false);
  else if (el.dataset.act === 'sync-pull') pullNow();
});

initSync();
