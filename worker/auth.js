/* ======================================================================
   Accounts for THE SYSTEM
   ----------------------------------------------------------------------
   Email + password (PBKDF2-SHA256, per-user salt) and Google sign-in.
   Sessions are random 32-byte tokens; only the SHA-256 of the token is
   stored, in an HttpOnly SameSite=Lax cookie.

   Google is optional: it activates when GOOGLE_CLIENT_ID and
   GOOGLE_CLIENT_SECRET are set, and /api/auth/config tells the client
   whether to show the button.
   ====================================================================== */

const encoder = new TextEncoder();

export const SESSION_COOKIE = 'sys_session';
export const OAUTH_COOKIE = 'sys_oauth';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const PBKDF2_ROUNDS = 100000;

/* ---------------- encodings ---------------- */

export function b64uEncode(bytes) {
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(value) {
  const raw = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = raw + (raw.length % 4 ? '='.repeat(4 - (raw.length % 4)) : '');
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomToken(bytes = 32) {
  return b64uEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  const x = encoder.encode(String(a));
  const y = encoder.encode(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/* ---------------- passwords ---------------- */

async function pbkdf2(password, saltBytes) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: PBKDF2_ROUNDS },
    key,
    256
  );
  return b64uEncode(new Uint8Array(bits));
}

export async function hashPassword(password) {
  const salt = b64uEncode(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, hash: await pbkdf2(password, b64uDecode(salt)) };
}

export async function verifyPassword(password, salt, expected) {
  if (!salt || !expected) return false;
  return safeEqual(await pbkdf2(password, b64uDecode(salt)), expected);
}

/* ---------------- validation ---------------- */

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function emailProblem(email) {
  if (!email) return 'Enter your email address.';
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return 'That email address does not look right.';
  if (email.length > 190) return 'That email address is too long.';
  return '';
}

export function passwordProblem(password) {
  if (!password || password.length < 8) return 'Use a password with at least 8 characters.';
  if (password.length > 200) return 'That password is too long.';
  return '';
}

/* ---------------- cookies ---------------- */

export function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return null;
}

function secureOrigin(env) {
  return !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(env.APP_ORIGIN || '');
}

export function sessionCookie(env, token, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`
  ];
  if (secureOrigin(env)) parts.push('Secure');
  return parts.join('; ');
}

export function oauthCookie(env, value) {
  const parts = [`${OAUTH_COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=600'];
  if (secureOrigin(env)) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie(env, name) {
  const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secureOrigin(env)) parts.push('Secure');
  return parts.join('; ');
}

/* ---------------- sessions ---------------- */

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name || row.email.split('@')[0],
    avatar: row.avatar || null,
    hasPassword: !!row.pass_hash,
    google: !!row.google_sub
  };
}

export async function createSession(env, userId) {
  const token = randomToken();
  const id = await sha256Hex(token);
  const expiresAt = Date.now() + SESSION_MS;
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, userId, expiresAt, new Date().toISOString())
    .run();
  return token;
}

export async function destroySession(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return;
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256Hex(token)).run();
}

export async function currentUser(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const id = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.avatar, u.pass_hash, u.google_sub, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`
  )
    .bind(id)
    .first();
  if (!row) return null;
  if (Number(row.expires_at) < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    return null;
  }
  return publicUser(row);
}

/* ---------------- users ---------------- */

export async function findUserByEmail(env, email) {
  return env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
}

export async function createUser(env, { email, name, password, googleSub, avatar }) {
  const id = 'u_' + randomToken(12).replace(/[^a-zA-Z0-9]/g, '').slice(0, 14);
  const creds = password ? await hashPassword(password) : { salt: null, hash: null };
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, pass_salt, pass_hash, google_sub, avatar, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, email, name || email.split('@')[0], creds.salt, creds.hash, googleSub || null, avatar || null, new Date().toISOString())
    .run();
  return publicUser(await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first());
}

export async function linkGoogle(env, userId, googleSub, avatar) {
  await env.DB.prepare('UPDATE users SET google_sub = ?, avatar = COALESCE(avatar, ?) WHERE id = ?')
    .bind(googleSub, avatar || null, userId)
    .run();
}

/* ---------------- google oauth ---------------- */

export function googleConfigured(env) {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function googleRedirectUri(origin) {
  return `${String(origin || '').replace(/\/$/, '')}/api/auth/google/callback`;
}

export function googleAuthUrl(env, state, origin) {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(origin),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account'
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function googleProfile(env, code, origin) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: googleRedirectUri(origin),
      grant_type: 'authorization_code'
    })
  });
  if (!res.ok) throw new Error(`google token exchange failed (${res.status})`);
  const data = await res.json();
  const idToken = data && data.id_token;
  if (!idToken) throw new Error('google returned no id_token');
  // The token came straight from Google over TLS in this same request, so the
  // claims are trusted without a second signature check.
  const claims = JSON.parse(new TextDecoder().decode(b64uDecode(idToken.split('.')[1])));
  if (!claims.sub || !claims.email) throw new Error('google profile incomplete');
  return {
    sub: claims.sub,
    email: normalizeEmail(claims.email),
    name: claims.name || claims.email.split('@')[0],
    avatar: claims.picture || null,
    verified: claims.email_verified !== false
  };
}
