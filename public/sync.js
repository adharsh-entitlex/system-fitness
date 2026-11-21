'use strict';

/* ======================================================================
   Backend sync + account
   ----------------------------------------------------------------------
   The server keeps the canonical record; localStorage stays the offline
   cache, so the app keeps working with the server down or closed.

   Conflict rule: last write wins on meta.updatedAt. Anything newer than
   this tab — another tab, a device, the server — is adopted rather than
   overwritten, and the server answers a stale write with 409 + its copy.

   Access: the record belongs to the first Freebuff account that signs in.
   Every API call carries the session cookie; a 401 shows the sign-in gate
   and a 403 from another account explains whose record this is.
   ====================================================================== */

const SYNC_API = '/api';
const AUTH_SESSION = '/auth/freebuff/session';

const sync = { online: null, busy: false, at: 0, error: '' };
const account = { user: null, checked: false, denied: false, owner: '' };
let pushTimer = null;
let adopting = false;

/* ---------------- status ---------------- */

function canSync() {
  return !(account.checked && (!account.user || account.denied));
}

function syncView() {
  if (!canSync()) return ['SIGN IN REQUIRED', 'is-error'];
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

/* ---------------- account ---------------- */

function accountLabel() {
  if (!account.checked) return 'Checking your Freebuff session…';
  if (account.denied) return `This SYSTEM belongs to ${account.owner || 'another Freebuff account'}. Sign out and sign in with that account.`;
  if (account.user) {
    const who = account.user.email || account.user.name || 'your Freebuff account';
    return `Signed in as ${who}. Only this account can read or write the record.`;
  }
  return 'Signed out. Sign in to sync this record across your devices.';
}

function renderGate() {
  const gate = document.getElementById('authGate');
  if (!gate) return;
  const blocked = account.checked && (!account.user || account.denied);
  gate.hidden = !blocked;
  if (!blocked) return;

  const text = document.getElementById('gateText');
  const signIn = document.getElementById('gateSignIn');
  if (account.denied) {
    if (text) text.textContent = `This SYSTEM belongs to ${account.owner || 'another Freebuff account'}. Sign out and sign in with that account.`;
    if (signIn) signIn.hidden = true;
  } else {
    if (text) text.textContent = 'Sign in with your Freebuff account to open your record. Everything you logged on this device is still here.';
    if (signIn) signIn.hidden = false;
  }
  const line = document.getElementById('settingsAccount');
  if (line) line.textContent = accountLabel();
}

function lockOut(denied, owner) {
  account.user = null;
  account.checked = true;
  account.denied = denied;
  if (owner) account.owner = owner;
  renderGate();
  paintSync();
}

async function loadAccount() {
  try {
    const res = await fetch(AUTH_SESSION, { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    account.user = (data && data.user) || null;
    account.checked = true;
    account.denied = false;
    renderGate();
    paintSync();
    return account.user;
  } catch {
    // Offline: keep working from the local cache with whatever we knew.
    return null;
  }
}

/* ---------------- transport ---------------- */

async function api(path, init) {
  const res = await fetch(SYNC_API + path, { cache: 'no-store', ...init });
  const body = await res.json().catch(() => null);
  if (res.status === 401) lockOut(false);
  else if (res.status === 403 && body && body.error === 'owner only') lockOut(true, body.owner);
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
  if (!canSync()) return;
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
    } else if (res.status === 401 || res.status === 403) {
      if (!silent) toast('Sign in as the owner account to save to the server.', 'danger');
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
  if (!canSync()) {
    toast('Sign in with your Freebuff account first.', 'danger');
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
      if (res.status !== 401 && res.status !== 403) throw new Error(`HTTP ${res.status}`);
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
  if (adopting || !canSync()) return;
  clearTimeout(pushTimer);
  if (sync.online === false) return;
  pushTimer = setTimeout(() => push(true), 900);
}

/* ---------------- boot & recovery ---------------- */

async function initSync() {
  paintSync();
  await loadAccount();
  if (!canSync()) {
    paintSync();
    return;
  }
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
  if (sync.busy || !canSync()) return;
  if (!account.checked) await loadAccount();
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
