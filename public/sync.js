'use strict';

/* ======================================================================
   Backend sync
   ----------------------------------------------------------------------
   The server keeps the canonical record for the signed-in account;
   localStorage stays the offline cache, so the app keeps working with the
   server down or closed.

   Conflict rule: a stale write is answered with 409 + the server's copy.
   The two copies are then merged (merge.js) instead of one being dropped:
   days, sets and entries are unioned, and the later copy wins the scalars.
   The losing copy is kept in a .conflict key so nothing is ever lost.

   Access: every API call carries the session cookie. A 401 reopens the
   sign-in screen and the app continues from the local copy.
   ====================================================================== */

const SYNC_API = '/api';

const sync = { online: null, busy: false, at: 0, error: '', suspend: false, queued: false };
let pushTimer = null;
let adopting = false;

/* ---------------- status ---------------- */

function canSync() {
  return !!(typeof auth !== 'undefined' && auth.user);
}

function syncView() {
  if (typeof auth !== 'undefined' && auth.checked && !auth.user) {
    return auth.guest ? ['LOCAL ONLY · GUEST', 'is-offline'] : ['SIGN IN REQUIRED', 'is-error'];
  }
  if (sync.busy) return ['SYNCING…', ''];
  if (sync.queued) return ['SAVED HERE · WAITING FOR NETWORK', 'is-offline'];
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

function onUnauthorized() {
  if (typeof auth === 'undefined') return;
  auth.user = null;
  auth.checked = true;
  if (typeof renderAuthScreen === 'function') renderAuthScreen();
  paintSync();
}

async function api(path, init) {
  const res = await fetch(SYNC_API + path, { cache: 'no-store', ...init });
  const body = await res.json().catch(() => null);
  if (res.status === 401) onUnauthorized();
  return { ok: res.ok, status: res.status, body };
}

/* ---------------- offline outbox ----------------
   When the server cannot be reached, the newest snapshot is handed to the
   service worker (sw.js), which replays it on reconnect or through
   Background Sync — even if this tab was closed first. The local record was
   already saved, so nothing is lost by the page going away. */

function serviceWorkerReady() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return Promise.resolve(null);
  return navigator.serviceWorker.ready.then((reg) => reg).catch(() => null);
}

async function queueOutbox(body) {
  sync.queued = true;
  try {
    const reg = await serviceWorkerReady();
    if (!reg || !reg.active) return;
    reg.active.postMessage({ type: 'outbox-put', body });
    if (reg.sync && reg.sync.register) {
      reg.sync.register('system-outbox').catch(() => { /* no Background Sync */ });
    }
  } catch (err) {
    /* no service worker: the retry-on-reconnect path still covers this tab */
  }
}

async function clearOutbox() {
  sync.queued = false;
  try {
    const reg = await serviceWorkerReady();
    if (reg && reg.active) reg.active.postMessage({ type: 'outbox-clear' });
  } catch (err) {
    /* ignore */
  }
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
  if (typeof ensureStartDate === 'function') ensureStartDate();
  save();
  adopting = false;
  sync.error = '';
  sync.at = Date.now();
  if (!modalOpen()) renderAll();
  paintSync();
  return true;
}

/* A stale write means another device wrote while this one was offline. Both
   records hold real work, so they are merged; the server's copy is also kept
   in localStorage as `<key>.conflict` in case a merge ever looks wrong. */
function mergeConflict(remote) {
  if (!remote || !remote.state) return false;
  try {
    localStorage.setItem(`${STORE_KEY}.conflict`, JSON.stringify(remote));
  } catch {
    /* private mode */
  }
  const merged = typeof mergeStates === 'function' ? mergeStates(state, remote.state) : remote.state;
  adopting = true;
  state = normalizeState(merged);
  if (typeof ensureStartDate === 'function') ensureStartDate();
  save();
  adopting = false;
  sync.error = '';
  sync.at = Date.now();
  if (!modalOpen()) renderAll();
  paintSync();
  toast('Two devices had new work — both records were merged, nothing lost.', 'gold');
  return true;
}

