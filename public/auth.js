'use strict';

/* ======================================================================
   Accounts — email + password, Google, or a local-only guest session.
   ----------------------------------------------------------------------
   A real session (HttpOnly cookie) lets the record sync across devices.
   Guest mode keeps everything in this browser only.
   ====================================================================== */

const LAST_USER_KEY = 'system-fitness-user';
const GUEST_KEY = 'system-fitness-guest';

const auth = {
  user: null,
  checked: false,
  offline: false,
  guest: false,
  config: { google: false, push: false },
  mode: 'signin',
  busy: false,
  notice: ''
};

function authUser() {
  return auth.user;
}

function authAccountLabel() {
  if (auth.user) return `Signed in as ${auth.user.name || auth.user.email} (${auth.user.email}). Your record syncs to every device you sign in on.`;
  if (auth.guest) return 'Using this device without an account. Everything stays in this browser.';
  return 'Not signed in.';
}

function authNotice(text) {
  auth.notice = text;
  renderAuthScreen();
}

/* ---------------- screen ---------------- */

function renderAuthScreen() {
  const screen = document.getElementById('authScreen');
  if (!screen) return;
  const blocked = auth.checked && !auth.user && !auth.guest;
  screen.hidden = !blocked;
  document.body.classList.toggle('is-locked', blocked);
  if (!blocked) {
    // The first-run height/weight/goal ask waits until access is settled.
    if (auth.checked && typeof maybeOpenProfileSetup === 'function') maybeOpenProfileSetup();
    return;
  }

  const signin = document.querySelector('[data-auth-form="signin"]');
  const signup = document.querySelector('[data-auth-form="signup"]');
  if (signin) signin.hidden = auth.mode !== 'signin';
  if (signup) signup.hidden = auth.mode !== 'signup';
  $$('[data-auth-tab]').forEach((tab) => tab.classList.toggle('on', tab.dataset.authTab === auth.mode));

  const google = document.getElementById('authGoogle');
  if (google) {
    google.hidden = !auth.config.google;
    if (!auth.config.google) {
      const hint = document.getElementById('authGoogleHint');
      if (hint) hint.hidden = false;
    }
  }

  const note = document.getElementById('authError');
  if (note) {
    note.hidden = !auth.notice;
    note.textContent = auth.notice || '';
  }

  const busy = document.getElementById('authBusy');
  if (busy) busy.hidden = !auth.busy;
}

function setAuthMode(mode) {
  auth.mode = mode === 'signup' ? 'signup' : 'signin';
  auth.notice = '';
  renderAuthScreen();
}

/* ---------------- session ---------------- */

async function loadAuthConfig() {
  try {
    const res = await fetch('/api/auth/config', { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!res.ok) return;
    const data = await res.json();
    auth.config = { google: !!data.google, push: !!data.push };
  } catch {
    /* offline: defaults keep the email form available */
  }
}

async function loadSession() {
  try {
    const res = await fetch('/api/auth/session', { cache: 'no-store', headers: { Accept: 'application/json' } });
    const data = await res.json().catch(() => null);
    auth.user = (data && data.user) || null;
    auth.checked = true;
    if (auth.user) {
      auth.guest = false;
      localStorage.setItem(LAST_USER_KEY, auth.user.id);
    }
    return auth.user;
  } catch {
    auth.offline = true;
    auth.checked = true;
    return null;
  }
}

/* Boot: decide between a session, guest mode and the locked gate. */
async function bootAuth() {
  await loadAuthConfig();
  await loadSession();
  if (!auth.user) auth.guest = localStorage.getItem(GUEST_KEY) === '1';
  renderAuthScreen();
  if (typeof renderAll === 'function') renderAll();
}

function resetLocalRecord() {
  if (typeof sync !== 'undefined') sync.suspend = true;
  state = defaultState();
  // A different account starts its own hunt today, with the tour pending.
  state.meta = { updatedAt: 0, startedAt: todayKey(), tourDone: false };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    /* private mode */
  }
  if (typeof sync !== 'undefined') sync.suspend = false;
  if (typeof renderAll === 'function') renderAll();
}

