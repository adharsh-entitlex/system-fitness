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
  config: { google: false, push: false, mail: false },
  mode: 'signin',
  busy: false,
  notice: '',
  resetToken: ''
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
    auth.config = { google: !!data.google, push: !!data.push, mail: !!data.mail };
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
    if (body.verify === 'sent') toast('Check your inbox to confirm the address.', 'gold');
    else if (body.verify === 'unconfigured') toast('Account created. Email confirmation is unavailable on this deployment.', 'gold');
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

/* ---------------- account menu, recovery, devices ---------------- */

function accountStatusHtml() {
  if (!auth.user) {
    return auth.guest
      ? 'This device is running without an account. Create one to carry the record to other devices.'
      : 'Not signed in.';
  }
  const bits = [esc(auth.user.email)];
  if (!auth.user.hasPassword) bits.push('Google only');
  bits.push(auth.user.verified ? 'email confirmed' : 'email not confirmed');
  return `Signed in as ${bits.join(' · ')}`;
}

function openAccountMenu() {
  if (typeof openModal !== 'function') return;
  openModal(`
    <h2>ACCOUNT</h2>
    <div class="sub">${auth.user ? `Signed in as ${esc(auth.user.name || auth.user.email)}` : 'Not signed in'}</div>
    <p class="panel-sub" style="margin:0 0 12px;line-height:1.6">${accountStatusHtml()}</p>
    ${auth.user && !auth.user.verified
      ? `<p class="auth-hint" style="margin:0 0 12px;line-height:1.6">${auth.config.mail ? 'Confirm the address to make password recovery and Google linking safe.' : 'Email delivery is not configured on this deployment, so confirmation is unavailable.'}</p>`
      : ''}
    <div class="modal-actions" style="justify-content:flex-start;flex-wrap:wrap">
      ${auth.user
        ? `<button class="btn" data-act="account-devices">SIGNED-IN DEVICES</button>
           <button class="btn ghost" data-act="auth-signout">SIGN OUT</button>
           ${auth.user.verified ? '' : '<button class="btn ghost" data-act="account-verify">CONFIRM EMAIL</button>'}`
        : '<button class="btn primary" data-act="auth-open">SIGN IN</button>'}
      <button class="btn ghost" data-act="account-forgot">FORGOT PASSWORD</button>
      <button class="btn ghost" data-act="modal-close">CLOSE</button>
    </div>
    ${auth.config.mail ? '' : '<p class="panel-sub" style="margin:12px 0 0;font-size:12px;line-height:1.6">Password reset by email needs RESEND_API_KEY or POSTMARK_TOKEN set on the server.</p>'}
  `);
}

async function forgotPassword() {
  const email = window.prompt('Enter the email on the account. A reset link is sent if the address exists.', auth.user ? auth.user.email : '');
  if (!email) return;
  try {
    const res = await fetch('/api/auth/password/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: String(email).trim() })
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      toast((body && body.error) || `Could not send the link (HTTP ${res.status}).`, 'danger');
      return;
    }
    toast(
      body && body.mail === 'unconfigured'
        ? 'Email is not configured on this server, so no link could be sent.'
        : 'If that address has an account, a reset link is on its way.',
      'gold'
    );
  } catch {
    toast('No connection to the server.', 'danger');
  }
}

async function resendVerification() {
  if (!auth.user) { toast('Sign in first.', 'danger'); return; }
  try {
    const res = await fetch('/api/auth/verify/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      toast((body && body.error) || 'Could not send the confirmation.', 'danger');
      return;
    }
    toast('Confirmation sent. Open the link in that inbox.', 'gold');
  } catch {
    toast('No connection to the server.', 'danger');
  }
}

async function resetPassword() {
  const input = document.querySelector('[data-reset-password]');
  const password = String(input ? input.value : '');
  if (password.length < 8) { toast('Use a password with at least 8 characters.', 'danger'); return; }
  try {
    const res = await fetch('/api/auth/password/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: auth.resetToken, password })
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !body.user) {
      toast((body && body.error) || 'That link did not work. Ask for a new one.', 'danger');
      return;
    }
    auth.resetToken = '';
    applyUser(body.user);
    if (typeof closeModal === 'function') closeModal();
    toast('Password changed. Every other device was signed out.', 'gold');
    if (typeof afterAuthChange === 'function') afterAuthChange();
    history.replaceState(null, '', location.pathname);
  } catch {
    toast('No connection to the server.', 'danger');
  }
}

function openResetForm() {
  if (typeof openModal !== 'function') return;
  openModal(`
    <h2>SET A NEW PASSWORD</h2>
    <div class="sub">The link is single-use and expires after 30 minutes.</div>
    <label class="field"><span class="lbl">NEW PASSWORD (8+ CHARACTERS)</span>
      <input type="password" minlength="8" autocomplete="new-password" data-reset-password />
    </label>
    <div class="modal-actions">
      <button class="btn primary" data-act="reset-save">SAVE PASSWORD</button>
      <button class="btn ghost" data-act="modal-close">CANCEL</button>
    </div>
  `);
}

async function openDevices() {
  try {
    const res = await fetch('/api/auth/sessions', { cache: 'no-store' });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) { toast('Could not read the session list.', 'danger'); return; }
    const rows = (body.sessions || []).map((s) => {
      const when = s.created ? new Date(s.created).toLocaleString() : 'unknown time';
      const agent = s.userAgent ? s.userAgent.split(')')[0] + ')' : 'unknown device';
      return `<li class="set-row"><span class="set-no">${s.current ? 'THIS DEVICE' : 'DEVICE'}</span>
        <span class="set-val">${esc(agent)} · ${esc(when)}</span></li>`;
    }).join('');
    openModal(`
      <h2>SIGNED-IN DEVICES</h2>
      <div class="sub">Sessions last 30 days. Signing out everywhere keeps this device signed in.</div>
      ${rows ? `<ul class="set-list">${rows}</ul>` : '<div class="empty">No live sessions found.</div>'}
      <div class="modal-actions">
        <button class="btn danger" data-act="account-revoke">SIGN OUT EVERYWHERE</button>
        <button class="btn ghost" data-act="modal-close">CLOSE</button>
      </div>
    `);
  } catch {
    toast('No connection to the server.', 'danger');
  }
}

async function revokeOtherSessions() {
  try {
    const res = await fetch('/api/auth/sessions/revoke-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!res.ok) { toast('Could not sign the other devices out.', 'danger'); return; }
    toast('Every other device was signed out.', 'gold');
    openDevices();
  } catch {
    toast('No connection to the server.', 'danger');
  }
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
  else if (el.dataset.act === 'account-menu') openAccountMenu();
  else if (el.dataset.act === 'account-devices') openDevices();
  else if (el.dataset.act === 'account-forgot' || el.dataset.act === 'forgot-password') forgotPassword();
  else if (el.dataset.act === 'account-verify') resendVerification();
  else if (el.dataset.act === 'account-revoke') revokeOtherSessions();
  else if (el.dataset.act === 'reset-save') resetPassword();
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
  const reset = params.get('reset');
  if (reset) {
    auth.resetToken = reset;
    history.replaceState(null, '', location.pathname);
    setTimeout(() => openResetForm(), 300);
    return;
  }
  const messages = {
    'email-verified': 'Email confirmed. Password recovery and Google linking are now safe to use.',
    'verify-failed': 'That confirmation link expired or was already used. Ask for a new one from the account menu.',
    'google-link-required': 'That email already has a password account. Sign in with it, then connect Google in Settings.',
    'google-unverified': 'Google did not confirm that email address, so sign-in was refused.',
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