/* ---------------- operations ---------------- */

async function push(silent) {
  clearTimeout(pushTimer);
  if (!canSync() || sync.suspend) return;
  if (sync.online === false) {
    if (!silent) toast('No server reachable — changes stay in this browser.', 'danger');
    return;
  }

  sync.busy = true;
  paintSync();
  const payload = JSON.stringify({ state, updatedAt: Number((state.meta || {}).updatedAt) || Date.now() });
  try {
    const res = await api('/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });

    if (res.status === 409) {
      mergeConflict(res.body);
    } else if (res.status === 401) {
      if (!silent) toast('Sign in again to save to the server.', 'danger');
    } else if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    } else {
      sync.online = true;
      sync.error = '';
      sync.at = Date.now();
      clearOutbox();
      if (!silent) toast('Record pushed to the server.', 'gold');
    }
  } catch (err) {
    // Network failure: keep working locally, and leave the snapshot with the
    // service worker so it is replayed even if this tab is closed first.
    sync.online = false;
    queueOutbox(payload);
    if (!silent) toast(`Push failed: ${err.message}. Saved here — the server copy catches up on reconnect.`, 'danger');
  }
  sync.busy = false;
  paintSync();
}

async function pull() {
  if (!canSync()) {
    toast('Sign in first, then the server copy can be pulled.', 'danger');
    return;
  }
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
      if (res.status !== 401) throw new Error(`HTTP ${res.status}`);
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
  if (adopting || sync.suspend || !canSync()) return;
  clearTimeout(pushTimer);
  if (sync.online === false) return;
  pushTimer = setTimeout(() => push(true), 900);
}

/* ---------------- boot & recovery ---------------- */

/* The server copy is the truth for a signed-in account; a local copy only
   wins when it is genuinely newer (work done offline). */
async function loadFromServer(silent) {
  try {
    const res = await api('/state');
    const localAt = Number((state.meta || {}).updatedAt) || 0;
    const remoteAt = res.ok && res.body ? Number(res.body.updatedAt) || 0 : 0;

    if (res.ok && remoteAt >= localAt && remoteAt > 0) {
      adopt(res.body);
      if (!silent) toast('Your record is synced from the server.', 'gold');
    } else if (res.ok && remoteAt < localAt) {
      push(true);
    } else if (res.status === 404) {
      push(true);
    }
  } catch (err) {
    sync.error = err.message;
    paintSync();
  }
}

async function initSync() {
  paintSync();
  await bootAuth();
  paintSync();
  if (!canSync()) return;
  if (!(await probe())) return;
  await loadFromServer(true);
  if (typeof loadPushConfig === 'function') {
    await loadPushConfig();
    pushTick(false);
  }
}

/* Sign-in, sign-up, sign-out and guest mode all land here. */
async function afterAuthChange() {
  sync.online = null;
  sync.error = '';
  paintSync();
  if (!canSync()) return;
  if (!(await probe())) return;
  await loadFromServer(false);
  if (typeof loadPushConfig === 'function') {
    await loadPushConfig();
    pushTick(true);
  }
  // A fresh account gets the walkthrough once the profile step is out of the way.
  if (typeof maybeStartTour === 'function') maybeStartTour();
}

// Reconnect after the server or the network came back.
async function retrySync() {
  if (sync.busy || !canSync()) return;
  if (!auth.checked) await bootAuth();
  if (sync.online === true && !sync.error && !sync.queued) return;
  if (await probe()) push(true);
}

window.addEventListener('online', retrySync);

// The worker replayed a queued snapshot while this page was open.
if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'outbox-flushed') {
      sync.queued = false;
      sync.online = true;
      sync.at = Date.now();
      paintSync();
      toast('Queued changes reached the server.', 'gold');
    }
  });
}
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