/* A different account signing in on this device must never inherit the
   previous hunter's local cache. */
function applyUser(user) {
  const previous = localStorage.getItem(LAST_USER_KEY);
  const wasGuest = auth.guest;
  auth.user = user;
  auth.guest = false;
  auth.checked = true;
  auth.notice = '';
  localStorage.removeItem(GUEST_KEY);
  if (user) {
    const sameUser = previous === user.id;
    if (!sameUser && (previous || !wasGuest)) resetLocalRecord();
    localStorage.setItem(LAST_USER_KEY, user.id);
  }
  renderAuthScreen();
}

async function submitAuth(mode, form) {
  if (auth.busy) return;
  const data = new FormData(form);
  const payload = {
    email: String(data.get('email') || '').trim(),
    password: String(data.get('password') || '')
  };
  if (mode === 'signup') payload.name = String(data.get('name') || '').trim();

  auth.busy = true;
  auth.notice = '';
  renderAuthScreen();

  try {
    const res = await fetch(mode === 'signup' ? '/api/auth/signup' : '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !body.user) {
      auth.notice = (body && body.error) || `Could not sign in (HTTP ${res.status}).`;
      return;
    }
    applyUser(body.user);
    form.reset();
    toast(`Access granted. Welcome, ${body.user.name}.`, 'gold');
    if (typeof afterAuthChange === 'function') afterAuthChange();
  } catch {
    auth.notice = 'No connection to the server. Check your network and try again.';
  } finally {
    auth.busy = false;
    renderAuthScreen();
  }
}

async function authSignOut() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {
    /* the cookie is cleared server-side when it can be reached */
  }
  auth.user = null;
  auth.guest = false;
  auth.checked = true;
  renderAuthScreen();
  if (typeof closeModal === 'function') closeModal();
  if (typeof paintSync === 'function') paintSync();
  if (typeof toast === 'function') toast('Signed out. This device keeps its local copy.');
}

function useAsGuest() {
  auth.guest = true;
  auth.notice = '';
  localStorage.setItem(GUEST_KEY, '1');
  renderAuthScreen();
  if (typeof paintSync === 'function') paintSync();
  if (typeof afterAuthChange === 'function') afterAuthChange();
}

/* ---------------- wiring ---------------- */

document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-auth-tab]');
  if (tab) {
    setAuthMode(tab.dataset.authTab);
    return;
  }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (el.dataset.act === 'auth-guest') useAsGuest();
  else if (el.dataset.act === 'auth-signout') authSignOut();
  else if (el.dataset.act === 'auth-open') {
    auth.checked = true;
    auth.guest = false;
    auth.mode = 'signin';
    localStorage.removeItem(GUEST_KEY);
    renderAuthScreen();
    if (typeof closeModal === 'function') closeModal();
  }
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-auth-form]');
  if (!form) return;
  e.preventDefault();
  submitAuth(form.dataset.authForm, form);
});

/* A Google redirect that failed comes back as ?auth=… */
(function authQueryNotice() {
  const params = new URLSearchParams(location.search);
  const code = params.get('auth');
  if (!code) return;
  const messages = {
    'google-failed': 'Google sign-in did not complete. Try again, or use your email and password.',
    'google-unavailable': 'Google sign-in is not configured on this deployment.',
    'google-linked': 'Google connected. You can now sign in with either Google or your password.',
    'google-in-use': 'That Google account is already attached to a different account here.',
    'link-session': 'The sign-in expired before Google answered. Sign in again, then connect Google.',
    'signin-required': 'Sign in first, then connect Google from Settings.',
    'state-mismatch': 'That sign-in link expired. Try again.'
  };
  auth.notice = messages[code] || 'Sign-in did not complete.';
  auth.checked = true;
  history.replaceState(null, '', location.pathname);
  renderAuthScreen();
})();
