/* ======================================================================
   THE SYSTEM — hosted backend (Cloudflare Worker + D1)
   ----------------------------------------------------------------------
   Per-user accounts, per-user records, an AI meal planner and device
   push notifications.

     GET  /api/health                  public
     GET  /api/auth/config             public: which sign-in methods exist
     POST /api/auth/signup             { email, password, name }
     POST /api/auth/login              { email, password }
     POST /api/auth/logout
     GET  /api/auth/session            { user } | { user: null }
     GET  /api/auth/google/start       (303 to Google when configured)
     GET  /api/auth/google/callback
     GET  /api/state                   this account's record
     PUT  /api/state                   { state, updatedAt }  (409 = stale)
     POST /api/ai/suggest              pantry-aware meal plan
     GET  /api/push/config             { publicKey } | { publicKey: null }
     POST /api/push/subscribe          { endpoint, keys }
     POST /api/push/unsubscribe        { endpoint }
     POST /api/push/test
     POST /api/push/tick               { drank, goal, hour, tzOffset }
     GET  /.well-known/assetlinks.json (public, for the Android app)

   Every /api route except auth and health requires a session, and every
   record is keyed by the session's user id, so one hunter can never read
   another hunter's record.
   ====================================================================== */

import {
  clearCookie,
  consumeToken,
  createSession,
  createUser,
  currentUser,
  destroyAllSessions,
  destroyOtherSessions,
  destroySession,
  emailProblem,
  findUserByEmail,
  googleAuthUrl,
  googleConfigured,
  googleProfile,
  issueToken,
  linkGoogle,
  listSessions,
  markEmailVerified,
  normalizeEmail,
  oauthCookie,
  OAUTH_COOKIE,
  passwordProblem,
  readCookie,
  sessionCookie,
  sessionIdFrom,
  setPassword,
  verifyPassword
} from './auth.js';
import { pushConfigured, pushUser } from './push.js';
import { aiFailureHint, cleanMeals, requestAi } from './ai.js';
import { mailConfigured, resetMessage, sendMail, verifyMessage } from './mail.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' };
const PUBLIC_JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const MAX_BODY = 4 * 1024 * 1024;
const AI_DAILY_LIMIT = 40;
const AI_IP_DAILY_LIMIT = 60;
const SESSION_SECONDS = 30 * 24 * 3600;

/* Injected by scripts/build-worker.mjs. A deployment that cannot say which
   commit it is running is how a stale build stayed live for two days. */
const COMMIT = typeof __SYSTEM_COMMIT__ === 'string' ? __SYSTEM_COMMIT__ : 'dev';
const BUILT_AT = typeof __SYSTEM_BUILT__ === 'string' ? __SYSTEM_BUILT__ : '';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     email TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     pass_salt TEXT,
     pass_hash TEXT,
     google_sub TEXT,
     avatar TEXT,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     expires_at INTEGER NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS records (
     user_id TEXT PRIMARY KEY,
     revision INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     saved_at TEXT NOT NULL,
     state TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS push_subs (
     endpoint TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     p256dh TEXT NOT NULL,
     auth TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs(user_id)`,
  `CREATE TABLE IF NOT EXISTS push_prefs (
     user_id TEXT PRIMARY KEY,
     enabled INTEGER NOT NULL,
     every_min INTEGER NOT NULL,
     tz_offset INTEGER NOT NULL,
     last_sent_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS ai_usage (
     user_id TEXT NOT NULL,
     day TEXT NOT NULL,
     count INTEGER NOT NULL,
     PRIMARY KEY (user_id, day)
   )`,
  `CREATE TABLE IF NOT EXISTS auth_tokens (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     expires_at INTEGER NOT NULL,
     used_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS auth_tokens_user ON auth_tokens(user_id)`,
  `CREATE TABLE IF NOT EXISTS throttle (
     key TEXT PRIMARY KEY,
     count INTEGER NOT NULL,
     reset_at INTEGER NOT NULL
   )`
];

/* Columns added after the first release. D1 has no ADD COLUMN IF NOT EXISTS,
   so a duplicate is expected on an up-to-date database and is ignored. */
const MIGRATIONS = [
  ['push_prefs', 'reminder_hour', 'INTEGER DEFAULT 20'],
  ['push_prefs', 'last_streak_at', 'INTEGER DEFAULT 0'],
  ['users', 'email_verified', 'INTEGER NOT NULL DEFAULT 0'],
  ['sessions', 'user_agent', 'TEXT']
];

let schemaReady = false;

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

function publicJson(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: PUBLIC_JSON_HEADERS });
}

function redirect(location, extraHeaders = {}) {
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store', ...extraHeaders } });
}

async function ensureSchema(db) {
  if (schemaReady) return;
  for (const statement of SCHEMA) await db.prepare(statement).run();
  for (const [table, column, type] of MIGRATIONS) {
    try {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
    } catch {
      /* the column already exists */
    }
  }
  schemaReady = true;
}

/* The hosted origin comes from APP_ORIGIN when set, otherwise from the
   request itself, so a deployment without that variable still works. */
function appOrigin(request, env) {
  const configured = String(env.APP_ORIGIN || '').trim().replace(/\/$/, '');
  return configured || new URL(request.url).origin;
}

/* Cookies are SameSite=Lax, so a cross-site POST cannot carry them; the
   Origin check is the second lock on every write. */
function sameOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return true; // same-origin form posts and curl rarely send it
  const allowed = new Set([appOrigin(request, env), new URL(request.url).origin]);
  return allowed.has(origin.replace(/\/$/, ''));
}

/* ---------------- abuse guard ----------------
   A fixed window counter in D1. Password hashing is deliberately expensive,
   so an unthrottled login loop is a CPU fire on the free plan, and the AI cap
   is per account, so unlimited accounts would mean unlimited spend. */

function clientIp(request) {
  return String(request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'local')
    .split(',')[0]
    .trim();
}

async function hitLimit(env, key, limit, windowMs) {
  const now = Date.now();
  const row = await env.DB.prepare('SELECT count, reset_at FROM throttle WHERE key = ?').bind(key).first();
  if (!row || now > Number(row.reset_at)) {
    await env.DB.prepare(
      `INSERT INTO throttle (key, count, reset_at) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = excluded.reset_at`
    )
      .bind(key, now + windowMs)
      .run();
    return { ok: true, left: limit - 1 };
  }
  if (Number(row.count) >= limit) return { ok: false, retryAt: Number(row.reset_at) };
  await env.DB.prepare('UPDATE throttle SET count = count + 1 WHERE key = ?').bind(key).run();
  return { ok: true, left: limit - Number(row.count) - 1 };
}

async function clearLimit(env, key) {
  await env.DB.prepare('DELETE FROM throttle WHERE key = ?').bind(key).run();
}

async function readBody(request) {
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) return { error: 'body too large', status: 413 };
  try {
    return { body: await request.json() };
  } catch {
    return { error: 'invalid JSON', status: 400 };
  }
}

/* ---------------- accounts ---------------- */

async function adoptLegacyRecord(env, userId) {
  // The single-record era kept its data in `record`. The first account to be
  // created inherits it so nothing that was already logged is lost.
  try {
    const legacy = await env.DB.prepare(
      'SELECT revision, updated_at, saved_at, state FROM record WHERE id = ?'
    )
      .bind('main')
      .first();
    if (!legacy) return;
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    if (Number(count && count.n) !== 1) return;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO records (user_id, revision, updated_at, saved_at, state)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(userId, legacy.revision, legacy.updated_at, legacy.saved_at, legacy.state)
      .run();
  } catch {
    /* no legacy table on a fresh database */
  }
}

async function handleSignup(request, env) {
  const { body, error, status } = await readBody(request);
  if (error) return json({ error }, status);

  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  const name = String(body.name || '').trim().slice(0, 60);

  const badEmail = emailProblem(email);
  if (badEmail) return json({ error: badEmail }, 400);
  const badPassword = passwordProblem(password);
  if (badPassword) return json({ error: badPassword }, 400);

  const gate = await hitLimit(env, `signup:${clientIp(request)}`, 8, 3600 * 1000);
  if (!gate.ok) return json({ error: 'Too many accounts from this connection. Try again in a little while.' }, 429);

  if (await findUserByEmail(env, email)) {
    return json({ error: 'An account with that email already exists. Sign in instead.' }, 409);
  }

  const user = await createUser(env, { email, name, password });
  await adoptLegacyRecord(env, user.id);
  const verify = await sendVerification(env, request, user);
  const token = await createSession(env, user.id, request.headers.get('user-agent'));
  return json({ user, verify }, 200, { 'Set-Cookie': sessionCookie(env, token, SESSION_SECONDS) });
}

/* A verification mail is best-effort: without a mail key the account still
   works, and the client says so instead of blocking sign-in. */
async function sendVerification(env, request, user) {
  if (!mailConfigured(env)) return 'unconfigured';
  const origin = appOrigin(request, env);
  const token = await issueToken(env, user.id, 'verify', 24 * 3600 * 1000);
  const link = `${origin}/api/auth/verify?token=${encodeURIComponent(token)}`;
  const result = await sendMail(env, { to: user.email, ...verifyMessage(origin, link) });
  return result.sent ? 'sent' : 'failed';
}

/* Email ownership: the link marks the address verified, then drops the hunter
   back on the sign-in screen with an explanation. */
async function handleVerifyEmail(request, env, url) {
  const userId = await consumeToken(env, url.searchParams.get('token'), 'verify');
  if (!userId) return redirect('/?auth=verify-failed');
  await markEmailVerified(env, userId);
  return redirect('/?auth=email-verified');
}

/* "Forgot password" always answers the same way, so the endpoint cannot be
   used to discover which addresses have accounts. */
async function handlePasswordRequest(request, env) {
  const { body, error, status } = await readBody(request);
  if (error) return json({ error }, status);
  const email = normalizeEmail(body.email);
  const gate = await hitLimit(env, `reset:${clientIp(request)}`, 6, 3600 * 1000);
  if (!gate.ok) return json({ error: 'Too many reset requests. Try again later.' }, 429);

  const row = email ? await findUserByEmail(env, email) : null;
  if (row && row.pass_hash) {
    if (mailConfigured(env)) {
      const origin = appOrigin(request, env);
      const token = await issueToken(env, row.id, 'reset', 30 * 60 * 1000);
      const link = `${origin}/?reset=${encodeURIComponent(token)}`;
      await sendMail(env, { to: row.email, ...resetMessage(origin, link) });
    }
  }
  return json({ ok: true, mail: mailConfigured(env) ? 'sent' : 'unconfigured' });
}

async function handlePasswordReset(request, env) {
  const { body, error, status } = await readBody(request);
  if (error) return json({ error }, status);
  const password = String(body.password || '');
  const bad = passwordProblem(password);
  if (bad) return json({ error: bad }, 400);

  const gate = await hitLimit(env, `reset-use:${clientIp(request)}`, 10, 3600 * 1000);
  if (!gate.ok) return json({ error: 'Too many attempts. Try again later.' }, 429);

  const userId = await consumeToken(env, body.token, 'reset');
  if (!userId) return json({ error: 'That reset link has expired. Ask for a new one.' }, 400);

  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  if (!row) return json({ error: 'That account no longer exists.' }, 400);

  await setPassword(env, userId, password);
  // Proving inbox access also proves the address, and every old session is
  // dropped: a stolen cookie must not survive a password reset.
  await markEmailVerified(env, userId);
  await destroyAllSessions(env, userId);
  const token = await createSession(env, userId, request.headers.get('user-agent'));
  const fresh = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  return json(
    { user: { id: fresh.id, email: fresh.email, name: fresh.name, avatar: fresh.avatar || null, hasPassword: true, google: !!fresh.google_sub, verified: true } },
    200,
    { 'Set-Cookie': sessionCookie(env, token, SESSION_SECONDS) }
  );
}

async function handleLogin(request, env) {
  const { body, error, status } = await readBody(request);
  if (error) return json({ error }, status);

  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  if (!email || !password) return json({ error: 'Enter your email and password.' }, 400);

  const attemptKey = `login:${clientIp(request)}:${email.slice(0, 80)}`;
  const gate = await hitLimit(env, attemptKey, 10, 15 * 60 * 1000);
  if (!gate.ok) {
    return json({ error: 'Too many attempts. Wait 15 minutes, or reset your password.' }, 429);
  }

  const row = await findUserByEmail(env, email);
  if (!row || !row.pass_hash) {
    return json({ error: 'No account matches that email and password.' }, 401);
  }
  if (!(await verifyPassword(password, row.pass_salt, row.pass_hash))) {
    return json({ error: 'No account matches that email and password.' }, 401);
  }

  // A good password clears the counter, so one typo does not linger.
  await clearLimit(env, attemptKey);
  const token = await createSession(env, row.id, request.headers.get('user-agent'));
  return json(
    { user: { id: row.id, email: row.email, name: row.name, avatar: row.avatar, hasPassword: true, google: !!row.google_sub } },
    200,
    { 'Set-Cookie': sessionCookie(env, token, 30 * 24 * 3600) }
  );
}

async function handleLogout(request, env) {
  await destroySession(request, env);
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(env, 'sys_session') });
}

async function handleGoogleStart(request, env, url) {
  if (!googleConfigured(env)) {
    return json({ error: 'Google sign-in is not configured on this deployment.' }, 503);
  }
  // ?link=1 attaches Google to the account already signed in here, instead of
  // signing in with it. The intent and the account id ride in the same
  // HttpOnly state cookie, so the callback cannot be pointed elsewhere.
  let linkUserId = '';
  if (url.searchParams.get('link') === '1') {
    const me = await currentUser(request, env);
    if (!me) return redirect('/?auth=signin-required');
    linkUserId = me.id;
  }
  const state = crypto.randomUUID();
  const cookie = linkUserId ? `${state}|link|${linkUserId}` : state;
  return redirect(googleAuthUrl(env, state, appOrigin(request, env)), { 'Set-Cookie': oauthCookie(env, cookie) });
}

async function handleGoogleCallback(request, env, url) {
  if (!googleConfigured(env)) return redirect('/?auth=google-unavailable');
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const cookie = readCookie(request, OAUTH_COOKIE);
  const [expectedState, intent, linkUserId] = String(cookie || '').split('|');
  if (!code || !state || !expectedState || state !== expectedState) {
    return redirect('/?auth=state-mismatch');
  }
  try {
    const profile = await googleProfile(env, code, appOrigin(request, env));

    // An unverified Google address proves nothing about who is asking.
    if (!profile.verified) return redirect('/?auth=google-unverified');

    if (intent === 'link') {
      const me = await currentUser(request, env);
      if (!me || me.id !== linkUserId) return redirect('/?auth=link-session');
      const owner = await findUserByEmail(env, profile.email);
      if (owner && owner.id !== me.id) return redirect('/?auth=google-in-use');
      await linkGoogle(env, me.id, profile.sub, profile.avatar);
      return redirect('/', { 'Set-Cookie': clearCookie(env, OAUTH_COOKIE) });
    }

    let row = await findUserByEmail(env, profile.email);
    if (!row) {
      const created = await createUser(env, {
        email: profile.email,
        name: profile.name,
        googleSub: profile.sub,
        avatar: profile.avatar
      });
      await adoptLegacyRecord(env, created.id);
      await markEmailVerified(env, created.id);
      row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(created.id).first();
    } else if (!row.google_sub) {
      // Never attach Google to a password account from a public flow: anyone
      // can pre-register someone else's address, and auto-linking would hand
      // them the victim's sessions. The owner links it from Settings instead.
      if (row.pass_hash) return redirect('/?auth=google-link-required');
      await linkGoogle(env, row.id, profile.sub, profile.avatar);
    }
    await markEmailVerified(env, row.id);
    const token = await createSession(env, row.id, request.headers.get('user-agent'));
    return redirect('/', {
      'Set-Cookie': [sessionCookie(env, token, 30 * 24 * 3600), clearCookie(env, OAUTH_COOKIE)]
    });
  } catch (err) {
    console.error('[system] google callback failed:', err);
    return redirect('/?auth=google-failed');
  }
}

/* ---------------- record ---------------- */

async function readRecord(db, userId) {
  const row = await db
    .prepare('SELECT revision, updated_at, saved_at, state FROM records WHERE user_id = ?')
    .bind(userId)
    .first();
  if (!row) return null;
  return {
    revision: row.revision,
    updatedAt: row.updated_at,
    savedAt: row.saved_at,
    state: JSON.parse(row.state)
  };
}

async function handleState(request, env, user) {
  if (request.method === 'GET') {
    const record = await readRecord(env.DB, user.id);
    return record ? json(record) : json({ error: 'no saved record yet' }, 404);
  }

  if (request.method !== 'PUT') return json({ error: 'method not allowed' }, 405);

  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) {
    return json({ error: 'body too large' }, 413);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  const nextState = payload && payload.state;
  if (!nextState || typeof nextState !== 'object' || Array.isArray(nextState)) {
    return json({ error: 'body must contain a state object' }, 400);
  }

  const updatedAt = Number(payload.updatedAt) || Date.now();
  const savedAt = new Date().toISOString();

  // The WHERE clause is the conflict guard: a stale copy changes nothing.
  const result = await env.DB.prepare(
    `INSERT INTO records (user_id, revision, updated_at, saved_at, state) VALUES (?, 1, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       revision = revision + 1,
       updated_at = excluded.updated_at,
       saved_at = excluded.saved_at,
       state = excluded.state
     WHERE excluded.updated_at >= records.updated_at`
  )
    .bind(user.id, updatedAt, savedAt, JSON.stringify(nextState))
    .run();

  if (!result.meta.changes) {
    const current = await readRecord(env.DB, user.id);
    return current ? json(current, 409) : json({ error: 'write rejected' }, 409);
  }

  const revision = (
    await env.DB.prepare('SELECT revision FROM records WHERE user_id = ?').bind(user.id).first()
  ).revision;
  return json({ ok: true, revision, updatedAt, savedAt });
}

/* ---------------- AI meal planner ---------------- */

async function handleAiSuggest(request, env, user) {
  const { body, error, status } = await readBody(request);
  if (error) return json({ error }, status);

  const pantry = (Array.isArray(body.pantry) ? body.pantry : [])
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim().slice(0, 40))
    .slice(0, 60);
  if (!pantry.length) {
    return json({ error: 'Add a few pantry ingredients first, then ask for a plan.' }, 400);
  }

  const ipGate = await hitLimit(env, `ai:${clientIp(request)}`, AI_IP_DAILY_LIMIT, 24 * 3600 * 1000);
  if (!ipGate.ok) return json({ error: 'The planner is busy from this connection. Try again later.' }, 429);

  if (!env.OPENAI_API_KEY) {
    return json(
      {
        error: 'ai not configured',
        hint: 'Add an OPENAI_API_KEY secret in Sites → Secrets (any OpenAI-compatible key), then ask again.'
      },
      503
    );
  }

  const day = new Date().toISOString().slice(0, 10);
  const used = await env.DB.prepare('SELECT count FROM ai_usage WHERE user_id = ? AND day = ?')
    .bind(user.id, day)
    .first();
  if (Number(used && used.count) >= AI_DAILY_LIMIT) {
    return json({ error: `Daily AI limit reached (${AI_DAILY_LIMIT} plans). Try again tomorrow.` }, 429);
  }

  const goals = body.goals || {};
  const eaten = body.eaten || {};
  const remainingKcal = Math.max(0, (Number(goals.kcal) || 2200) - (Number(eaten.kcal) || 0));
  const remainingProtein = Math.max(0, (Number(goals.protein) || 140) - (Number(eaten.protein) || 0));
  const diet = String(body.diet || 'balanced').slice(0, 40);
  const notes = String(body.notes || '').slice(0, 300);
  const mealSlot = String(body.meal || 'lunch').slice(0, 20);

  const system = [
    'You are a sports nutrition coach inside a fitness app used in Kerala, India.',
    'Build meals from the ingredients the user actually has, plus water, salt and common spices.',
    'Respect the remaining calorie and protein budget and the diet preference.',
    'Reply with JSON only, no prose, shaped exactly like:',
    '{"meals":[{"name":"...","kcal":420,"protein":28,"carbs":45,"ingredients":["..."],"steps":["short step"],"why":"one sentence"}]}',
    'Return 3 meals. kcal and protein are integers for one serving. Keep steps to 3 short entries.'
  ].join(' ');

  const prompt = [
    `Pantry: ${pantry.join(', ')}.`,
    `Remaining today: ${remainingKcal} kcal, ${remainingProtein} g protein.`,
    `Diet preference: ${diet}. Meal slot: ${mealSlot}.`,
    notes ? `Extra notes: ${notes}.` : ''
  ]
    .filter(Boolean)
    .join(' ');

  const result = await requestAi(env, {
    temperature: 0.5,
    max_tokens: 900,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt }
    ]
  });
  if (!result.ok) {
    return json(
      {
        error: 'AI request failed for every configured endpoint.',
        hint: aiFailureHint(result),
        detail: result.detail
      },
      502
    );
  }
  const payload = result.payload;

  await env.DB.prepare(
    `INSERT INTO ai_usage (user_id, day, count) VALUES (?, ?, 1)
     ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1`
  )
    .bind(user.id, day)
    .run();

  const content = (((payload || {}).choices || [])[0] || {}).message || {};
  let parsed = null;
  try {
    parsed = JSON.parse(content.content || '');
  } catch {
    const text = String(content.content || '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        parsed = null;
      }
    }
  }
  const meals = cleanMeals((parsed && parsed.meals) || (Array.isArray(parsed) ? parsed : []));
  if (!meals.length) return json({ error: 'The AI reply had no usable meals. Try again.' }, 502);

  return json({
    meals,
    model: result.model || 'gpt-4o-mini',
    remaining: { kcal: remainingKcal, protein: remainingProtein },
    usedToday: Number(used && used.count) + 1,
    limit: AI_DAILY_LIMIT
  });
}

/* ---------------- streak check-in ----------------
   The most valuable notification in a streak app is not the water nudge: it
   is the one that says tonight's quest is the only thing standing between a
   run of days and zero. */

function localParts(offsetMin, now) {
  const local = new Date(now + offsetMin * 60000);
  return { key: local.toISOString().slice(0, 10), hour: local.getUTCHours(), dow: local.getUTCDay() };
}

function streakIn(saved, offsetMin, now) {
  const logs = (saved && saved.logs) || {};
  const schedule = (saved && saved.schedule) || {};
  let count = 0;
  for (let i = 0; i < 120; i++) {
    const local = new Date(now + offsetMin * 60000 - i * 86400000);
    const key = local.toISOString().slice(0, 10);
    const log = logs[key];
    if (log && log.status === 'completed') { count++; continue; }
    if (i === 0) continue; // today never breaks the streak
    if (!schedule[local.getUTCDay()]) continue; // rest day, neutral
    break;
  }
  return count;
}

/* One nudge per evening, only when a workout was scheduled and is still open.
   The record is read right here so the message can name the real streak. */
async function streakPass(env, now) {
  const rows = await env.DB.prepare(
    `SELECT p.user_id, p.tz_offset, p.reminder_hour, p.last_streak_at, r.state
       FROM push_prefs p
       JOIN records r ON r.user_id = p.user_id
      WHERE p.enabled = 1`
  ).all();

  for (const row of rows.results || []) {
    try {
      const offset = Number(row.tz_offset || 0);
      const { key, hour, dow } = localParts(offset, now);
      const target = row.reminder_hour == null ? 20 : Number(row.reminder_hour);
      if (hour < target || hour >= 23) continue;
      // 20 hours apart, so a 15-minute cron cannot spam one evening.
      if (now - Number(row.last_streak_at || 0) < 20 * 3600 * 1000) continue;

      let saved = {};
      try { saved = JSON.parse(row.state || '{}'); } catch { saved = {}; }
      const log = ((saved && saved.logs) || {})[key];
      if (log && log.status === 'completed') continue;
      if (!((saved && saved.schedule) || {})[dow]) continue;

      const streak = streakIn(saved, offset, now);
      const result = await pushUser(env, row.user_id, {
        title: 'STREAK AT RISK',
        body: streak > 0
          ? `${streak}-day streak ends tonight unless today's quest is cleared.`
          : "Today's quest is still open. Clear it before the day resets.",
        tag: 'system-streak',
        url: '/'
      });
      if (result.sent > 0) {
        await env.DB.prepare('UPDATE push_prefs SET last_streak_at = ? WHERE user_id = ?')
          .bind(now, row.user_id)
          .run();
      }
    } catch (err) {
      console.error('[system] streak check-in failed:', err);
    }
  }
}

/* ---------------- account removal ---------------- */

async function handleDeleteAccount(request, env, user) {
  const { body, error, status } = await readBody(request);
  if (error) return json({ error }, status);
  if (String((body && body.confirm) || '').toUpperCase() !== 'DELETE') {
    return json({ error: 'Type DELETE to confirm.' }, 400);
  }
  const db = env.DB;
  await db.prepare('DELETE FROM push_subs WHERE user_id = ?').bind(user.id).run();
  await db.prepare('DELETE FROM push_prefs WHERE user_id = ?').bind(user.id).run();
  await db.prepare('DELETE FROM ai_usage WHERE user_id = ?').bind(user.id).run();
  await db.prepare('DELETE FROM records WHERE user_id = ?').bind(user.id).run();
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();
  await db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').bind(user.id).run();
  await db.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(env, 'sys_session') });
}

/* ---------------- push ---------------- */

async function handlePush(request, env, user, pathname) {
  if (pathname === '/api/push/config' && request.method === 'GET') {
    return json({
      configured: pushConfigured(env),
      publicKey: env.VAPID_PUBLIC_KEY || null
    });
  }

  if (pathname === '/api/push/subscribe' && request.method === 'POST') {
    const { body, error, status } = await readBody(request);
    if (error) return json({ error }, status);
    const sub = body && body.subscription ? body.subscription : body;
    const endpoint = String((sub && sub.endpoint) || '');
    const keys = (sub && sub.keys) || {};
    if (!/^https?:\/\//.test(endpoint) || !keys.p256dh || !keys.auth) {
      return json({ error: 'That push subscription is incomplete.' }, 400);
    }
    await env.DB.prepare(
      `INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`
    )
      .bind(endpoint, user.id, String(keys.p256dh), String(keys.auth), new Date().toISOString())
      .run();
    return json({ ok: true });
  }

  if (pathname === '/api/push/unsubscribe' && request.method === 'POST') {
    const { body } = await readBody(request);
    const endpoint = String((body && body.endpoint) || '');
    if (endpoint) {
      await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?')
        .bind(endpoint, user.id)
        .run();
    }
    return json({ ok: true });
  }

  if (pathname === '/api/push/test' && request.method === 'POST') {
    if (!pushConfigured(env)) return json({ error: 'Push is not configured on this deployment.' }, 503);
    const result = await pushUser(env, user.id, {
      title: 'SYSTEM ONLINE',
      body: 'Device notifications are working. Reminders will arrive here.',
      tag: 'system-test',
      url: '/'
    });
    return json({ ok: result.sent > 0, ...result });
  }

  if (pathname === '/api/push/tick' && request.method === 'POST') {
    const { body } = await readBody(request);
    const hour = Number(body && body.hour);
    const tzOffset = Number(body && body.tzOffset) || 0;
    const drank = Number(body && body.drank) || 0;
    const goal = Number(body && body.goal) || 2500;

    const prefs = await env.DB.prepare('SELECT * FROM push_prefs WHERE user_id = ?').bind(user.id).first();
    if (!prefs || !Number(prefs.enabled)) return json({ sent: false, reason: 'reminders off' });
    if (!pushConfigured(env)) return json({ sent: false, reason: 'push not configured' });

    const localHour = Number.isFinite(hour) ? hour : new Date(Date.now() + tzOffset * 60000).getUTCHours();
    if (localHour < 8 || localHour >= 22) return json({ sent: false, reason: 'quiet hours' });

    const everyMs = Math.max(15, Number(prefs.every_min) || 90) * 60000;
    if (Date.now() - Number(prefs.last_sent_at || 0) < everyMs) {
      return json({ sent: false, reason: 'not due yet' });
    }

    const left = Math.max(0, goal - drank);
    const result = await pushUser(env, user.id, {
      title: 'HYDRATION QUEST',
      body: left > 0 ? `${left} ml left today. Drink 250 ml now.` : 'Hydration goal met — keep sipping.',
      tag: 'system-water',
      url: '/'
    });
    await env.DB.prepare('UPDATE push_prefs SET last_sent_at = ? WHERE user_id = ?')
      .bind(Date.now(), user.id)
      .run();
    return json({ sent: result.sent > 0, ...result });
  }

  if (pathname === '/api/push/prefs' && request.method === 'POST') {
    const { body } = await readBody(request);
    const enabled = body && body.enabled ? 1 : 0;
    const everyMin = Math.min(360, Math.max(15, Number(body && body.everyMin) || 90));
    const reminderHour = Math.min(23, Math.max(0, Number(body && body.hour == null ? 20 : body.hour)));
    const tzOffset = -new Date().getTimezoneOffset();
    await env.DB.prepare(
      `INSERT INTO push_prefs (user_id, enabled, every_min, tz_offset, reminder_hour, last_sent_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, every_min = excluded.every_min, tz_offset = excluded.tz_offset, reminder_hour = excluded.reminder_hour`
    )
      .bind(user.id, enabled, everyMin, tzOffset, reminderHour, Date.now())
      .run();
    return json({ ok: true, enabled: !!enabled, everyMin, reminderHour });
  }

  return json({ error: 'unknown endpoint' }, 404);
}

/* ---------------- android app links ---------------- */

function assetLinks(env) {
  const prints = String(env.TWA_FINGERPRINT || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!prints.length) return new Response('no fingerprint configured', { status: 404 });

  return new Response(
    JSON.stringify([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: env.TWA_PACKAGE_ID || 'site.freebuff.thesystem',
          sha256_cert_fingerprints: prints
        }
      }
    ]),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } }
  );
}

/* ---------------- router ---------------- */

async function handle(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname === '/.well-known/assetlinks.json') return assetLinks(env);
  if (pathname === '/api/health') return publicJson({ ok: true });

  // Signed out is a normal answer here, not an error: the client asks on boot.
  if (pathname === '/api/auth/session') {
    await ensureSchema(env.DB);
    return json({ user: await currentUser(request, env) });
  }

  if (pathname === '/api/auth/google/start') return handleGoogleStart(request, env, url);
  if (pathname === '/api/auth/google/callback') return handleGoogleCallback(request, env, url);

  if (pathname === '/api/auth/verify') return handleVerifyEmail(request, env, url);
  if (pathname === '/api/version') {
    return publicJson({ app: 'system-fitness', commit: COMMIT, builtAt: BUILT_AT });
  }

  if (pathname === '/api/auth/config') return publicJson({
    google: googleConfigured(env),
    email: true,
    mail: mailConfigured(env),
    push: pushConfigured(env)
  });

  const authActions = {
    '/api/auth/signup': handleSignup,
    '/api/auth/login': handleLogin,
    '/api/auth/logout': handleLogout,
    '/api/auth/password/request': handlePasswordRequest,
    '/api/auth/password/reset': handlePasswordReset
  };
  if (authActions[pathname]) {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    if (!sameOrigin(request, env)) return json({ error: 'cross-origin request blocked' }, 403);
    return authActions[pathname](request, env);
  }

  if (pathname.startsWith('/api/')) {
    await ensureSchema(env.DB);
    const user = await currentUser(request, env);
    if (!user) return json({ error: 'sign in required' }, 401);

    if (request.method !== 'GET' && !sameOrigin(request, env)) {
      return json({ error: 'cross-origin request blocked' }, 403);
    }

    if (pathname === '/api/state') return handleState(request, env, user);
    if (pathname === '/api/auth/verify/request') {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      const row = await env.DB.prepare('SELECT email_verified FROM users WHERE id = ?').bind(user.id).first();
      if (row && Number(row.email_verified) === 1) return json({ ok: true, already: true });
      const gate = await hitLimit(env, `verify:${user.id}`, 5, 3600 * 1000);
      if (!gate.ok) return json({ error: 'Too many confirmations requested. Try again later.' }, 429);
      const state = await sendVerification(env, request, user);
      if (state === 'unconfigured') return json({ error: 'Email is not configured on this deployment.' }, 503);
      return json({ ok: state === 'sent', state });
    }
    if (pathname === '/api/auth/sessions') {
      const rows = await listSessions(env, user.id);
      const currentId = await sessionIdFrom(request);
      return json({
        sessions: rows.map((row) => ({
          created: row.created_at,
          userAgent: row.user_agent || '',
          current: row.id === currentId
        }))
      });
    }
    if (pathname === '/api/auth/sessions/revoke-all') {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      await destroyOtherSessions(env, user.id, await sessionIdFrom(request));
      return json({ ok: true });
    }
    if (pathname === '/api/account/delete') {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      return handleDeleteAccount(request, env, user);
    }
    if (pathname === '/api/ai/suggest') {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      return handleAiSuggest(request, env, user);
    }
    if (pathname === '/api/push/config') return handlePush(request, env, user, pathname);
    if (pathname.startsWith('/api/push/')) {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      return handlePush(request, env, user, pathname);
    }
    return json({ error: 'unknown endpoint' }, 404);
  }

  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    try {
      await ensureSchema(env.DB);
      return await handle(request, env);
    } catch (err) {
      console.error('[system] request failed:', err);
      return json({ error: 'internal error' }, 500);
    }
  },

  /* Cron (wrangler.jsonc) sends water reminders while the app is closed.
     The client also calls /api/push/tick on open, so reminders still work on
     hosts that do not run the scheduled trigger. */
  async scheduled(event, env) {
    try {
      await ensureSchema(env.DB);
      if (!pushConfigured(env)) return;
      const now = Date.now();
      // Expired sessions and one-shot tokens are dead weight; the cron is the
      // only place that can see every account at once.
      await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
      await env.DB.prepare('DELETE FROM auth_tokens WHERE expires_at < ?').bind(now).run();
      await env.DB.prepare('DELETE FROM throttle WHERE reset_at < ?').bind(now - 86400000).run();
      const rows = await env.DB.prepare('SELECT * FROM push_prefs WHERE enabled = 1').all();
      for (const prefs of rows.results || []) {
        const everyMs = Math.max(15, Number(prefs.every_min) || 90) * 60000;
        if (now - Number(prefs.last_sent_at || 0) < everyMs) continue;
        const localHour = new Date(now + Number(prefs.tz_offset || 0) * 60000).getUTCHours();
        if (localHour < 8 || localHour >= 22) continue;
        await pushUser(env, prefs.user_id, {
          title: 'HYDRATION QUEST',
          body: 'Time to drink 250 ml. The System is watching your streak.',
          tag: 'system-water',
          url: '/'
        });
        await env.DB.prepare('UPDATE push_prefs SET last_sent_at = ? WHERE user_id = ?')
          .bind(now, prefs.user_id)
          .run();
      }
      await streakPass(env, now);
    } catch (err) {
      console.error('[system] scheduled reminder failed:', err);
    }
  }
};
